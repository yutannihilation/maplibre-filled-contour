import {generateIsobands} from './isobands.js';
import {encodeIsobandTile} from './mlt.js';

export interface ProcessTileInput {
    values: Float32Array;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    padding: number;
    thresholds: number[];
    lower: boolean;
    upper: boolean;
    layer: string;
    extent: number;
    buffer: number;
}

export function processTile(input: ProcessTileInput): Uint8Array {
    const bands = generateIsobands(
        input.values,
        input.width,
        input.height,
        input.tileWidth,
        input.tileHeight,
        input.padding,
        {
            thresholds: input.thresholds,
            lower: input.lower,
            upper: input.upper,
            extent: input.extent,
            buffer: input.buffer
        }
    );
    return encodeIsobandTile(input.layer, input.extent, bands);
}
