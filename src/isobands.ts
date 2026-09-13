import {contours} from 'd3-contour';
import polygonClipping from 'polygon-clipping';
import type {
    GeneratedIsoband,
    IsobandGenerationOptions,
    MultiPolygon,
    Position
} from './types.js';

const DEFAULT_EXTENT = 4096;
const DEFAULT_BUFFER = 1;

/**
 * Generates true, non-overlapping isobands from a padded row-major elevation grid.
 *
 * The first threshold is the lowest included value. The final band is unbounded.
 * `padding` describes how many grid samples surround the owning tile.
 */
export function generateIsobands(
    values: Float32Array,
    width: number,
    height: number,
    tileWidth: number,
    tileHeight: number,
    padding: number,
    options: IsobandGenerationOptions
): GeneratedIsoband[] {
    const thresholds = validateThresholds(options.thresholds);
    const extent = positiveInteger(options.extent ?? DEFAULT_EXTENT, 'extent');
    const buffer = nonNegativeInteger(options.buffer ?? DEFAULT_BUFFER, 'buffer');
    if (width < 2 || height < 2 || values.length !== width * height) {
        throw new RangeError('The elevation grid dimensions are invalid.');
    }
    if (tileWidth <= 0 || tileHeight <= 0 || padding < 0) {
        throw new RangeError('Tile dimensions and padding must be non-negative.');
    }

    const cumulative = contours()
        .size([width, height])
        .smooth(true)
        .thresholds(thresholds)(values as unknown as number[]);
    const clipPaddingX = buffer * tileWidth / extent;
    const clipPaddingY = buffer * tileHeight / extent;
    const left = padding + 0.5 - clipPaddingX;
    const top = padding + 0.5 - clipPaddingY;
    const right = padding + 0.5 + tileWidth + clipPaddingX;
    const bottom = padding + 0.5 + tileHeight + clipPaddingY;
    const clipPolygon: MultiPolygon = [[[
        [left, top], [right, top], [right, bottom], [left, bottom], [left, top]
    ]]];
    const scaleX = extent / tileWidth;
    const scaleY = extent / tileHeight;

    const result: GeneratedIsoband[] = [];
    for (let index = 0; index < thresholds.length; index++) {
        const lower = cumulative[index];
        if (!lower || lower.coordinates.length === 0) continue;
        let geometry = lower.coordinates as MultiPolygon;
        const upper = cumulative[index + 1];
        if (upper?.coordinates.length) {
            geometry = polygonClipping.difference(geometry, upper.coordinates as MultiPolygon) as MultiPolygon;
        }
        geometry = polygonClipping.intersection(geometry, clipPolygon) as MultiPolygon;
        if (!geometry.length) continue;
        geometry = geometry.map((polygon) => polygon.map((ring) => ring.map(([x, y]): Position => [
            Math.round((x - padding - 0.5) * scaleX),
            Math.round((y - padding - 0.5) * scaleY)
        ])));
        const max = thresholds[index + 1];
        result.push({
            properties: max === undefined
                ? {band: index, min: thresholds[index] as number}
                : {band: index, min: thresholds[index] as number, max},
            geometry
        });
    }
    return result;
}

export function validateThresholds(input: number[]): number[] {
    if (!Array.isArray(input) || input.length === 0) {
        throw new TypeError('thresholds must contain at least one number.');
    }
    const thresholds = [...input];
    for (let index = 0; index < thresholds.length; index++) {
        const value = thresholds[index];
        if (value === undefined || !Number.isFinite(value)) {
            throw new TypeError('thresholds must contain only finite numbers.');
        }
        if (index > 0 && value <= (thresholds[index - 1] as number)) {
            throw new RangeError('thresholds must be strictly increasing.');
        }
    }
    return thresholds;
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
    return value;
}

function nonNegativeInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer.`);
    return value;
}
