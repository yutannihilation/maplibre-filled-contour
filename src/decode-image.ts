import type {DemEncoding, DemTile} from './types.js';

let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;

/** Decodes already-extracted RGBA pixels. Exported for servers and tests. */
export function decodeParsedImage(
    width: number,
    height: number,
    encoding: DemEncoding,
    rgba: Uint8ClampedArray
): DemTile {
    if (rgba.length !== width * height * 4) throw new RangeError('RGBA data length does not match image dimensions.');
    const data = new Float32Array(width * height);
    for (let pixel = 0, offset = 0; pixel < data.length; pixel++, offset += 4) {
        const r = rgba[offset] ?? 0;
        const g = rgba[offset + 1] ?? 0;
        const b = rgba[offset + 2] ?? 0;
        data[pixel] = encoding === 'mapbox'
            ? -10_000 + (r * 65_536 + g * 256 + b) * 0.1
            : r * 256 + g + b / 256 - 32_768;
    }
    return {width, height, data};
}

/** Decodes a browser image blob into elevation samples. */
export default async function decodeImage(
    blob: Blob,
    encoding: DemEncoding,
    abortController: AbortController
): Promise<DemTile> {
    throwIfAborted(abortController);

    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        try {
            throwIfAborted(abortController);
            if (typeof OffscreenCanvas !== 'undefined') {
                canvas ??= new OffscreenCanvas(bitmap.width, bitmap.height);
            } else if (typeof document !== 'undefined') {
                canvas ??= document.createElement('canvas');
            } else {
                throw new Error('This environment cannot decode DEM images; provide the decodeImage option.');
            }
            return extractElevations(bitmap, encoding, canvas);
        } finally {
            bitmap.close();
        }
    }

    if (typeof document === 'undefined') {
        throw new Error('This environment cannot decode DEM images; provide the decodeImage option.');
    }

    canvas ??= document.createElement('canvas');
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    const abort = () => { image.src = ''; };
    abortController.signal.addEventListener('abort', abort, {once: true});
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('Could not decode the DEM image.'));
            image.src = objectUrl;
        });
        throwIfAborted(abortController);
        return extractElevations(image, encoding, canvas);
    } finally {
        abortController.signal.removeEventListener('abort', abort);
        URL.revokeObjectURL(objectUrl);
    }
}

function extractElevations(
    image: CanvasImageSource & {width: number; height: number},
    encoding: DemEncoding,
    target: HTMLCanvasElement | OffscreenCanvas
): DemTile {
    target.width = image.width;
    target.height = image.height;
    context ??= target.getContext('2d', {willReadFrequently: true}) as
        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('Could not create a 2D canvas context.');
    context.drawImage(image, 0, 0, image.width, image.height);
    return decodeParsedImage(
        image.width,
        image.height,
        encoding,
        context.getImageData(0, 0, image.width, image.height).data
    );
}

function throwIfAborted(controller: AbortController): void {
    if (!controller.signal.aborted) return;
    const error = new Error('DEM request aborted.');
    error.name = 'AbortError';
    throw error;
}
