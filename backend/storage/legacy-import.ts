import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Fingerprint } from '../../engine/index.js';
import type { FingerprintIndex, OffsetVote } from './fingerprint-index.js';

type Row = [hash: number, songId: number, t: number];

// Schema of the previous single-file store (fingerprints.db). Only used to read it, and by
// tests to build small files in that format.
export const LEGACY_SCHEMA = `
    CREATE TABLE songs (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE hashes (
        hash INTEGER NOT NULL, song_id INTEGER NOT NULL, t INTEGER NOT NULL,
        PRIMARY KEY (hash, song_id, t)
    ) WITHOUT ROWID;
    CREATE TABLE pending_hashes (hash INTEGER NOT NULL, song_id INTEGER NOT NULL, t INTEGER NOT NULL);
`;

// Read-only view of a legacy fingerprints.db. Opened with SQLITE_OPEN_READONLY, so SQLite
// itself refuses any write to the file. Matching only ever saw the `hashes` table; `pending_hashes`
// held staged songs that a later merge would have added (INSERT OR IGNORE).
export class LegacyStore {
    private readonly db: DatabaseSync;
    private readonly voteStatement: StatementSync;
    private readonly hasPendingTable: boolean;

    constructor(file: string) {
        if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
        this.db = new DatabaseSync(file, { readOnly: true });
        const tables = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(r => r.name));
        if (!tables.has('songs') || !tables.has('hashes')) throw new Error(`${file} is not a fingerprints database`);
        this.hasPendingTable = tables.has('pending_hashes');

        // The previous store's voting query, verbatim apart from a deterministic tie order
        this.voteStatement = this.db.prepare(`
            WITH clip(hash, t) AS (
                SELECT value ->> 0, value ->> 1 FROM json_each(:clip)
            ),
            distinctive AS (
                SELECT hash, t FROM clip
                WHERE (SELECT COUNT(*) FROM (
                    SELECT 1 FROM hashes AS h WHERE h.hash = clip.hash LIMIT :maxOccurrences + 1
                )) <= :maxOccurrences
            )
            SELECT h.song_id AS songId, h.t - distinctive.t AS offset, COUNT(*) AS score
            FROM distinctive CROSS JOIN hashes AS h ON h.hash = distinctive.hash
            GROUP BY h.song_id, offset
            ORDER BY score DESC, songId, offset
            LIMIT :limit
        `);
    }

    topVotes(prints: readonly Fingerprint[], maxOccurrences: number, limit: number): OffsetVote[] {
        const clip = JSON.stringify(prints.map(p => [p.hash, p.t]));
        return (this.voteStatement.all({ clip, maxOccurrences, limit }) as OffsetVote[])
            .map(({ songId, offset, score }) => ({ songId, offset, score }));
    }

    songs(): { id: number; name: string }[] {
        return this.db.prepare('SELECT id, name FROM songs ORDER BY id').all() as { id: number; name: string }[];
    }

    // Primary-key order: a sequential scan of the b-tree, no sorting
    hashesSorted(): Iterable<Row> {
        return this.rows('SELECT hash, song_id, t FROM hashes ORDER BY hash, song_id, t');
    }

    pendingSorted(): Iterable<Row> {
        return this.hasPendingTable ? this.rows('SELECT hash, song_id, t FROM pending_hashes ORDER BY hash, song_id, t') : [];
    }

    // Distinct (hash, song, t) per song over both tables: what a final merge would have stored
    postingsPerSong(): Map<number, number> {
        const counts = new Map<number, number>();
        const add = (sql: string) => {
            for (const { songId, n } of this.db.prepare(sql).iterate() as Iterable<{ songId: number; n: number }>) {
                counts.set(songId, (counts.get(songId) ?? 0) + n);
            }
        };
        add('SELECT song_id AS songId, COUNT(*) AS n FROM hashes GROUP BY song_id');
        if (this.hasPendingTable) {
            add(`SELECT song_id AS songId, COUNT(*) AS n FROM (
                     SELECT DISTINCT hash, song_id, t FROM pending_hashes
                     EXCEPT SELECT hash, song_id, t FROM hashes
                 ) GROUP BY song_id`);
        }
        return counts;
    }

    close(): void {
        if (this.db.isOpen) this.db.close();
    }

    private *rows(sql: string): Generator<Row> {
        const statement = this.db.prepare(sql);
        statement.setReturnArrays(true);
        yield* statement.iterate() as Iterable<Row>;
    }
}

export type ImportOptions = {
    maxOccurrences: number;     // matching settings used for the equivalence check
    voteCandidates: number;
    sampleClips?: number;       // how many clips to compare old vs new voting on
    log?: (message: string) => void;
};

export type ImportReport = {
    songs: number;
    postings: number;
    segments: number;
    clipsCompared: number;
    sha256: Record<string, string>;
};

// Builds the segment index from a legacy fingerprints.db without modifying it:
//   1. hashes the legacy file(s) (SHA-256)
//   2. songs (ids kept) + `hashes` → segment 1, in one transaction
//   3. compares voting old vs new on sample clips — exact equality required
//   4. `pending_hashes` (staged songs) → segment 2
//   5. compares postings per song over both tables, and the file hashes again
// Any mismatch throws. The target index must be empty.
export async function importLegacy(legacyFile: string, index: FingerprintIndex, options: ImportOptions): Promise<ImportReport> {
    const log = options.log ?? (() => {});
    if (index.songCount() > 0 || index.stats().segments.length > 0 || index.stats().pendingPostings > 0) {
        throw new Error('The target index is not empty: import only into a new index');
    }
    const files = [legacyFile, `${legacyFile}-wal`].filter(f => fs.existsSync(f));
    checkFreeSpace(index.dir, fs.statSync(legacyFile).size / 2);

    log(`Hashing ${files.join(', ')} (proof that the import leaves it unchanged)...`);
    const before = await sha256(files);

    const legacy = new LegacyStore(legacyFile);
    try {
        const songs = legacy.songs();
        const sample = sampleSongs(songs.map(s => s.id), options.sampleClips ?? 200);
        const clips = new Map<number, Fingerprint[]>();

        log(`Importing ${songs.length} songs and their indexed hashes...`);
        let postings = index.bulkImport(songs, collectClips(legacy.hashesSorted(), sample, clips));

        log(`Comparing old and new matching on ${clips.size} clips...`);
        for (const [songId, clip] of clips) {
            const expected = legacy.topVotes(clip, options.maxOccurrences, options.voteCandidates);
            const actual = index.topVotes(clip, options.maxOccurrences, options.voteCandidates);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw new Error(`Votes differ for a clip of song ${songId}: the import is not equivalent`);
            }
        }

        log('Importing staged (not yet merged) hashes...');
        postings += index.bulkImport([], legacy.pendingSorted());

        log('Comparing postings per song...');
        const expectedCounts = legacy.postingsPerSong();
        const actualCounts = index.countPostingsBySong();
        for (const id of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
            if (expectedCounts.get(id) !== actualCounts.get(id)) {
                throw new Error(`Song ${id}: ${expectedCounts.get(id) ?? 0} postings before, ${actualCounts.get(id) ?? 0} after`);
            }
        }

        legacy.close();
        log('Hashing the legacy file(s) again...');
        const after = await sha256(files);
        for (const file of files) {
            if (before[file] !== after[file]) throw new Error(`${file} changed during the import`);
        }
        return { songs: songs.length, postings, segments: index.stats().segments.length, clipsCompared: clips.size, sha256: after };
    } finally {
        legacy.close();
    }
}

// Passes rows through, keeping a ~7 s window (300 frames) of each sampled song as a test clip
function* collectClips(rows: Iterable<Row>, sample: ReadonlySet<number>, clips: Map<number, Fingerprint[]>): Generator<Row> {
    const from = 200;
    const to = 500;
    for (const row of rows) {
        const [hash, songId, t] = row;
        if (t >= from && t < to && sample.has(songId)) {
            const clip = clips.get(songId);
            if (clip) clip.push({ hash, t: t - from }); else clips.set(songId, [{ hash, t: t - from }]);
        }
        yield row;
    }
}

// Deterministic sample (same songs on every run)
function sampleSongs(ids: number[], count: number): Set<number> {
    let state = 12345;
    const shuffled = [...ids];
    for (let i = shuffled.length - 1; i > 0; i--) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const j = state % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return new Set(shuffled.slice(0, count));
}

function checkFreeSpace(dir: string, neededBytes: number): void {
    const { bavail, bsize } = fs.statfsSync(dir);
    const free = bavail * bsize;
    if (free < neededBytes) {
        throw new Error(`Not enough free disk space: ${(free / 1e9).toFixed(1)} GB free, about ${(neededBytes / 1e9).toFixed(1)} GB needed`);
    }
}

async function sha256(files: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const file of files) {
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) hash.update(chunk as Buffer);
        out[file] = hash.digest('hex');
    }
    return out;
}
