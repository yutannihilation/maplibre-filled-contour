import {decodeTile} from '@maplibre/mlt';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DemSource} from '../src/index.js';
import {processTileWithMetadata, type ProcessTileInput} from '../src/process-tile.js';

afterEach(() => vi.unstubAllGlobals());

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return {promise, resolve};
}

function properties(bytes: Uint8Array) {
    return decodeTile(bytes).flatMap((table) => table.getFeatures().map((feature) => feature.properties));
}

// Exercise the same message/transfer boundary as a browser worker, without network or DOM.
class ProcessingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    constructor() {
        queueMicrotask(() => this.onmessage?.({data: {ready: true}} as MessageEvent));
    }

    postMessage(message: {id: number; input: ProcessTileInput}, transfer: Transferable[]): void {
        const request = structuredClone(message, {transfer});
        queueMicrotask(() => {
            const result = processTileWithMetadata(request.input);
            this.onmessage?.({data: {
                id: request.id,
                data: result.data.buffer,
                thresholds: result.thresholds
            }} as MessageEvent);
        });
    }

    terminate(): void {}
}

describe.each(['main thread', 'worker'] as const)('dynamic initialization on the %s', (mode) => {
    function setupWorker() {
        vi.stubGlobal('Worker', mode === 'worker' ? ProcessingWorker : undefined);
    }

    it('keeps the first requested area even when another area is already cached', async () => {
        setupWorker();
        const gate = deferred();
        const source = new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: 4,
            getTile: async (url) => {
                const x = Number(new URL(url).pathname.split('/')[2]);
                if (x < 3) await gate.promise;
                return {data: new Blob([String(x < 3 ? 100 : 1000)])};
            },
            decodeImage: async (blob) => ({
                width: 4, height: 4, data: new Float32Array(16).fill(Number(await blob.text()))
            })
        });

        try {
            await Promise.all([4, 5, 6].flatMap((x) => [4, 5, 6].map((y) => source.getDemTile(3, x, y))));
            const first = source.getFilledContourTile(3, 1, 1);
            const second = source.getFilledContourTile(3, 5, 5);
            // Let the cached request run while the first request's network fetch remains blocked.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const resolvedBeforeRelease = source.thresholdsResolved;
            gate.resolve();
            const [firstBytes, secondBytes] = await Promise.all([first, second]);

            expect(resolvedBeforeRelease).toBe(false);
            expect(source.thresholds).toEqual([100, 101, 102, 103]);
            expect(properties(firstBytes)).toEqual([{band: 0, min: 100, max: 101}]);
            expect(properties(secondBytes)).toEqual([{band: 3, min: 103}]);
        } finally {
            gate.resolve();
            source.destroy();
        }
    });

    it('includes interior extrema from every neighboring tile and preserves cached DEMs', async () => {
        setupWorker();
        const source = new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: 4,
            getTile: async (url) => ({data: new Blob([new URL(url).pathname])}),
            decodeImage: async (blob) => {
                const path = await blob.text();
                const data = new Float32Array(256).fill(100);
                if (path === '/3/2/1.png') data[8 * 16 + 8] = 1000; // East tile, outside grid padding.
                if (path === '/3/0/0.png') data[8 * 16 + 8] = -100; // Northwest tile interior.
                // Invalid DEM samples must not alter the domain.
                data[0] = Number.NaN;
                data[1] = Infinity;
                data[2] = -32768;
                data[3] = 10000;
                return {width: 16, height: 16, data};
            }
        });

        try {
            const original = await source.getDemTile(3, 2, 1);
            await source.getFilledContourTile(3, 1, 1);
            expect(source.thresholds).toEqual([-100, 175, 450, 725]);
            expect((await source.getDemTile(3, 2, 1)).data).toBe(original.data);
            expect(original.data).toHaveLength(256);
            expect(original.data[8 * 16 + 8]).toBe(1000);
        } finally {
            source.destroy();
        }
    });
});

it.each(['failure', 'cancellation'] as const)('releases the initial reservation after %s', async (reason) => {
    vi.stubGlobal('Worker', undefined);
    const gate = deferred();
    const started = deferred();
    const controller = new AbortController();
    const source = new DemSource({
        url: 'https://example.test/{z}/{x}/{y}.png',
        thresholds: 4,
        getTile: async (url) => {
            const x = Number(new URL(url).pathname.split('/')[2]);
            if (x < 3) {
                started.resolve();
                await gate.promise;
                if (reason === 'failure') throw new Error('DEM unavailable');
            }
            return {data: new Blob(['dem'])};
        },
        decodeImage: async () => ({width: 4, height: 4, data: new Float32Array(16).fill(500)})
    });

    try {
        const first = source.getFilledContourTile(3, 1, 1, controller);
        const rejected = expect(first).rejects.toThrow(reason === 'failure' ? /DEM unavailable/ : /aborted/i);
        const second = source.getFilledContourTile(3, 5, 5);
        await started.promise;
        if (reason === 'cancellation') controller.abort();
        gate.resolve();
        await rejected;
        expect(properties(await second)).toEqual([{band: 0, min: 500, max: 501}]);
        expect(source.thresholds).toEqual([500, 501, 502, 503]);
    } finally {
        gate.resolve();
        source.destroy();
    }
});
