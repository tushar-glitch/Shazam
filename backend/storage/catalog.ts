import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Fingerprint } from '../../engine/index.js';
import type { SegmentStats } from './segment-writer.js';

export type SegmentRow = SegmentStats & { id: number; file: string };
export const CATALOG_FILE = 'catalog.db';

// Schema changes are applied in order; user_version records how many have run.
const MIGRATIONS: readonly string[] = [
    `
    CREATE TABLE songs (
        id   INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused: tombstones refer to old ids
        name TEXT NOT NULL UNIQUE
    );
    -- Songs removed (replace = true) whose postings may still sit in segments. Searches skip
    -- them; a merge drops their postings; a merge of every segment clears the tombstones.
    CREATE TABLE deleted_songs (id INTEGER PRIMARY KEY);
    CREATE TABLE segments (
        id         INTEGER PRIMARY KEY,
        file       TEXT NOT NULL UNIQUE,
        keys       INTEGER NOT NULL,
        postings   INTEGER NOT NULL,
        bytes      INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    -- Write-ahead log: fingerprints of songs not yet flushed into a segment. Appending here is
    -- cheap and durable; flush() turns it into a sorted segment.
    CREATE TABLE pending (
        song_id INTEGER NOT NULL,
        hash    INTEGER NOT NULL,
        t       INTEGER NOT NULL
    );
    `,
];

// The index's metadata in SQLite: songs, tombstones, the list of live segments and the
// write-ahead log. Every change that has to be atomic across these goes through
// writeTransaction(), which also serialises writers across processes (BEGIN IMMEDIATE).
export class Catalog {
    private readonly db: DatabaseSync;
    private readonly statements = new Map<string, StatementSync>();

    constructor(file: string) {
        // Readers and writers in other processes share the file: wait for locks instead of failing
        this.db = new DatabaseSync(file, { timeout: 60_000 });
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA journal_size_limit = 67108864;
        `);
        this.migrate();
    }

    writeTransaction<T>(work: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    // Consistent snapshot of several reads
    readTransaction<T>(work: () => T): T {
        this.db.exec('BEGIN');
        try {
            return work();
        } finally {
            this.db.exec('COMMIT');
        }
    }

    // Changes whenever ANOTHER connection commits (own commits do not change it)
    dataVersion(): number {
        return (this.sql('PRAGMA data_version').get() as { data_version: number }).data_version;
    }

    findSong(name: string): number | undefined {
        return (this.sql('SELECT id FROM songs WHERE name = ?').get(name) as { id: number } | undefined)?.id;
    }

    songName(id: number): string | undefined {
        return (this.sql('SELECT name FROM songs WHERE id = ?').get(id) as { name: string } | undefined)?.name;
    }

    songCount(): number {
        return (this.sql('SELECT COUNT(*) AS n FROM songs').get() as { n: number }).n;
    }

    insertSong(name: string, id?: number): number {
        const { lastInsertRowid } = id === undefined
            ? this.sql('INSERT INTO songs (name) VALUES (?)').run(name)
            : this.sql('INSERT INTO songs (id, name) VALUES (?, ?)').run(id, name);
        return Number(lastInsertRowid);
    }

    // Removes a song; its postings in existing segments are hidden by a tombstone
    deleteSong(id: number): void {
        this.sql('DELETE FROM songs WHERE id = ?').run(id);
        this.sql('INSERT OR IGNORE INTO deleted_songs (id) VALUES (?)').run(id);
        // ponytail: full scan of the (bounded, ≤ flushPostings rows) log; index song_id if replaces get frequent
        this.sql('DELETE FROM pending WHERE song_id = ?').run(id);
    }

    deletedSongs(): Set<number> {
        return new Set((this.sql('SELECT id FROM deleted_songs').all() as { id: number }[]).map(r => r.id));
    }

    clearDeleted(ids: Iterable<number>): void {
        const remove = this.sql('DELETE FROM deleted_songs WHERE id = ?');
        for (const id of ids) remove.run(id);
    }

    appendPending(songId: number, prints: readonly Fingerprint[]): void {
        const insert = this.sql('INSERT INTO pending (song_id, hash, t) VALUES (?, ?, ?)');
        for (const { hash, t } of prints) insert.run(songId, hash, t);
    }

    pendingCount(): number {
        return (this.sql('SELECT COUNT(*) AS n FROM pending').get() as { n: number }).n;
    }

    // [hash, songId, t] rows in index order
    *pendingSorted(): Generator<[number, number, number]> {
        const statement = this.db.prepare('SELECT hash, song_id, t FROM pending ORDER BY hash, song_id, t');
        statement.setReturnArrays(true);
        yield* statement.iterate() as Iterable<[number, number, number]>;
    }

    clearPending(): void {
        this.sql('DELETE FROM pending').run();
    }

    segments(): SegmentRow[] {
        return this.sql('SELECT id, file, keys, postings, bytes FROM segments ORDER BY id').all() as SegmentRow[];
    }

    addSegment(file: string, stats: SegmentStats): void {
        this.sql('INSERT INTO segments (file, keys, postings, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(file, stats.keys, stats.postings, stats.bytes, Date.now());
    }

    removeSegments(ids: readonly number[]): void {
        const remove = this.sql('DELETE FROM segments WHERE id = ?');
        for (const id of ids) remove.run(id);
    }

    close(): void {
        this.db.close();
    }

    private migrate(): void {
        const version = (this.sql('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (version > MIGRATIONS.length) {
            throw new Error(`Index catalog has schema version ${version}; this build supports up to ${MIGRATIONS.length}. Update the code.`);
        }
        if (version === MIGRATIONS.length) return;
        this.writeTransaction(() => {
            // Re-read under the lock: another process may have migrated meanwhile
            const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
            for (let v = current; v < MIGRATIONS.length; v++) this.db.exec(MIGRATIONS[v]!);
            this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
        });
    }

    private sql(text: string): StatementSync {
        let statement = this.statements.get(text);
        if (!statement) this.statements.set(text, statement = this.db.prepare(text));
        return statement;
    }
}
