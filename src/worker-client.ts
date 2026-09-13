import type {ProcessTileInput} from './process-tile.js';

interface WorkerResponse {
    id: number;
    data?: ArrayBuffer;
    error?: string;
}

interface Pending {
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
}

export class IsobandWorker {
    private readonly worker: Worker;
    private readonly pending = new Map<number, Pending>();
    private nextId = 0;

    constructor() {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
        this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const response = event.data;
            const pending = this.pending.get(response.id);
            if (!pending) return;
            this.pending.delete(response.id);
            if (response.error) pending.reject(new Error(response.error));
            else pending.resolve(response.data ? new Uint8Array(response.data) : new Uint8Array());
        };
        this.worker.onerror = (event) => {
            const error = new Error(event.message || 'Isoband worker failed.');
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
        };
    }

    process(input: ProcessTileInput, abortController: AbortController): Promise<Uint8Array> {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this.pending.delete(id);
                const error = new Error('Isoband generation aborted.');
                error.name = 'AbortError';
                reject(error);
            };
            abortController.signal.addEventListener('abort', onAbort, {once: true});
            this.pending.set(id, {
                resolve: (data) => {
                    abortController.signal.removeEventListener('abort', onAbort);
                    resolve(data);
                },
                reject: (error) => {
                    abortController.signal.removeEventListener('abort', onAbort);
                    reject(error);
                }
            });
            this.worker.postMessage({id, input}, [input.values.buffer]);
        });
    }

    terminate(): void {
        this.worker.terminate();
        const error = new Error('Isoband worker terminated.');
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}
