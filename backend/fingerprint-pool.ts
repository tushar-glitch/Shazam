import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Fingerprint } from '../engine/index.js';

type Reply = { hashes: Int32Array; times: Int32Array } | { error: string };

// A few worker threads that fingerprint audio files in parallel, one file per worker at a time.
// One core is left for the main thread (downloads + database writes).
export class FingerprintPool {
    private readonly workers: Worker[];
    private readonly idle: Worker[];
    private readonly waiting: ((worker: Worker) => void)[] = [];

    constructor(size = Math.max(1, os.availableParallelism() - 1)) {
        this.workers = Array.from({ length: size }, () => new Worker(new URL('./fingerprint-worker.js', import.meta.url)));
        this.idle = [...this.workers];
    }

    get size(): number {
        return this.workers.length;
    }

    async fingerprintFile(file: string): Promise<Fingerprint[]> {
        const worker = this.idle.pop() ?? await new Promise<Worker>(resolve => this.waiting.push(resolve));
        try {
            // ponytail: a worker that crashes (not just throws) leaves this waiting forever; add an 'error' handler if that ever happens
            const reply = await new Promise<Reply>(resolve => {
                worker.once('message', resolve);
                worker.postMessage(file);
            });
            if ('error' in reply) throw new Error(reply.error);
            return Array.from(reply.hashes, (hash, i) => ({ hash, t: reply.times[i]! }));
        } finally {
            const next = this.waiting.shift();
            if (next) next(worker); else this.idle.push(worker);
        }
    }

    async close(): Promise<void> {
        await Promise.all(this.workers.map(worker => worker.terminate()));
    }
}
