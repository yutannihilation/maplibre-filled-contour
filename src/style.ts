import type {
    IsobandBand,
    IsobandColors,
    IsobandFillColorExpression,
    IsobandStyleOptions
} from './types.js';

/** Builds the ordered band/color model shared by generated styles and legends. */
export function createIsobandBands(
    thresholds: readonly number[],
    includeLower = false,
    includeUpper = true,
    colors: IsobandColors = defaultIsobandColor
): IsobandBand[] {
    const boundaries = validateThresholds(thresholds);
    const ranges: Array<Omit<IsobandBand, 'color'>> = [];

    if (includeLower) ranges.push({band: 0, max: boundaries[0] as number});
    const offset = includeLower ? 1 : 0;
    for (let index = 0; index < boundaries.length; index++) {
        const max = boundaries[index + 1];
        if (max === undefined && !includeUpper) break;
        const range: Omit<IsobandBand, 'color'> = {
            band: index + offset,
            min: boundaries[index] as number
        };
        if (max !== undefined) range.max = max;
        ranges.push(range);
    }

    const resolvedColors = resolveColors(colors, ranges.length);
    return ranges.map((range, index) => ({...range, color: resolvedColors[index] as string}));
}

/** Default sequential palette: one blue hue, increasingly saturated and dark. */
export function defaultIsobandColor(position: number): string {
    const normalized = Math.max(0, Math.min(1, position));
    const saturation = Math.round(30 + 60 * normalized);
    const lightness = Math.round(92 - 48 * normalized);
    return `hsl(210, ${saturation}%, ${lightness}%)`;
}

/** Generates a MapLibre match expression using the always-present `band` feature property. */
export function createIsobandFillColorExpression(
    bands: readonly IsobandBand[],
    fallbackColor = 'rgba(0, 0, 0, 0)'
): IsobandFillColorExpression {
    const validatedFallback = validateColor(fallbackColor, 'fallbackColor');
    if (bands.length === 0) return ['to-color', validatedFallback] as IsobandFillColorExpression;
    const expression: unknown[] = ['match', ['get', 'band']];
    for (const band of bands) expression.push(band.band, band.color);
    expression.push(validatedFallback);
    return expression as IsobandFillColorExpression;
}

/** Creates both the canonical band model and its MapLibre fill-color expression. */
export function createIsobandStyle(
    thresholds: readonly number[],
    includeLower = false,
    includeUpper = true,
    options: IsobandStyleOptions = {}
): {bands: IsobandBand[]; fillColor: IsobandFillColorExpression} {
    const bands = createIsobandBands(thresholds, includeLower, includeUpper, options.colors);
    return {
        bands,
        fillColor: createIsobandFillColorExpression(bands, options.fallbackColor)
    };
}

function resolveColors(colors: IsobandColors, count: number): string[] {
    if (Array.isArray(colors)) {
        if (colors.length !== count) {
            throw new RangeError(`colors must contain exactly ${count} entries (one per output band).`);
        }
        return colors.map((color, index) => validateColor(color, `colors[${index}]`));
    }

    const interpolate = colors as Exclude<IsobandColors, readonly string[]>;
    return Array.from({length: count}, (_, index) => {
        const position = count === 1 ? 0.5 : index / (count - 1);
        return validateColor(interpolate(position, index, count), `color returned for band ${index}`);
    });
}

function validateThresholds(input: readonly number[]): number[] {
    if (!Array.isArray(input) || input.length === 0) throw new TypeError('thresholds must contain at least one value.');
    const result = [...input];
    for (let index = 0; index < result.length; index++) {
        const value = result[index];
        if (!Number.isFinite(value)) throw new TypeError('thresholds must contain only finite numbers.');
        if (index > 0 && (result[index - 1] as number) >= (value as number)) {
            throw new RangeError('thresholds must be strictly increasing.');
        }
    }
    return result;
}

function validateColor(color: string, name: string): string {
    if (typeof color !== 'string' || !color.trim()) throw new TypeError(`${name} must be a non-empty color string.`);
    return color;
}
