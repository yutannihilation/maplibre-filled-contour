import {decodeTile, GEOMETRY_TYPE} from '@maplibre/mlt';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    createIsobandBands,
    createIsobandStyle,
    decodeParsedImage,
    DemSource,
    deriveThresholds,
    generateIsobands,
    type DecodeImageFunction,
    type GetTileFunction
} from '../src/index.js';

function gradient(width: number, height: number): Float32Array {
    return Float32Array.from({length: width * height}, (_, index) =>
        (index % width) * 100);
}

afterEach(() => vi.unstubAllGlobals());

describe('generateIsobands', () => {
    it('creates finite adjacent bands and an unbounded upper band, but no lower band', () => {
        const bands = generateIsobands(
            gradient(7, 7), 7, 7, 4, 4, 1,
            {thresholds: [100, 200, 300], extent: 4096, buffer: 0}
        );

        expect(bands.map((band) => band.properties)).toEqual([
            {band: 0, min: 100, max: 200},
            {band: 1, min: 200, max: 300},
            {band: 2, min: 300}
        ]);
        expect(bands.every((band) => band.geometry.length > 0)).toBe(true);
    });

    it('does not emit lower bands when the complete tile is above the top threshold', () => {
        const values = new Float32Array(25).fill(400);
        const bands = generateIsobands(values, 5, 5, 2, 2, 1, {
            thresholds: [100, 200, 300]
        });

        expect(bands).toHaveLength(1);
        expect(bands[0]?.properties).toEqual({band: 2, min: 300});
    });

    it('can include the lower band and exclude the upper band', () => {
        const bands = generateIsobands(
            gradient(7, 7), 7, 7, 4, 4, 1,
            {thresholds: [200, 300, 400], includeLower: true, includeUpper: false, extent: 4096, buffer: 0}
        );

        expect(bands.map((band) => band.properties)).toEqual([
            {band: 0, max: 200},
            {band: 1, min: 200, max: 300},
            {band: 2, min: 300, max: 400}
        ]);
        expect(bands.every((band) => band.geometry.length > 0)).toBe(true);
    });

    it('emits only the lower band when all values are below the first threshold', () => {
        const bands = generateIsobands(new Float32Array(25).fill(50), 5, 5, 2, 2, 1, {
            thresholds: [100],
            includeLower: true,
            includeUpper: false
        });

        expect(bands).toHaveLength(1);
        expect(bands[0]?.properties).toEqual({band: 0, max: 100});
    });

    it('excludes invalid samples from the lower band', () => {
        const values = new Float32Array(49).fill(50);
        values[3 * 7 + 3] = Number.NaN;
        const bands = generateIsobands(values, 7, 7, 4, 4, 1, {
            thresholds: [100],
            includeLower: true,
            includeUpper: false,
            buffer: 0
        });

        expect(bands).toHaveLength(1);
        expect(bands[0]?.properties).toEqual({band: 0, max: 100});
        expect(bands[0]?.geometry.some((polygon) => polygon.length > 1)).toBe(true);
    });
});

describe('generated styles and legends', () => {
    it('creates one colored model entry for every emitted band', () => {
        expect(createIsobandBands(
            [100, 200, 300], true, false, ['red', 'green', 'blue']
        )).toEqual([
            {band: 0, max: 100, color: 'red'},
            {band: 1, min: 100, max: 200, color: 'green'},
            {band: 2, min: 200, max: 300, color: 'blue'}
        ]);
    });

    it('generates a fill expression keyed by band and samples color interpolators', () => {
        const color = vi.fn((_position: number, band: number) => `color-${band}`);
        const style = createIsobandStyle([100, 200, 300], false, true, {colors: color});

        expect(style.fillColor).toEqual([
            'match', ['get', 'band'],
            0, 'color-0',
            1, 'color-1',
            2, 'color-2',
            'rgba(0, 0, 0, 0)'
        ]);
        expect(color).toHaveBeenNthCalledWith(1, 0, 0, 3);
        expect(color).toHaveBeenNthCalledWith(2, 0.5, 1, 3);
        expect(color).toHaveBeenNthCalledWith(3, 1, 2, 3);
    });

    it('rejects palettes whose size differs from the emitted band count', () => {
        expect(() => createIsobandBands([100, 200], false, true, ['red']))
            .toThrow(/exactly 2 entries/);
    });

    it('generates a count-independent sequential palette when colors are omitted', () => {
        expect(createIsobandBands([100, 200, 300]).map((band) => band.color)).toEqual([
            'hsl(210, 30%, 92%)',
            'hsl(210, 60%, 68%)',
            'hsl(210, 90%, 44%)'
        ]);
    });

    it('creates formatted, accessible legend content without depending on MapLibre internals', () => {
        class FakeElement {
            className = '';
            textContent = '';
            readonly children: FakeElement[] = [];
            readonly attributes = new Map<string, string>();
            readonly style: Record<string, string> = {};
            removed = false;
            append(...children: FakeElement[]): void { this.children.push(...children); }
            replaceChildren(...children: FakeElement[]): void {
                this.children.splice(0, this.children.length, ...children);
            }
            setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
            remove(): void { this.removed = true; }
        }
        vi.stubGlobal('document', {createElement: () => new FakeElement()});

        const source = new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100, 200],
            colors: ['red', 'green', 'blue'],
            includeLower: true
        });
        const legend = source.getLegendControl({
            title: 'Height',
            unit: 'm',
            position: 'top-right'
        });
        const element = legend.onAdd({} as never) as unknown as FakeElement;

        expect(legend.getDefaultPosition()).toBe('top-right');
        expect(element.attributes.get('aria-label')).toBe('Height');
        expect(element.style.minWidth).toContain('--maplibre-filled-contour-legend-min-width');
        expect(element.style.width).toContain('--maplibre-filled-contour-legend-width');
        expect(element.children[0]?.textContent).toBe('Height');
        const items = element.children[1]?.children ?? [];
        expect(items.map((item) => item.children[1]?.textContent)).toEqual([
            '< 100 m', '100–200 m', '≥ 200 m'
        ]);
        expect(items.every((item) => item.children[1]?.style.whiteSpace?.includes('nowrap') === true)).toBe(true);
        legend.onRemove({} as never);
        expect(element.removed).toBe(true);
    });
});

describe('DEM decoding', () => {
    it('decodes Terrarium and Mapbox Terrain-RGB pixels', () => {
        const rgba = new Uint8ClampedArray([128, 1, 128, 255]);
        expect(decodeParsedImage(1, 1, 'terrarium', rgba).data[0]).toBe(1.5);

        const mapbox = decodeParsedImage(
            1, 1, 'mapbox', new Uint8ClampedArray([1, 134, 160, 255])
        );
        expect(mapbox.data[0]).toBeCloseTo(0, 5);
    });
});

describe('dynamic thresholds', () => {
    it('derives exact equal-interval boundaries while ignoring invalid samples', () => {
        expect(deriveThresholds(Float32Array.from([Number.NaN, -100, 0, 100, 300]), 4))
            .toEqual([-100, 0, 100, 200]);
        expect(deriveThresholds(new Float32Array(4).fill(250), 3))
            .toEqual([250, 251, 252]);
        expect(() => deriveThresholds(Float32Array.from([Number.NaN]), 3))
            .toThrow(/finite DEM sample/);
    });
});

describe('DemSource', () => {
    const blob = new Blob(['dem']);
    const getTile: GetTileFunction = vi.fn(async () => ({data: blob}));
    const decodeImage: DecodeImageFunction = vi.fn(async () => ({
        width: 4,
        height: 4,
        data: new Float32Array(16).fill(350)
    }));

    it('registers protocols and exposes an MLT source specification', async () => {
        const handlers = new Map<string, Function>();
        const maplibre = {
            addProtocol: vi.fn((id: string, handler: Function) => handlers.set(id, handler)),
            removeProtocol: vi.fn()
        };
        const source = new DemSource({
            id: 'terrain',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100, 200, 300],
            colors: ['red', 'green', 'blue'],
            maxzoom: 1,
            getTile,
            decodeImage
        }).setupMaplibre(maplibre as never);

        expect(source.includeLower).toBe(false);
        expect(source.includeUpper).toBe(true);

        expect(source.getSourceSpecification()).toEqual({
            type: 'vector',
            tiles: ['terrain-isobands://{z}/{x}/{y}.mlt'],
            minzoom: 0,
            maxzoom: 1,
            encoding: 'mlt'
        });
        expect(handlers.has('terrain-shared')).toBe(true);
        expect(handlers.has('terrain-isobands')).toBe(true);

        vi.mocked(getTile).mockClear();
        vi.mocked(decodeImage).mockClear();
        const bytes = await source.getFilledContourTile(0, 0, 0);
        expect(await source.getFilledContourTile(0, 0, 0)).toBe(bytes);
        expect(getTile).toHaveBeenCalledTimes(1);
        expect(decodeImage).toHaveBeenCalledTimes(1);
        const table = decodeTile(bytes).find((candidate) => candidate.name === 'isobands');
        const features = table?.getFeatures() ?? [];
        expect(features.length).toBeGreaterThan(0);
        expect(features.every((feature) => feature.geometry.type === GEOMETRY_TYPE.POLYGON)).toBe(true);
        expect(features.every((feature) => feature.properties.min === 300)).toBe(true);
        expect(features.every((feature) => feature.properties.max === undefined)).toBe(true);

        source.destroy();
        expect(maplibre.removeProtocol).toHaveBeenCalledTimes(2);
    });

    it('derives thresholds once from the first requested DEM neighborhood', async () => {
        class FakeElement {
            className = '';
            textContent = '';
            readonly children: FakeElement[] = [];
            readonly attributes = new Map<string, string>();
            readonly style: Record<string, string> = {};
            append(...children: FakeElement[]): void { this.children.push(...children); }
            replaceChildren(...children: FakeElement[]): void {
                this.children.splice(0, this.children.length, ...children);
            }
            setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
            remove(): void {}
        }
        vi.stubGlobal('document', {createElement: () => new FakeElement()});

        const source = new DemSource({
            id: 'dynamic-terrain',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: 4,
            colors: ['red', 'orange', 'yellow', 'green'],
            getTile,
            decodeImage: async () => ({
                width: 4,
                height: 4,
                data: Float32Array.from({length: 16}, (_, index) => (index % 4) * 100)
            })
        });

        expect(source.thresholdsResolved).toBe(false);
        expect(source.thresholds).toEqual([]);
        expect(source.getBands()).toEqual([
            {band: 0, color: 'red'},
            {band: 1, color: 'orange'},
            {band: 2, color: 'yellow'},
            {band: 3, color: 'green'}
        ]);
        const legend = source.getLegendControl({unit: 'm'});
        const legendElement = legend.onAdd({} as never) as unknown as FakeElement;
        expect(legendElement.children[1]?.children[0]?.textContent).toBe('Determining thresholds…');

        const bytes = await source.getFilledContourTile(0, 0, 0);
        expect(bytes.byteLength).toBeGreaterThan(0);
        expect(source.thresholdsResolved).toBe(true);
        expect(source.thresholds).toEqual([0, 75, 150, 225]);
        expect(source.getBands()).toEqual([
            {band: 0, min: 0, max: 75, color: 'red'},
            {band: 1, min: 75, max: 150, color: 'orange'},
            {band: 2, min: 150, max: 225, color: 'yellow'},
            {band: 3, min: 225, color: 'green'}
        ]);
        expect(legendElement.children[1]?.children.map((item) => item.children[1]?.textContent)).toEqual([
            '0–75 m', '75–150 m', '150–225 m', '≥ 225 m'
        ]);
        source.destroy();
    });

    it('adds and removes a synchronized source, layer, and legend', () => {
        const sources = new Map<string, unknown>();
        const layers = new Map<string, {paint?: Record<string, unknown>}>();
        const map = {
            addSource: vi.fn((id: string, specification: unknown) => sources.set(id, specification)),
            addLayer: vi.fn((specification: {id: string; paint?: Record<string, unknown>}) => {
                layers.set(specification.id, specification);
            }),
            addControl: vi.fn(),
            removeControl: vi.fn(),
            getLayer: vi.fn((id: string) => layers.get(id)),
            removeLayer: vi.fn((id: string) => layers.delete(id)),
            getSource: vi.fn((id: string) => sources.get(id)),
            removeSource: vi.fn((id: string) => sources.delete(id))
        };
        const source = new DemSource({
            id: 'add-to-map',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100, 200, 300],
            colors: ['red', 'green', 'blue']
        });

        const added = source.addTo(map as never, {
            sourceId: 'elevation',
            id: 'elevation-fill',
            paint: {'fill-opacity': 0.5},
            legend: {title: 'Height', unit: 'm'}
        });

        expect(layers.get('elevation-fill')?.paint).toEqual({
            'fill-opacity': 0.5,
            'fill-color': [
                'match', ['get', 'band'],
                0, 'red', 1, 'green', 2, 'blue',
                'rgba(0, 0, 0, 0)'
            ]
        });
        expect(map.addControl).toHaveBeenCalledWith(added.legend);

        added.remove();
        added.remove();
        expect(map.removeControl).toHaveBeenCalledTimes(1);
        expect(map.removeLayer).toHaveBeenCalledWith('elevation-fill');
        expect(map.removeSource).toHaveBeenCalledWith('elevation');
        source.destroy();
    });

    it('passes includeLower and includeUpper through tile generation and MLT encoding', async () => {
        const source = new DemSource({
            id: 'bounded-terrain',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100],
            colors: ['red'],
            includeLower: true,
            includeUpper: false,
            getTile,
            decodeImage: async () => ({
                width: 4,
                height: 4,
                data: new Float32Array(16).fill(50)
            })
        });

        expect(source.includeLower).toBe(true);
        expect(source.includeUpper).toBe(false);
        const table = decodeTile(await source.getFilledContourTile(0, 0, 0))
            .find((candidate) => candidate.name === 'isobands');
        const features = table?.getFeatures() ?? [];
        expect(features.length).toBeGreaterThan(0);
        expect(features.every((feature) => feature.properties.band === 0)).toBe(true);
        expect(features.every((feature) => feature.properties.min === undefined)).toBe(true);
        expect(features.every((feature) => feature.properties.max === 100)).toBe(true);
    });

    it('validates thresholds and times out fetches', async () => {
        expect(() => new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100, 100],
            colors: ['red', 'green']
        })).toThrow(/strictly increasing/);
        expect(() => new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100, 200],
            colors: ['red']
        })).toThrow(/exactly 2 entries/);
        const defaultColors = new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100, 200, 300, 400]
        });
        expect(defaultColors.colors).toHaveLength(4);

        const never: GetTileFunction = (_url, controller) => new Promise((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        });
        const source = new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100],
            colors: ['red'],
            timeoutMs: 5,
            getTile: never,
            decodeImage
        });
        await expect(source.getDemTile(0, 0, 0)).rejects.toThrow(/timed out|aborted/);
    });

    it('automatically uses a worker after it reports that it is ready', async () => {
        let ready = false;
        let postedBeforeReady = false;
        let constructions = 0;
        class ReadyWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            constructor() {
                constructions++;
                queueMicrotask(() => {
                    ready = true;
                    this.onmessage?.({data: {ready: true}} as MessageEvent);
                });
            }

            postMessage(message: {id: number}): void {
                if (!ready) postedBeforeReady = true;
                const data = Uint8Array.from([1, 2, 3]).buffer;
                queueMicrotask(() => this.onmessage?.({
                    data: {id: message.id, data, thresholds: [125]}
                } as MessageEvent));
            }

            terminate(): void {}
        }
        vi.stubGlobal('Worker', ReadyWorker);

        const source = new DemSource({
            id: 'worker-ready',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: 1,
            colors: ['red'],
            getTile,
            decodeImage
        });

        expect(await source.getFilledContourTile(0, 0, 0)).toEqual(Uint8Array.from([1, 2, 3]));
        expect(source.thresholds).toEqual([125]);
        expect(constructions).toBe(1);
        expect(postedBeforeReady).toBe(false);
        source.destroy();
    });

    it('permanently falls back when worker construction fails', async () => {
        let constructions = 0;
        class ThrowingWorker {
            constructor() {
                constructions++;
                throw new Error('Workers are blocked.');
            }
        }
        vi.stubGlobal('Worker', ThrowingWorker);

        const source = new DemSource({
            id: 'worker-construction-failure',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100],
            colors: ['red'],
            maxzoom: 1,
            getTile,
            decodeImage
        });

        expect((await source.getFilledContourTile(0, 0, 0)).byteLength).toBeGreaterThan(0);
        expect((await source.getFilledContourTile(1, 0, 0)).byteLength).toBeGreaterThan(0);
        expect(constructions).toBe(1);
        source.destroy();
    });

    it('permanently falls back when the worker module fails to load', async () => {
        let constructions = 0;
        let terminations = 0;
        class FailingWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            constructor() {
                constructions++;
                queueMicrotask(() => this.onerror?.({message: 'Could not load worker module.'} as ErrorEvent));
            }

            postMessage(): void {
                throw new Error('Input was transferred before worker startup completed.');
            }

            terminate(): void {
                terminations++;
            }
        }
        vi.stubGlobal('Worker', FailingWorker);

        const source = new DemSource({
            id: 'worker-load-failure',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100],
            colors: ['red'],
            maxzoom: 1,
            getTile,
            decodeImage
        });

        expect((await source.getFilledContourTile(0, 0, 0)).byteLength).toBeGreaterThan(0);
        expect((await source.getFilledContourTile(1, 0, 0)).byteLength).toBeGreaterThan(0);
        expect(constructions).toBe(1);
        expect(terminations).toBe(1);
        source.destroy();
    });
});
