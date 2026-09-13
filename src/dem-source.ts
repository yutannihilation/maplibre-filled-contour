import type {AddProtocolAction} from 'maplibre-gl';
import {AsyncLruCache} from './cache.js';
import defaultDecodeImage from './decode-image.js';
import {HeightTile} from './height-tile.js';
import {IsobandLegendControl} from './legend-control.js';
import {processTile, type ProcessTileInput} from './process-tile.js';
import {createIsobandBands, createIsobandFillColorExpression} from './style.js';
import type {
    AddedIsobandLayer,
    AddIsobandLayerOptions,
    DemSourceOptions,
    DemTile,
    DecodeImageFunction,
    FetchResponse,
    GetTileFunction,
    IsobandBand,
    IsobandFillColorExpression,
    IsobandFillLayerSpecification,
    IsobandLayerOptions,
    IsobandLegendOptions,
    IsobandMap,
    IsobandSourceSpecification
} from './types.js';
import {IsobandWorker} from './worker-client.js';

interface ProtocolRegistry {
    addProtocol: (protocol: string, handler: AddProtocolAction) => void;
    removeProtocol?: (protocol: string) => void;
}

const usedProtocolPrefixes = new Set<string>();
const GRID_PADDING = 2;

const defaultGetTile = async (url: string, controller: AbortController): Promise<FetchResponse> => {
    const response = await fetch(url, {signal: controller.signal});
    if (!response.ok) throw new Error(`DEM request failed with HTTP ${response.status}: ${url}`);
    const result: FetchResponse = {data: await response.blob()};
    const cacheControl = response.headers.get('cache-control');
    const expires = response.headers.get('expires');
    if (cacheControl) result.cacheControl = cacheControl;
    if (expires) result.expires = expires;
    return result;
};

/** Generates filled contour vector tiles on demand from an XYZ raster DEM source. */
export class DemSource {
    readonly thresholds: readonly number[];
    readonly colors: readonly string[];
    readonly includeLower: boolean;
    readonly includeUpper: boolean;
    readonly encoding: 'terrarium' | 'mapbox';
    readonly maxzoom: number;
    readonly layer: string;
    readonly extent: number;
    readonly buffer: number;
    readonly sharedDemProtocolId: string;
    readonly filledContourProtocolId: string;
    /** Alias retained for familiarity with line-contour plugins. */
    readonly contourProtocolId: string;
    readonly sharedDemProtocolUrl: string;
    readonly filledContourProtocolUrl: string;

    private readonly url: string;
    private readonly timeoutMs: number;
    private readonly getTileImpl: GetTileFunction;
    private readonly decodeImage: DecodeImageFunction;
    private readonly rawCache: AsyncLruCache<string, FetchResponse>;
    private readonly demCache: AsyncLruCache<string, DemTile>;
    private readonly outputCache: AsyncLruCache<string, Uint8Array>;
    private worker: IsobandWorker | undefined;
    private workerUnavailable = false;
    private registry: ProtocolRegistry | undefined;

    constructor(options: DemSourceOptions) {
        if (!options || typeof options !== 'object') throw new TypeError('DemSource options are required.');
        this.url = validateUrl(options.url);
        this.thresholds = Object.freeze(validateThresholds(options.thresholds));
        this.includeLower = options.includeLower ?? false;
        this.includeUpper = options.includeUpper ?? true;
        const bands = createIsobandBands(
            this.thresholds,
            this.includeLower,
            this.includeUpper,
            options.colors
        );
        this.colors = Object.freeze(bands.map((band) => band.color));
        this.encoding = options.encoding ?? 'terrarium';
        if (this.encoding !== 'terrarium' && this.encoding !== 'mapbox') {
            throw new TypeError('encoding must be "terrarium" or "mapbox".');
        }
        this.maxzoom = integerInRange(options.maxzoom ?? 12, 0, 24, 'maxzoom');
        const cacheSize = positiveInteger(options.cacheSize ?? 100, 'cacheSize');
        this.timeoutMs = positiveNumber(options.timeoutMs ?? 10_000, 'timeoutMs');
        this.layer = nonEmptyString(options.layer ?? 'isobands', 'layer');
        this.extent = positiveInteger(options.extent ?? 4096, 'extent');
        this.buffer = integerInRange(options.buffer ?? 1, 0, this.extent, 'buffer');
        this.getTileImpl = options.getTile ?? defaultGetTile;
        this.decodeImage = options.decodeImage ?? defaultDecodeImage;

        let prefix = nonEmptyString(options.id ?? 'dem', 'id');
        const base = prefix;
        for (let suffix = 1; usedProtocolPrefixes.has(prefix); suffix++) prefix = `${base}${suffix}`;
        usedProtocolPrefixes.add(prefix);
        this.sharedDemProtocolId = `${prefix}-shared`;
        this.filledContourProtocolId = `${prefix}-isobands`;
        this.contourProtocolId = this.filledContourProtocolId;
        this.sharedDemProtocolUrl = `${this.sharedDemProtocolId}://{z}/{x}/{y}.png`;
        this.filledContourProtocolUrl = `${this.filledContourProtocolId}://{z}/{x}/{y}.mlt`;

        this.rawCache = new AsyncLruCache(cacheSize);
        this.demCache = new AsyncLruCache(cacheSize);
        this.outputCache = new AsyncLruCache(cacheSize);
    }

    /** Registers the DEM-sharing and filled-contour protocols with MapLibre. */
    setupMaplibre(maplibre: ProtocolRegistry): this {
        if (this.registry && this.registry !== maplibre) {
            throw new Error('This DemSource is already registered with another MapLibre instance.');
        }
        if (!this.registry) {
            maplibre.addProtocol(this.sharedDemProtocolId, this.sharedDemProtocol);
            maplibre.addProtocol(this.filledContourProtocolId, this.filledContourProtocol);
            this.registry = maplibre;
        }
        return this;
    }

    /** A ready-to-add MapLibre vector source specification. */
    getSourceSpecification(): IsobandSourceSpecification {
        return {
            type: 'vector',
            tiles: [this.filledContourProtocolUrl],
            minzoom: 0,
            maxzoom: this.maxzoom,
            encoding: 'mlt'
        };
    }

    /** Returns the ordered ranges and colors shared by generated styles and legends. */
    getBands(): IsobandBand[] {
        return createIsobandBands(
            this.thresholds,
            this.includeLower,
            this.includeUpper,
            this.colors
        );
    }

    /** Generates a MapLibre fill-color expression that matches the output `band` property. */
    getFillColorExpression(
        options: Pick<IsobandLayerOptions, 'fallbackColor'> = {}
    ): IsobandFillColorExpression {
        return createIsobandFillColorExpression(this.getBands(), options.fallbackColor);
    }

    /** Generates a ready-to-add MapLibre fill layer specification. */
    getLayerSpecification(options: IsobandLayerOptions): IsobandFillLayerSpecification {
        const specification: IsobandFillLayerSpecification = {
            id: nonEmptyString(options.id, 'id'),
            type: 'fill',
            source: nonEmptyString(options.source, 'source'),
            'source-layer': this.layer,
            paint: {
                ...options.paint,
                'fill-color': this.getFillColorExpression(options)
            }
        };
        if (options.layout !== undefined) specification.layout = options.layout;
        if (options.minzoom !== undefined) specification.minzoom = options.minzoom;
        if (options.maxzoom !== undefined) specification.maxzoom = options.maxzoom;
        return specification;
    }

    /** Creates a MapLibre control using the same band model as the generated fill style. */
    getLegendControl(options: IsobandLegendOptions = {}): IsobandLegendControl {
        return new IsobandLegendControl(this.getBands(), options);
    }

    /** Adds the generated source, fill layer, and (by default) legend to a loaded map. */
    addTo(map: IsobandMap, options: AddIsobandLayerOptions): AddedIsobandLayer {
        const {sourceId, beforeId, legend: legendOption, ...layerOptions} = options;
        const source = nonEmptyString(sourceId, 'sourceId');
        map.addSource(source, this.getSourceSpecification());

        let layerAdded = false;
        let legend: IsobandLegendControl | undefined;
        try {
            map.addLayer(this.getLayerSpecification({...layerOptions, source}), beforeId);
            layerAdded = true;
            if (legendOption !== false) {
                const legendOptions = legendOption === true || legendOption === undefined ? {} : legendOption;
                legend = this.getLegendControl({
                    ...legendOptions
                });
                map.addControl(legend);
            }
        } catch (error) {
            if (legend) map.removeControl(legend);
            if (layerAdded && map.getLayer(options.id)) map.removeLayer(options.id);
            if (map.getSource(source)) map.removeSource(source);
            throw error;
        }

        let removed = false;
        const result: AddedIsobandLayer = {
            sourceId: source,
            layerId: options.id,
            remove: () => {
                if (removed) return;
                removed = true;
                if (legend) map.removeControl(legend);
                if (map.getLayer(options.id)) map.removeLayer(options.id);
                if (map.getSource(source)) map.removeSource(source);
            }
        };
        if (legend) Object.assign(result, {legend});
        return result;
    }

    /** Alias for `getSourceSpecification()`. */
    contourSource(): IsobandSourceSpecification {
        return this.getSourceSpecification();
    }

    /** Returns the custom-protocol tile template used by the filled contour source. */
    contourProtocolUrl(): string {
        return this.filledContourProtocolUrl;
    }

    /** Fetches and decodes one DEM tile, sharing in-flight requests and cached results. */
    getDemTile(z: number, x: number, y: number, controller = new AbortController()): Promise<DemTile> {
        validateCoordinate(z, x, y, this.maxzoom);
        const url = this.tileUrl(z, x, y);
        return this.demCache.get(url, async (sharedController) => {
            const raw = await this.fetchRaw(z, x, y, sharedController);
            throwIfAborted(sharedController);
            return this.decodeImage(raw.data, this.encoding, sharedController);
        }, controller);
    }

    /** Generates one encoded MLT isoband tile. */
    getFilledContourTile(
        z: number,
        x: number,
        y: number,
        controller = new AbortController()
    ): Promise<Uint8Array> {
        validateCoordinate(z, x, y, this.maxzoom);
        return this.outputCache.get(`${z}/${x}/${y}`, (sharedController) =>
            this.generateTile(z, x, y, sharedController), controller);
    }

    /** Clears caches, terminates the worker, and unregisters protocols when supported. */
    destroy(): void {
        this.rawCache.clear();
        this.demCache.clear();
        this.outputCache.clear();
        this.worker?.terminate();
        this.worker = undefined;
        this.registry?.removeProtocol?.(this.sharedDemProtocolId);
        this.registry?.removeProtocol?.(this.filledContourProtocolId);
        this.registry = undefined;
    }

    private readonly sharedDemProtocol: AddProtocolAction = async (request, controller) => {
        const [z, x, y] = parseTileUrl(request.url, this.sharedDemProtocolId);
        const response = await this.fetchRaw(z, x, y, controller);
        const result: Awaited<ReturnType<AddProtocolAction>> = {data: await response.data.arrayBuffer()};
        if (response.cacheControl) result.cacheControl = response.cacheControl;
        if (response.expires) result.expires = response.expires;
        return result;
    };

    private readonly filledContourProtocol: AddProtocolAction = async (request, controller) => {
        const [z, x, y] = parseTileUrl(request.url, this.filledContourProtocolId);
        const bytes = await this.getFilledContourTile(z, x, y, controller);
        return {data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer};
    };

    private fetchRaw(z: number, x: number, y: number, controller: AbortController): Promise<FetchResponse> {
        const url = this.tileUrl(z, x, y);
        return this.rawCache.get(url, (sharedController) => withTimeout(
            this.getTileImpl(url, sharedController), this.timeoutMs, sharedController, url
        ), controller);
    }

    private async generateTile(z: number, x: number, y: number, controller: AbortController): Promise<Uint8Array> {
        const dimension = 2 ** z;
        const neighbors: Array<Promise<HeightTile | undefined>> = [];
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
            for (let offsetX = -1; offsetX <= 1; offsetX++) {
                const neighborY = y + offsetY;
                if (neighborY < 0 || neighborY >= dimension) {
                    neighbors.push(Promise.resolve(undefined));
                } else {
                    const neighborX = (x + offsetX + dimension) % dimension;
                    neighbors.push(this.getDemTile(z, neighborX, neighborY, controller).then(HeightTile.fromDem));
                }
            }
        }
        const combined = HeightTile.combineNeighbors(await Promise.all(neighbors));
        throwIfAborted(controller);
        if (!combined) return new Uint8Array();
        const grid = combined.toGrid().materialize(GRID_PADDING);
        const input: ProcessTileInput = {
            values: grid.data,
            width: grid.width,
            height: grid.height,
            tileWidth: combined.width,
            tileHeight: combined.height,
            padding: GRID_PADDING,
            thresholds: [...this.thresholds],
            includeLower: this.includeLower,
            includeUpper: this.includeUpper,
            layer: this.layer,
            extent: this.extent,
            buffer: this.buffer
        };
        return this.processTile(input, controller);
    }

    private async processTile(input: ProcessTileInput, controller: AbortController): Promise<Uint8Array> {
        if (this.workerUnavailable || typeof Worker === 'undefined') return processTile(input);

        let worker: IsobandWorker;
        try {
            worker = this.worker ??= new IsobandWorker();
            await worker.ready();
        } catch {
            this.workerUnavailable = true;
            this.worker?.terminate();
            this.worker = undefined;
            throwIfAborted(controller);
            return processTile(input);
        }

        throwIfAborted(controller);
        return worker.process(input, controller);
    }

    private tileUrl(z: number, x: number, y: number): string {
        return this.url.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
    }
}

function validateUrl(url: string): string {
    const result = nonEmptyString(url, 'url');
    for (const token of ['{z}', '{x}', '{y}']) {
        if (!result.includes(token)) throw new TypeError(`url must contain ${token}.`);
    }
    return result;
}

function validateThresholds(input: number[]): number[] {
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

function parseTileUrl(url: string, protocol: string): [number, number, number] {
    const expression = new RegExp(`^${escapeRegExp(protocol)}://(\\d+)/(\\d+)/(\\d+)(?:\\.[^?]+)?(?:\\?.*)?$`);
    const match = expression.exec(url);
    if (!match) throw new Error(`Invalid ${protocol} tile URL: ${url}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function validateCoordinate(z: number, x: number, y: number, maxzoom: number): void {
    integerInRange(z, 0, maxzoom, 'z');
    const dimension = 2 ** z;
    integerInRange(x, 0, dimension - 1, 'x');
    integerInRange(y, 0, dimension - 1, 'y');
}

function nonEmptyString(value: string, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
    return value;
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
    return value;
}

function positiveNumber(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number.`);
    return value;
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
    }
    return value;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function throwIfAborted(controller: AbortController): void {
    if (!controller.signal.aborted) return;
    const error = new Error('DEM request aborted.');
    error.name = 'AbortError';
    throw error;
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    controller: AbortController,
    url: string
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`DEM request timed out after ${timeoutMs}ms: ${url}`));
        }, timeoutMs);
        promise.then(resolve, reject).finally(() => clearTimeout(timeout));
    });
}
