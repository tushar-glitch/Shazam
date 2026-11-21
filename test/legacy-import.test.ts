import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FingerprintIndex } from '../backend/storage/fingerprint-index.js';
import { importLegacy, LEGACY_SCHEMA, LegacyStore } from '../backend/storage/legacy-import.js';
import { randomPrints, rng, tempDir } from './helpers.js';

const options = { flushPostings: 1e12, flushIntervalMs: 1e12, mergeFactor: 10 };
const matching = { maxOccurrences: 50, voteCandidates: 200, sampleClips: 20 };

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('legacy import', () => {
    let dir: string;
    let cleanup: () => void;
    let legacyFile: string;
    beforeEach(() => {
        ({ dir, cleanup } = tempDir());
        // A small fingerprints.db in the previous format: merged songs, staged songs, a gap in ids
        legacyFile = path.join(dir, 'fingerprints.db');
        const db = new DatabaseSync(legacyFile);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(LEGACY_SCHEMA);
        db.exec('BEGIN'); // one transaction: autocommit would fsync every insert
        const random = rng(21);
        for (const id of [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
            db.prepare('INSERT INTO songs (id, name) VALUES (?, ?)').run(id, `Artist - Song ${id}`);
            const table = id <= 9 ? 'hashes' : 'pending_hashes';
            const insert = db.prepare(`INSERT ${table === 'hashes' ? 'OR IGNORE ' : ''}INTO ${table} VALUES (?, ?, ?)`);
            for (const p of randomPrints(random, 3000, 4000, 1300)) insert.run(p.hash, id, p.t);
        }
        db.exec('COMMIT');
        db.close();
    });
    afterEach(() => cleanup());

    it('copies everything, proves equivalence and leaves the old file untouched', async () => {
        const before = digest(legacyFile);
        const index = FingerprintIndex.open(path.join(dir, 'index'), options);
        const report = await importLegacy(legacyFile, index, matching);

        assert.equal(report.songs, 12);
        assert.equal(report.segments, 2);
        assert.ok(report.clipsCompared > 0);
        assert.equal(index.songName(5), 'Artist - Song 5', 'song ids are kept');
        assert.equal(index.songName(13), 'Artist - Song 13');
        assert.equal(digest(legacyFile), before);
        assert.equal(report.sha256[legacyFile], before);

        // Matching the staged songs works too (the old store only did so after a merge)
        const legacy = new LegacyStore(legacyFile);
        const counts = legacy.postingsPerSong();
        legacy.close();
        assert.deepEqual(index.countPostingsBySong(), counts);
        assert.equal(report.postings, [...counts.values()].reduce((a, b) => a + b, 0));

        // New songs continue after the highest imported id
        assert.equal(index.addSong('New', [{ hash: 1, t: 1 }]), 14);
        index.close();
        assert.equal(digest(legacyFile), before);
    });

    it('refuses to import into an index that already has songs', async () => {
        const index = FingerprintIndex.open(path.join(dir, 'index'), options);
        index.addSong('Existing', [{ hash: 1, t: 1 }]);
        await assert.rejects(importLegacy(legacyFile, index, matching), /not empty/);
        index.close();
    });

    it('opens the old file read-only', () => {
        const legacy = new LegacyStore(legacyFile);
        assert.throws(() => (legacy as unknown as { db: DatabaseSync }).db.exec('DELETE FROM songs'), /readonly/i);
        legacy.close();
    });
});
