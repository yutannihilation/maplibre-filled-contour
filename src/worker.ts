import {processTileWithMetadata, type ProcessTileInput} from './process-tile.js';

interface WorkerRequest {
    id: number;
    input: ProcessTileInput;
}

interface WorkerResponse {
    id: number;
    data?: ArrayBuffer;
    thresholds?: number[];
    error?: string;
}

interface WorkerReady {
    ready: true;
}

postMessage({ready: true} satisfies WorkerReady);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const {id, input} = event.data;
    try {
        const result = processTileWithMetadata(input);
        const bytes = result.data;
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const response: WorkerResponse = {id, data, thresholds: result.thresholds};
        (self as unknown as {
            postMessage: (message: WorkerResponse, transfer: Transferable[]) => void;
        }).postMessage(response, [data]);
    } catch (error) {
        const response: WorkerResponse = {
            id,
            error: error instanceof Error ? error.message : String(error)
        };
        self.postMessage(response);
    }
};
