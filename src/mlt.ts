import {
    encodeTile,
    type Feature,
    type Position
} from '@maplibre/mlt/dist/encoding/mltEncoder.js';
import type {GeneratedIsoband, IsobandProperties, Ring} from './types.js';

/** Encodes generated bands as a MapLibre Tile (MLT) polygon feature table. */
export function encodeIsobandTile(layerName: string, extent: number, bands: GeneratedIsoband[]): Uint8Array {
    const features: Feature[] = bands.flatMap((band) => band.geometry.flatMap((polygon) => {
        const rings = polygon.map(toMltRing);
        const exterior = rings[0];
        if (!exterior || exterior.length < 3) return [];
        const coordinates = [exterior, ...rings.slice(1).filter((ring) => ring.length >= 3)];
        return [{
            geometry: {type: 'Polygon' as const, coordinates},
            properties: toProperties(band.properties)
        }];
    }));

    return encodeTile([{
        name: layerName,
        extent,
        features
    }]);
}

function toMltRing(ring: Ring): Position[] {
    const first = ring[0];
    const last = ring.at(-1);
    const open = first && last && first[0] === last[0] && first[1] === last[1]
        ? ring.slice(0, -1)
        : ring;
    const result: Position[] = [];
    for (const [x, y] of open) {
        const previous = result.at(-1);
        if (!previous || previous[0] !== x || previous[1] !== y) result.push([x, y]);
    }
    if (result.length > 1) {
        const firstResult = result[0];
        const lastResult = result.at(-1);
        if (firstResult && lastResult && firstResult[0] === lastResult[0] && firstResult[1] === lastResult[1]) {
            result.pop();
        }
    }
    return result;
}

function toProperties(properties: IsobandProperties): Record<string, number> {
    const result: Record<string, number> = {
        band: properties.band
    };
    if (properties.min !== undefined) result.min = properties.min;
    if (properties.max !== undefined) result.max = properties.max;
    return result;
}
