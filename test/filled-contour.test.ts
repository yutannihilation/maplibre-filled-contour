import {decodeTile, GEOMETRY_TYPE} from '@maplibre/mlt';
import {describe, expect, it, vi} from 'vitest';
import {
    decodeParsedImage,
    DemSource,
    generateIsobands,
    type DecodeImageFunction,
    type GetTileFunction
} from '../src/index.js';

function gradient(width: number, height: number): Float32Array {
    return Float32Array.from({length: width * height}, (_, index) =>
        (index % width) * 100);
}

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
            maxzoom: 1,
            worker: false,
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

    it('passes includeLower and includeUpper through tile generation and MLT encoding', async () => {
        const source = new DemSource({
            id: 'bounded-terrain',
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100],
            includeLower: true,
            includeUpper: false,
            worker: false,
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
            thresholds: [100, 100]
        })).toThrow(/strictly increasing/);

        const never: GetTileFunction = (_url, controller) => new Promise((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        });
        const source = new DemSource({
            url: 'https://example.test/{z}/{x}/{y}.png',
            thresholds: [100],
            timeoutMs: 5,
            worker: false,
            getTile: never,
            decodeImage
        });
        await expect(source.getDemTile(0, 0, 0)).rejects.toThrow(/timed out|aborted/);
    });
});
