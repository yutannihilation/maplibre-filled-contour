import type {VectorSourceSpecification} from 'maplibre-gl';

/** Scheme used to turn the RGB channels of a DEM pixel into metres. */
export type DemEncoding = 'terrarium' | 'mapbox';

export interface DemTile {
    width: number;
    height: number;
    /** Elevations in row-major order. */
    data: Float32Array;
}

export interface FetchResponse {
    data: Blob;
    cacheControl?: string;
    expires?: string;
}

export type GetTileFunction = (
    url: string,
    abortController: AbortController
) => Promise<FetchResponse>;

export type DecodeImageFunction = (
    blob: Blob,
    encoding: DemEncoding,
    abortController: AbortController
) => Promise<DemTile>;

export interface DemSourceOptions {
    /** Remote DEM URL containing `{z}`, `{x}`, and `{y}` placeholders. */
    url: string;
    /** Strictly increasing band boundaries. */
    thresholds: number[];
    /** Include the unbounded band below the first threshold. Defaults to false. */
    includeLower?: boolean;
    /** Include the unbounded band above the final threshold. Defaults to true. */
    includeUpper?: boolean;
    /** DEM pixel encoding. Defaults to `terrarium`. */
    encoding?: DemEncoding;
    /** Maximum zoom available from the DEM source. Defaults to 12. */
    maxzoom?: number;
    /** Number of most-recent DEM and generated tiles retained. Defaults to 100. */
    cacheSize?: number;
    /** Fetch timeout in milliseconds. Defaults to 10,000. */
    timeoutMs?: number;
    /** Prefix used for MapLibre protocol names. Defaults to `dem`. */
    id?: string;
    /** Vector source-layer name. Defaults to `isobands`. */
    layer?: string;
    /** Vector-tile coordinate extent. Defaults to 4096. */
    extent?: number;
    /** Extra output in tile pixels, used to hide seams. Defaults to 1. */
    buffer?: number;
    /** Advanced/test hook for fetching DEM images. */
    getTile?: GetTileFunction;
    /** Advanced/test hook for decoding DEM images. */
    decodeImage?: DecodeImageFunction;
}

export interface IsobandProperties {
    /** Zero-based position in the configured output-band sequence. */
    band: number;
    /** Inclusive lower boundary; absent on the unbounded lower band. */
    min?: number;
    /** Exclusive upper boundary; absent on the unbounded upper band. */
    max?: number;
}

export interface IsobandSourceSpecification extends VectorSourceSpecification {
    type: 'vector';
    encoding: 'mlt';
}

export interface TileCoordinate {
    z: number;
    x: number;
    y: number;
}

export interface IsobandGenerationOptions {
    thresholds: number[];
    /** Include the unbounded band below the first threshold. Defaults to false. */
    includeLower?: boolean;
    /** Include the unbounded band above the final threshold. Defaults to true. */
    includeUpper?: boolean;
    extent?: number;
    buffer?: number;
}

export type Position = [number, number];
export type Ring = Position[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

export interface GeneratedIsoband {
    properties: IsobandProperties;
    geometry: MultiPolygon;
}
