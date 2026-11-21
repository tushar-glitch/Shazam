import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Catalog } from './catalog.js';
import { type MergePolicyOptions, selectMerge } from './merge-policy.js';
import { SegmentReader } from './segment-reader.js';
import { mergeSegments } from './segment-merger.js';
import { SEGMENT_EXTENSION } from './segment-format.js';

export const newSegmentName = (): string => `seg-${randomUUID()}${SEGMENT_EXTENSION}`;

// Runs one merge chosen by the policy. Returns false when nothing needs merging.
// The merge itself runs without any lock (segments are immutable). The swap is optimistic:
// under the write lock it only commits if every input is still live; if another process
// merged them first, this result is thrown away.
export function compactOnce(dir: string, catalog: Catalog, options: MergePolicyOptions): boolean {
    const rows = catalog.segments();
    const chosen = selectMerge(rows, options);
    if (!chosen) return false;

    const inputs = chosen.map(s => rows.find(r => r.id === s.id)!);
    const deleted = catalog.deletedSongs();
    const readers: SegmentReader[] = [];
    const file = newSegmentName();
    try {
        for (const input of inputs) readers.push(SegmentReader.open(path.join(dir, input.file)));
        const { writer, stats } = mergeSegments(readers, path.join(dir, file), deleted);

        const committed = catalog.writeTransaction(() => {
            const live = catalog.segments();
            if (!inputs.every(input => live.some(r => r.id === input.id))) return false;
            writer.publish();
            catalog.removeSegments(inputs.map(r => r.id));
            catalog.addSegment(file, stats);
            // Every segment was merged, so no segment holds postings of these songs any more
            if (live.length === inputs.length) catalog.clearDeleted(deleted);
            return true;
        });
        if (!committed) {
            writer.abort();
            return true; // the segment list changed: let the caller ask the policy again
        }
    } finally {
        for (const reader of readers) reader.close();
    }

    // Inputs are no longer referenced. A reader in another process may still have one open:
    // that is fine on POSIX and on Windows (files are opened with FILE_SHARE_DELETE). If a
    // delete fails anyway, the next writer's recovery sweep removes the file.
    for (const input of inputs) {
        try {
            fs.rmSync(path.join(dir, input.file), { force: true });
        } catch (error) {
            console.warn(`Could not delete merged segment ${input.file} yet: ${(error as Error).message}`);
        }
    }
    return true;
}

export type CompactionJob = { dir: string; options: MergePolicyOptions };

// Runs compactions on a worker thread so a long merge never blocks the caller's event loop.
// request() after every flush; requests made while a merge runs are coalesced into one rerun.
export class BackgroundCompactor {
    private worker: Worker | null = null;
    private running = false;
    private requested = false;
    private idleWaiters: (() => void)[] = [];

    constructor(private readonly job: CompactionJob) {}

    request(): void {
        if (this.running) {
            this.requested = true;
            return;
        }
        this.running = true;
        this.requested = false;
        this.ensureWorker().postMessage(this.job);
    }

    // Waits for the merge in progress (and any requested rerun), then stops the thread
    async close(): Promise<void> {
        if (this.running) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
        await this.worker?.terminate();
        this.worker = null;
    }

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        const worker = new Worker(new URL('./compaction-worker.js', import.meta.url));
        worker.on('message', (reply: { error?: string }) => {
            if (reply.error) console.error(`Compaction failed: ${reply.error}`);
            this.finished();
        });
        worker.on('error', (error: Error) => {
            console.error(`Compaction worker crashed: ${error.message}`);
            this.worker = null;
            this.finished();
        });
        return this.worker = worker;
    }

    private finished(): void {
        this.running = false;
        if (this.requested) return this.request();
        for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
}
