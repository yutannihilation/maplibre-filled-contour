import {generateIsobands} from './isobands.js';
import {encodeIsobandTile} from './mlt.js';

export interface ProcessTileInput {
    values: Float32Array;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    padding: number;
    thresholds: number[] | number;
    /** Valid elevation extrema across complete neighboring DEM tiles, before grid averaging. */
    thresholdRange?: [number, number];
    includeLower: boolean;
    includeUpper: boolean;
    layer: string;
    extent: number;
    buffer: number;
}

export interface ProcessTileResult {
    data: Uint8Array;
    thresholds: number[];
}

export function processTileWithMetadata(input: ProcessTileInput): ProcessTileResult {
    const thresholds = Array.isArray(input.thresholds)
        ? input.thresholds
        : deriveThresholds(input.thresholdRange ?? input.values, input.thresholds);
    const bands = generateIsobands(
        input.values,
        input.width,
        input.height,
        input.tileWidth,
        input.tileHeight,
        input.padding,
        {
            thresholds,
            includeLower: input.includeLower,
            includeUpper: input.includeUpper,
            extent: input.extent,
            buffer: input.buffer
        }
    );
    return {data: encodeIsobandTile(input.layer, input.extent, bands), thresholds};
}

export function processTile(input: ProcessTileInput): Uint8Array {
    return processTileWithMetadata(input).data;
}

/** Derives an exact number of ascending equal-interval boundaries from finite samples. */
export function deriveThresholds(values: ArrayLike<number>, count: number): number[] {
    if (!Number.isInteger(count) || count <= 0) {
        throw new RangeError('A dynamic thresholds count must be a positive integer.');
    }

    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < values.length; index++) {
        const value = values[index] as number;
        if (!Number.isFinite(value)) continue;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
        throw new RangeError('Dynamic thresholds require at least one finite DEM sample.');
    }

    const span = maximum - minimum;
    const step = span === 0 ? flatDataStep(minimum) : span / count;
    return Array.from({length: count}, (_, index) => minimum + step * index);
}

function flatDataStep(value: number): number {
    const magnitude = Math.abs(value);
    if (magnitude === 0) return 1;
    return 10 ** Math.floor(Math.log10(magnitude) - 2);
}
