interface CacheEntry<V> {
    value: Promise<V>;
    lastUsed: number;
    waiting: number;
    controller: AbortController;
}

let clock = 0;

/** An LRU cache that shares in-flight work without letting one consumer cancel the others. */
export class AsyncLruCache<K, V> {
    private readonly entries = new Map<K, CacheEntry<V>>();

    constructor(private readonly capacity: number) {}

    get size(): number {
        return this.entries.size;
    }

    get(
        key: K,
        supplier: (controller: AbortController) => Promise<V>,
        consumer?: AbortController
    ): Promise<V> {
        let entry = this.entries.get(key);
        if (!entry) {
            const controller = new AbortController();
            const value = supplier(controller).catch((error: unknown) => {
                this.entries.delete(key);
                throw error;
            });
            entry = {value, lastUsed: ++clock, waiting: 0, controller};
            this.entries.set(key, entry);
            this.prune();
        }

        entry.lastUsed = ++clock;
        entry.waiting++;
        let released = false;
        const release = () => {
            if (released || !entry) return;
            released = true;
            entry.waiting--;
            if (entry.waiting === 0 && consumer?.signal.aborted) {
                entry.controller.abort();
                this.entries.delete(key);
            }
            this.prune();
        };
        let rejectAbort: ((error: Error) => void) | undefined;
        const aborted = new Promise<V>((_resolve, reject) => { rejectAbort = reject; });
        const onAbort = () => {
            release();
            const error = new Error('Request aborted.');
            error.name = 'AbortError';
            rejectAbort?.(error);
        };
        consumer?.signal.addEventListener('abort', onAbort, {once: true});
        if (consumer?.signal.aborted) onAbort();
        return Promise.race([entry.value, aborted]).finally(() => {
            consumer?.signal.removeEventListener('abort', onAbort);
            release();
        });
    }

    clear(): void {
        for (const entry of this.entries.values()) entry.controller.abort();
        this.entries.clear();
    }

    private prune(): void {
        while (this.entries.size > this.capacity) {
            let oldestKey: K | undefined;
            let oldestUse = Infinity;
            for (const [key, entry] of this.entries) {
                if (entry.waiting === 0 && entry.lastUsed < oldestUse) {
                    oldestUse = entry.lastUsed;
                    oldestKey = key;
                }
            }
            if (oldestKey === undefined) return;
            this.entries.delete(oldestKey);
        }
    }
}
