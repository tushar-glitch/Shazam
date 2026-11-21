import fs from 'node:fs';
import path from 'node:path';
import type { Fingerprint } from '../../engine/index.js';
import { Catalog, CATALOG_FILE, type SegmentRow } from './catalog.js';
import { compactOnce, newSegmentName } from './compaction.js';
import type { MergePolicyOptions } from './merge-policy.js';
import { SEGMENT_EXTENSION } from './segment-format.js';
import { SegmentReader } from './segment-reader.js';
import { SegmentWriter } from './segment-writer.js';

export type OffsetVote = { songId: number; offset: number; score: number };

export type IndexOptions = MergePolicyOptions & {
    flushIntervalMs: number;        // flush the write-ahead log at least this often while songs arrive
    onFlush?: () => void;           // e.g. BackgroundCompactor.request
};

export type IndexStats = { songs: number; pendingPostings: number; segments: SegmentRow[] };

// Time values are packed with the song id into one number for vote counting, so they are bounded
export const MAX_TIME = 2 ** 22; // frames: ~27 h at 23 ms per frame
const MAX_SONG_ID = 2 ** 30;
// Vote key = song · VOTE_SPAN + (offset + MAX_TIME); offsets lie in (-MAX_TIME, MAX_TIME), keys stay below 2^53
const VOTE_SPAN = 2 * MAX_TIME;

// Inverted index of fingerprint hashes, stored as immutable segment files plus a SQLite
// catalog (see docs/index-format.md):
//   addSong  → song row + fingerprints appended to the write-ahead log (one transaction)
//   flush    → write-ahead log sorted into a new segment (on size, on time, on close)
//   topVotes → searches every live segment; picks up other processes' flushes automatically
//   compaction (see compaction.ts) merges small segments into bigger ones in the background
// Several processes may open the same index (e.g. `serve` while a fetch is running).
export class FingerprintIndex {
    private readonly catalog: Catalog;
    private readonly readers = new Map<string, SegmentReader>();
    private deleted = new Set<number>();
    private seenVersion = -1;
    private stale = true;
    private pendingPostings: number;
    private lastFlush = Date.now();

    private constructor(readonly dir: string, private readonly options: IndexOptions) {
        fs.mkdirSync(dir, { recursive: true });
        this.catalog = new Catalog(path.join(dir, CATALOG_FILE));
        try {
            this.recover();
            this.pendingPostings = this.catalog.pendingCount();
            // A writer that stopped before flushing (Ctrl+C, crash) left songs in the log
            if (this.pendingPostings > 0) this.flush();
        } catch (error) {
            this.catalog.close();
            throw error;
        }
    }

    static open(dir: string, options: IndexOptions): FingerprintIndex {
        return new FingerprintIndex(dir, options);
    }

    static exists(dir: string): boolean {
        return fs.existsSync(path.join(dir, CATALOG_FILE));
    }

    // Stores a song. replace = true swaps out an existing song of the same name; otherwise a
    // duplicate name is an error. The song is durable on return and searchable after the next flush.
    addSong(name: string, prints: readonly Fingerprint[], replace = false): number {
        for (const { hash, t } of prints) {
            if (!Number.isInteger(hash) || hash < 0 || hash > 0xffffffff) throw new RangeError(`invalid hash ${hash}`);
            if (!Number.isInteger(t) || t < 0 || t >= MAX_TIME) throw new RangeError(`invalid time ${t}`);
        }
        const songId = this.catalog.writeTransaction(() => {
            const existing = this.catalog.findSong(name);
            if (existing !== undefined) {
                if (!replace) throw new Error(`Song "${name}" is already indexed`);
                this.catalog.deleteSong(existing);
                this.stale = true;
            }
            const id = this.catalog.insertSong(name);
            if (id >= MAX_SONG_ID) throw new RangeError(`song id ${id} exceeds the supported range`);
            this.catalog.appendPending(id, prints);
            return id;
        });

        this.pendingPostings += prints.length;
        if (this.pendingPostings >= this.options.flushPostings || Date.now() - this.lastFlush >= this.options.flushIntervalMs) {
            this.flush();
        }
        return songId;
    }

    // Turns the write-ahead log into a new segment. Returns the number of postings written.
    // Runs under the write lock, so it is safe with other writers on the same index.
    flush(): number {
        const file = newSegmentName();
        const written = this.catalog.writeTransaction(() => {
            const postings = this.writeSegment(file, this.catalog.pendingSorted());
            this.catalog.clearPending();
            return postings;
        });

        this.pendingPostings = 0;
        this.lastFlush = Date.now();
        if (written > 0) {
            this.stale = true;
            this.options.onFlush?.();
        }
        return written;
    }

    // Loads songs with fixed ids plus their fingerprints as one new segment, in one transaction.
    // rows must be sorted by (hash, song, t). Used to import an existing library in bulk without
    // going through the write-ahead log. Returns the number of postings written.
    bulkImport(songs: readonly { id: number; name: string }[], rows: Iterable<readonly [number, number, number]>): number {
        const written = this.catalog.writeTransaction(() => {
            for (const { id, name } of songs) {
                if (id >= MAX_SONG_ID) throw new RangeError(`song id ${id} exceeds the supported range`);
                this.catalog.insertSong(name, id);
            }
            return this.writeSegment(newSegmentName(), rows);
        });
        this.stale = true;
        return written;
    }

    // Postings per song across all segments (full scan; for verification and diagnostics)
    countPostingsBySong(): Map<number, number> {
        this.refresh();
        const counts = new Map<number, number>();
        for (const file of this.readers.keys()) {
            const reader = SegmentReader.open(path.join(this.dir, file)); // own reader: entries() reuses buffers
            try {
                for (const { postings } of reader.entries()) {
                    for (let k = 0; k < postings.n; k++) {
                        const song = postings.songs[k]!;
                        if (!this.deleted.has(song)) counts.set(song, (counts.get(song) ?? 0) + 1);
                    }
                }
            } finally {
                reader.close();
            }
        }
        return counts;
    }

    // One merge step in the calling thread (the CLI uses BackgroundCompactor instead)
    compactOnce(): boolean {
        const merged = compactOnce(this.dir, this.catalog, this.options);
        if (merged) this.stale = true;
        return merged;
    }

    hasSong(name: string): boolean {
        return this.catalog.findSong(name) !== undefined;
    }

    songName(id: number): string {
        const name = this.catalog.songName(id);
        if (name === undefined) throw new Error(`Unknown song id ${id}`);
        return name;
    }

    songCount(): number {
        return this.catalog.songCount();
    }

    stats(): IndexStats {
        return { songs: this.catalog.songCount(), pendingPostings: this.catalog.pendingCount(), segments: this.catalog.segments() };
    }

    // The strongest (song, offset) vote piles for a clip, best first (ties: lower song id, then
    // lower offset). For every clip hash that occurs at most maxOccurrences times in the index,
    // every occurrence votes for (song, its time - the clip's time).
    topVotes(prints: readonly Fingerprint[], maxOccurrences: number, limit: number): OffsetVote[] {
        this.refresh();
        const segments = [...this.readers.values()];
        const deleted = this.deleted;

        // Clip times per hash; duplicates are kept and each one votes
        const clipTimes = new Map<number, number[]>();
        for (const { hash, t } of prints) {
            if (!Number.isInteger(t) || t < 0 || t >= MAX_TIME) throw new RangeError(`invalid clip time ${t}`);
            const times = clipTimes.get(hash);
            if (times) times.push(t); else clipTimes.set(hash, [t]);
        }

        const votes = new Map<number, number>();
        const keyIndex = new Int32Array(segments.length);
        for (const [hash, times] of clipTimes) {
            let total = 0;
            for (let s = 0; s < segments.length; s++) {
                const i = segments[s]!.find(hash);
                keyIndex[s] = i;
                if (i >= 0) total += segments[s]!.counts[i]!;
            }
            if (total === 0) continue;
            // Stop words: too common to identify anything. Tombstoned postings do not count.
            if (total > maxOccurrences && deleted.size > 0) total = this.liveCount(segments, keyIndex, deleted);
            if (total > maxOccurrences) continue;

            for (let s = 0; s < segments.length; s++) {
                if (keyIndex[s]! < 0) continue;
                const { songs, times: dbTimes, n } = segments[s]!.postings(keyIndex[s]!);
                for (let k = 0; k < n; k++) {
                    const song = songs[k]!;
                    if (deleted.has(song)) continue;
                    const base = song * VOTE_SPAN + MAX_TIME + dbTimes[k]!; // (song, offset + MAX_TIME)
                    for (const clipT of times) {
                        const key = base - clipT;
                        votes.set(key, (votes.get(key) ?? 0) + 1);
                    }
                }
            }
        }
        return FingerprintIndex.strongest(votes, limit);
    }

    close(): void {
        try {
            if (this.catalog.pendingCount() > 0) this.flush();
        } finally {
            for (const reader of this.readers.values()) reader.close();
            this.readers.clear();
            this.catalog.close();
        }
    }

    // Writes sorted rows as a segment and registers it. Call inside a write transaction (the
    // rename and the catalog row must happen under one lock; see recover()). Returns postings written.
    private writeSegment(file: string, rows: Iterable<readonly [number, number, number]>): number {
        const writer = new SegmentWriter(path.join(this.dir, file));
        try {
            writer.addSortedRows(FingerprintIndex.checked(rows));
            if (writer.postings === 0) {
                writer.abort();
                return 0;
            }
            const stats = writer.finish();
            writer.publish();
            this.catalog.addSegment(file, stats);
            return stats.postings;
        } catch (error) {
            writer.abort();
            throw error;
        }
    }

    private static *checked(rows: Iterable<readonly [number, number, number]>): Generator<readonly [number, number, number]> {
        for (const row of rows) {
            if (row[1] >= MAX_SONG_ID || row[2] >= MAX_TIME) throw new RangeError(`row out of range: ${row.join(', ')}`);
            yield row;
        }
    }

    // Postings of non-deleted songs for one hash across segments
    private liveCount(segments: SegmentReader[], keyIndex: Int32Array, deleted: ReadonlySet<number>): number {
        let live = 0;
        for (let s = 0; s < segments.length; s++) {
            if (keyIndex[s]! < 0) continue;
            const { songs, n } = segments[s]!.postings(keyIndex[s]!);
            for (let k = 0; k < n; k++) if (!deleted.has(songs[k]!)) live++;
        }
        return live;
    }

    // Top `limit` piles in O(n): find the score threshold with a histogram, sort only those above it
    private static strongest(votes: Map<number, number>, limit: number): OffsetVote[] {
        if (limit <= 0 || votes.size === 0) return [];
        let maxScore = 0;
        for (const score of votes.values()) if (score > maxScore) maxScore = score;
        const histogram = new Uint32Array(maxScore + 1);
        for (const score of votes.values()) histogram[score]!++;
        let threshold = maxScore;
        for (let seen = histogram[maxScore]!; threshold > 1 && seen < limit;) seen += histogram[--threshold]!;

        const top: OffsetVote[] = [];
        for (const [key, score] of votes) {
            if (score < threshold) continue;
            const songId = Math.floor(key / VOTE_SPAN);
            top.push({ songId, offset: key - songId * VOTE_SPAN - MAX_TIME, score });
        }
        top.sort((a, b) => b.score - a.score || a.songId - b.songId || a.offset - b.offset);
        return top.slice(0, limit);
    }

    // Brings the open segments in line with the catalog when anything changed since last time
    private refresh(): void {
        const version = this.catalog.dataVersion();
        if (!this.stale && version === this.seenVersion) return;

        for (let attempt = 1; ; attempt++) {
            const { rows, deleted } = this.catalog.readTransaction(() => ({
                rows: this.catalog.segments(),
                deleted: this.catalog.deletedSongs(),
            }));
            try {
                for (const row of rows) {
                    if (!this.readers.has(row.file)) this.readers.set(row.file, SegmentReader.open(path.join(this.dir, row.file)));
                }
            } catch (error) {
                // A concurrent merge replaced (and deleted) a segment between reading the list and
                // opening it: read the list again
                if ((error as NodeJS.ErrnoException).code === 'ENOENT' && attempt < 5) continue;
                throw error;
            }
            const live = new Set(rows.map(r => r.file));
            for (const [file, reader] of this.readers) {
                if (!live.has(file)) {
                    reader.close();
                    this.readers.delete(file);
                }
            }
            this.deleted = deleted;
            break;
        }
        this.seenVersion = version;
        this.stale = false;
    }

    // Removes what a crashed writer left behind: segment files the catalog never registered and
    // temp files of processes that no longer run. Under the write lock, because writers publish
    // (rename) and register a segment inside one locked section.
    private recover(): void {
        this.catalog.writeTransaction(() => {
            const registered = new Set(this.catalog.segments().map(r => r.file));
            for (const entry of fs.readdirSync(this.dir)) {
                const tmp = /\.(\d+)\.tmp$/.exec(entry);
                const orphanSegment = entry.endsWith(SEGMENT_EXTENSION) && !registered.has(entry);
                if (orphanSegment || (tmp && !FingerprintIndex.isRunning(Number(tmp[1])))) {
                    fs.rmSync(path.join(this.dir, entry), { force: true });
                }
            }
        });
    }

    private static isRunning(pid: number): boolean {
        if (pid === process.pid) return true; // another thread of this process (compaction worker)
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
    }
}
