import type {ProcessTileInput} from './process-tile.js';

interface WorkerResponse {
    id: number;
    data?: ArrayBuffer;
    error?: string;
}

interface WorkerReady {
    ready: true;
}

interface Pending {
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
}

export class IsobandWorker {
    private readonly worker: Worker;
    private readonly startup: Promise<void>;
    private readonly pending = new Map<number, Pending>();
    private nextId = 0;
    private resolveStartup!: () => void;
    private rejectStartup!: (error: Error) => void;

    constructor() {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
        this.startup = new Promise<void>((resolve, reject) => {
            this.resolveStartup = resolve;
            this.rejectStartup = reject;
        });
        this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerReady>) => {
            const response = event.data;
            if ('ready' in response) {
                this.resolveStartup();
                return;
            }
            const pending = this.pending.get(response.id);
            if (!pending) return;
            this.pending.delete(response.id);
            if (response.error) pending.reject(new Error(response.error));
            else pending.resolve(response.data ? new Uint8Array(response.data) : new Uint8Array());
        };
        this.worker.onerror = (event) => {
            const error = new Error(event.message || 'Isoband worker failed.');
            this.rejectStartup(error);
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
        };
    }

    ready(): Promise<void> {
        return this.startup;
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
            try {
                this.worker.postMessage({id, input}, [input.values.buffer]);
            } catch (error) {
                this.pending.delete(id);
                abortController.signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        });
    }

    terminate(): void {
        this.worker.terminate();
        const error = new Error('Isoband worker terminated.');
        this.rejectStartup(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}
