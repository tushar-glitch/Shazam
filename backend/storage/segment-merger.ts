import type { Postings, SegmentReader } from './segment-reader.js';
import { type SegmentStats, SegmentWriter } from './segment-writer.js';

type Cursor = { entries: Generator<{ hash: number; postings: Postings }>; hash: number; postings: Postings | null };

// Merges segments into a new segment file, dropping postings of deleted songs. Returns the
// finished but unpublished writer: the caller publishes it once the catalog swap is decided.
// Inputs are walked in parallel in hash order (a k-way merge). k is small (≤ mergeFactor), so
// the smallest head is found by a linear scan; a heap only pays off for much larger k.
export function mergeSegments(
    inputs: readonly SegmentReader[],
    output: string,
    deletedSongs: ReadonlySet<number>
): { writer: SegmentWriter; stats: SegmentStats } {
    const writer = new SegmentWriter(output);
    try {
        const cursors: Cursor[] = inputs.map(reader => advance({ entries: reader.entries(), hash: -1, postings: null }));
        let songs = new Uint32Array(1024);
        let times = new Uint32Array(1024);
        const sorted = new PostingSorter();

        for (;;) {
            let hash = Infinity;
            for (const cursor of cursors) if (cursor.postings && cursor.hash < hash) hash = cursor.hash;
            if (hash === Infinity) break;

            // Gather this hash's postings from every input that has it, skipping deleted songs
            let n = 0;
            let runs = 0;
            for (const cursor of cursors) {
                if (!cursor.postings || cursor.hash !== hash) continue;
                const p = cursor.postings;
                if (n + p.n > songs.length) {
                    const size = Math.max(songs.length * 2, n + p.n);
                    const grownSongs = new Uint32Array(size); grownSongs.set(songs.subarray(0, n)); songs = grownSongs;
                    const grownTimes = new Uint32Array(size); grownTimes.set(times.subarray(0, n)); times = grownTimes;
                }
                for (let k = 0; k < p.n; k++) {
                    if (deletedSongs.has(p.songs[k]!)) continue;
                    songs[n] = p.songs[k]!;
                    times[n] = p.times[k]!;
                    n++;
                }
                runs++;
                advance(cursor);
            }
            // Each input is sorted by (song, t); several inputs need sorting together
            if (runs > 1) sorted.sort(songs, times, n);
            writer.add(hash, runs > 1 ? sorted.songs : songs, runs > 1 ? sorted.times : times, n);
        }
        return { writer, stats: writer.finish() };
    } catch (error) {
        writer.abort();
        throw error;
    }
}

function advance(cursor: Cursor): Cursor {
    const next = cursor.entries.next();
    if (next.done) {
        cursor.postings = null;
    } else {
        cursor.hash = next.value.hash;
        cursor.postings = next.value.postings;
    }
    return cursor;
}

// Sorts postings by (song, t) into reusable buffers (merges sort millions of small lists)
class PostingSorter {
    songs = new Uint32Array(1024);
    times = new Uint32Array(1024);
    private order = new Uint32Array(1024);

    sort(songs: Uint32Array, times: Uint32Array, n: number): void {
        if (n > this.order.length) {
            const size = Math.max(n, this.order.length * 2);
            this.songs = new Uint32Array(size);
            this.times = new Uint32Array(size);
            this.order = new Uint32Array(size);
        }
        const order = this.order.subarray(0, n);
        for (let i = 0; i < n; i++) order[i] = i;
        order.sort((a, b) => songs[a]! - songs[b]! || times[a]! - times[b]!);
        for (let i = 0; i < n; i++) {
            this.songs[i] = songs[order[i]!]!;
            this.times[i] = times[order[i]!]!;
        }
    }
}
