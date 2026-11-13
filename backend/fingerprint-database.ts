import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Fingerprint } from '../engine/index.js';

export type OffsetVote = { songId: number; offset: number; score: number };

// SQLite storage: songs + hashes. The hashes table is keyed by hash so lookups
// are an index seek; WITHOUT ROWID keeps it to a single b-tree.
export class FingerprintDatabase {
    private readonly db: DatabaseSync;
    private readonly voteStatement: StatementSync;

    constructor(file: string) {
        // serve and a fetch can share the file: wait for the other's write lock instead of failing
        this.db = new DatabaseSync(file, { timeout: 60_000 });
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;   -- safe with WAL, much faster commits
            PRAGMA journal_size_limit = 67108864; -- shrink the -wal file back to 64 MB after each checkpoint
            PRAGMA cache_size = -262144;   -- 256 MB page cache: inserts into a huge hash index stay fast
            CREATE TABLE IF NOT EXISTS songs (
                id   INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS hashes (
                hash    INTEGER NOT NULL,
                song_id INTEGER NOT NULL,
                t       INTEGER NOT NULL,
                PRIMARY KEY (hash, song_id, t)
            ) WITHOUT ROWID;
            -- Staging area: new songs' hashes are appended here (no index, so ~0.1 s per song
            -- instead of ~20 s of random b-tree writes) and moved into hashes in one sorted
            -- batch by mergePending(). Matching only sees hashes, so merge before matching.
            CREATE TABLE IF NOT EXISTS pending_hashes (
                hash    INTEGER NOT NULL,
                song_id INTEGER NOT NULL,
                t       INTEGER NOT NULL
            );
        `);
        // Voting runs inside SQLite (C), not in JS: for every clip hash, find where it occurs
        // in the library and count rows per (song, offset = dbTime - clipTime).
        // Hashes occurring more than :maxOccurrences times are skipped as "stop words": they
        // appear in thousands of songs, so they cost the most time and identify nothing.
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
            ORDER BY score DESC
            LIMIT :limit
        `);
    }

    hasSong(name: string): boolean {
        return this.db.prepare('SELECT 1 FROM songs WHERE name = ?').get(name) !== undefined;
    }

    // One transaction per song: a crash never leaves a half-indexed song behind.
    // replace = true swaps out an existing song of the same name (e.g. its 30 s preview).
    addSong(name: string, prints: Fingerprint[], replace = false): void {
        this.db.exec('BEGIN');
        try {
            const old = replace
                ? this.db.prepare('SELECT id FROM songs WHERE name = ?').get(name) as { id: number } | undefined
                : undefined;
            if (old) {
                // ponytail: full scan (no index on song_id), ~seconds per replaced song; add an index if replacements get frequent
                this.db.prepare('DELETE FROM hashes WHERE song_id = ?').run(old.id);
                this.db.prepare('DELETE FROM pending_hashes WHERE song_id = ?').run(old.id);
                this.db.prepare('DELETE FROM songs WHERE id = ?').run(old.id);
            }
            const { lastInsertRowid: songId } = this.db.prepare('INSERT INTO songs (name) VALUES (?)').run(name);
            const insert = this.db.prepare('INSERT INTO pending_hashes VALUES (?, ?, ?)');
            for (const { hash, t } of prints) insert.run(hash, songId, t);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    // Moves staged hashes into the searchable table. Sorted by key, so the b-tree is written
    // in order instead of at random. Returns how many hashes were moved (0 = nothing staged).
    mergePending(): number {
        if (this.db.prepare('SELECT 1 FROM pending_hashes LIMIT 1').get() === undefined) return 0;

        this.db.exec('BEGIN');
        try {
            const { changes } = this.db.prepare(`
                INSERT OR IGNORE INTO hashes
                SELECT hash, song_id, t FROM pending_hashes ORDER BY hash, song_id, t
            `).run();
            this.db.exec('DELETE FROM pending_hashes');
            this.db.exec('COMMIT');
            return Number(changes);
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    // The strongest (song, offset) vote piles for a clip, best first
    topVotes(prints: Fingerprint[], maxOccurrences: number, limit: number): OffsetVote[] {
        // Staged songs are NOT merged here: merging into the big index takes minutes and would block
        // every request while a fetch keeps staging. The CLI merges at serve start / end of a fetch.
        const clip = JSON.stringify(prints.map(p => [p.hash, p.t]));
        return this.voteStatement.all({ clip, maxOccurrences, limit }) as OffsetVote[];
    }

    songName(id: number): string {
        return (this.db.prepare('SELECT name FROM songs WHERE id = ?').get(id) as { name: string }).name;
    }

    songCount(): number {
        return (this.db.prepare('SELECT COUNT(*) AS n FROM songs').get() as { n: number }).n;
    }

    close(): void {
        this.db.close();
    }
}
