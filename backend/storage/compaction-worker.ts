import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { Catalog, CATALOG_FILE } from './catalog.js';
import { type CompactionJob, compactOnce } from './compaction.js';

// Worker thread entry (see BackgroundCompactor): merge until the policy is satisfied
parentPort!.on('message', ({ dir, options }: CompactionJob) => {
    let catalog: Catalog | null = null;
    try {
        catalog = new Catalog(path.join(dir, CATALOG_FILE));
        while (compactOnce(dir, catalog, options)) { /* keep merging */ }
        parentPort!.postMessage({});
    } catch (error) {
        parentPort!.postMessage({ error: (error as Error).message });
    } finally {
        catalog?.close();
    }
});
