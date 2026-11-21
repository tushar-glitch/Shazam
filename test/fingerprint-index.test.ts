import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Fingerprint } from '../engine/index.js';
import { BackgroundCompactor } from '../backend/storage/compaction.js';
import { FingerprintIndex, type IndexOptions } from '../backend/storage/fingerprint-index.js';
import { LEGACY_SCHEMA, LegacyStore } from '../backend/storage/legacy-import.js';
import { randomPrints, rng, tempDir } from './helpers.js';

const manual: IndexOptions = { flushPostings: 1e12, flushIntervalMs: 1e12, mergeFactor: 3 };

// A clip: a window of a song's prints moved to start at 0, plus unrelated noise prints
function clipOf(prints: Fingerprint[], from: number, to: number, random: () => number, noise = 50): Fingerprint[] {
    return [
        ...prints.filter(p => p.t >= from && p.t < to).map(p => ({ hash: p.hash, t: p.t - from })),
        ...randomPrints(random, noise, 5000, to - from),
    ];
}

describe('FingerprintIndex', () => {
    let dir: string;
    let cleanup: () => void;
    const open: FingerprintIndex[] = [];
    const index = (options: IndexOptions = manual) => {
        const opened = FingerprintIndex.open(path.join(dir, 'index'), options);
        open.push(opened);
        return opened;
    };
    beforeEach(() => ({ dir, cleanup } = tempDir()));
    afterEach(() => {
        for (const i of open.splice(0)) i.close();
        cleanup();
    });

    it('makes songs searchable once flushed', () => {
        const random = rng(1);
        const songs = [randomPrints(random, 3000), randomPrints(random, 3000)];
        const db = index();
        const ids = songs.map((prints, i) => db.addSong(`Song ${i}`, prints));
        const clip = clipOf(songs[1]!, 500, 800, random);

        assert.deepEqual(db.topVotes(clip, 1000, 10), [], 'not searchable before flush');
        assert.ok(db.flush() > 0);
        const [best] = db.topVotes(clip, 1000, 10);
        assert.equal(best?.songId, ids[1]);
        assert.equal(best?.offset, 500);
        assert.equal(db.songName(ids[1]!), 'Song 1');
        assert.equal(db.songCount(), 2);
        assert.ok(db.hasSong('Song 0') && !db.hasSong('Song 9'));
    });

    it('votes exactly like the previous SQLite store', () => {
        const random = rng(42);
        const legacyFile = path.join(dir, 'legacy.db');
        const legacy = new DatabaseSync(legacyFile);
        legacy.exec(LEGACY_SCHEMA);
        legacy.exec('BEGIN'); // one transaction: autocommit would fsync every insert
        const insertSong = legacy.prepare('INSERT INTO songs (id, name) VALUES (?, ?)');
        const insertHash = legacy.prepare('INSERT OR IGNORE INTO hashes VALUES (?, ?, ?)');

        const db = index();
        const library = new Map<number, Fingerprint[]>();
        const add = (name: string, prints: Fingerprint[], replace = false) => {
            const id = db.addSong(name, prints, replace);
            if (replace) {
                const old = [...library.keys()].find(k => legacy.prepare('SELECT 1 FROM songs WHERE id = ? AND name = ?').get(k, name));
                legacy.prepare('DELETE FROM hashes WHERE song_id = ?').run(old!);
                legacy.prepare('DELETE FROM songs WHERE id = ?').run(old!);
                library.delete(old!);
            }
            insertSong.run(id, name);
            for (const p of prints) insertHash.run(p.hash, id, p.t);
            library.set(id, prints);
        };

        // Several segments, a merge, and replaced songs (tombstones), so every read path is exercised
        for (let i = 0; i < 12; i++) add(`S${i}`, randomPrints(random, 2500, 3000));
        db.flush();
        for (let i = 12; i < 24; i++) add(`S${i}`, randomPrints(random, 2500, 3000));
        db.flush();
        add('S3', randomPrints(random, 2500, 3000), true);
        add('S30', randomPrints(random, 2500, 3000));
        db.flush();
        assert.ok(db.compactOnce(), 'three segments trigger a merge');
        add('S7', randomPrints(random, 2500, 3000), true);
        db.flush();
        legacy.exec('COMMIT');
        legacy.close();

        const reference = new LegacyStore(legacyFile);
        let compared = 0;
        for (const [, prints] of library) {
            const start = Math.floor(random() * 1500);
            const clip = clipOf(prints, start, start + 400, random);
            for (const maxOccurrences of [3, 8, 1000]) {
                for (const limit of [1, 5, 200]) {
                    assert.deepEqual(db.topVotes(clip, maxOccurrences, limit), reference.topVotes(clip, maxOccurrences, limit));
                    compared++;
                }
            }
        }
        reference.close();
        assert.equal(compared, library.size * 9);
    });

    it('rejects duplicate names unless replacing, and invalid input', () => {
        const db = index();
        db.addSong('A', [{ hash: 1, t: 1 }]);
        assert.throws(() => db.addSong('A', [{ hash: 1, t: 2 }]), /already indexed/);
        assert.throws(() => db.addSong('B', [{ hash: 1, t: 2 ** 22 }]), RangeError);
        assert.throws(() => db.addSong('C', [{ hash: -1, t: 0 }]), RangeError);
        assert.equal(db.songCount(), 1, 'failed adds leave nothing behind');
        assert.throws(() => db.topVotes([{ hash: 1, t: -1 }], 10, 10), RangeError);
    });

    it('hides replaced songs and drops them for good once everything is merged', () => {
        const random = rng(5);
        const old = randomPrints(random, 2000);
        const db = index();
        const oldId = db.addSong('A', old);
        db.addSong('B', randomPrints(random, 2000));
        db.flush();
        const newId = db.addSong('A', randomPrints(random, 2000), true);
        db.flush();

        const clip = clipOf(old, 100, 500, random, 0);
        assert.ok(db.topVotes(clip, 1000, 200).every(v => v.songId !== oldId));
        assert.equal(db.countPostingsBySong().has(oldId), false);
        assert.equal(db.songCount(), 2);

        db.addSong('C', randomPrints(random, 10));
        db.flush();
        assert.ok(db.compactOnce());
        const { segments } = db.stats();
        assert.equal(segments.length, 1);
        // The merged segment no longer holds the replaced song's postings at all
        assert.equal(segments[0]!.postings, [...db.countPostingsBySong().values()].reduce((a, b) => a + b, 0));
        assert.ok(db.countPostingsBySong().has(newId));
    });

    it('recovers songs a writer never flushed (crash, Ctrl+C)', () => {
        const random = rng(9);
        const prints = randomPrints(random, 2000);
        const crashed = index();
        crashed.addSong('Unflushed', prints);
        // No flush, no close: the next opener finds the song in the write-ahead log
        const next = index();
        const [best] = next.topVotes(clipOf(prints, 0, 400, random), 1000, 5);
        assert.equal(next.songName(best!.songId), 'Unflushed');
    });

    it('cleans up files a crashed writer left behind, but not a live writer\'s', () => {
        index().close();
        open.pop();
        const indexDir = path.join(dir, 'index');
        const deadPid = 2 ** 30; // no such process
        fs.writeFileSync(path.join(indexDir, 'seg-orphan.seg'), 'x');
        fs.writeFileSync(path.join(indexDir, `seg-a.seg.${deadPid}.tmp`), 'x');
        fs.writeFileSync(path.join(indexDir, `seg-b.seg.${process.pid}.tmp`), 'x');
        index();
        const left = fs.readdirSync(indexDir).filter(f => f.startsWith('seg-'));
        assert.deepEqual(left, [`seg-b.seg.${process.pid}.tmp`]);
    });

    it('sees segments flushed by another open instance (another process)', () => {
        const random = rng(3);
        const prints = randomPrints(random, 2000);
        const reader = index();
        const writer = index();
        assert.deepEqual(reader.topVotes(prints.slice(0, 200), 1000, 5), []);
        writer.addSong('Fresh', prints);
        writer.flush();
        assert.equal(reader.songName(reader.topVotes(prints.slice(0, 200), 1000, 5)[0]!.songId), 'Fresh');
        writer.compactOnce(); // nothing to merge yet; must not disturb the reader
        assert.equal(reader.topVotes(prints.slice(0, 200), 1000, 5).length > 0, true);
    });

    it('flushes by size and by time', () => {
        const random = rng(4);
        const bySize = index({ ...manual, flushPostings: 3000 });
        bySize.addSong('A', randomPrints(random, 2000));
        assert.equal(bySize.stats().segments.length, 0);
        bySize.addSong('B', randomPrints(random, 2000));
        assert.equal(bySize.stats().segments.length, 1);
        assert.equal(bySize.stats().pendingPostings, 0);

        const byTime = FingerprintIndex.open(path.join(dir, 'timed'), { ...manual, flushIntervalMs: 0 });
        open.push(byTime);
        byTime.addSong('A', randomPrints(random, 10));
        assert.equal(byTime.stats().segments.length, 1);
    });

    it('merges in the background on a worker thread', async () => {
        const random = rng(8);
        const db = index();
        const clip = randomPrints(random, 300);
        for (let i = 0; i < 3; i++) {
            db.addSong(`S${i}`, i === 1 ? clip : randomPrints(random, 1000));
            db.flush();
        }
        const before = db.topVotes(clip, 1000, 20);

        const compactor = new BackgroundCompactor({ dir: db.dir, options: manual });
        compactor.request();
        compactor.request(); // coalesced with the running merge
        await compactor.close();

        assert.equal(db.stats().segments.length, 1);
        assert.deepEqual(db.topVotes(clip, 1000, 20), before);
        assert.deepEqual(fs.readdirSync(db.dir).filter(f => f.endsWith('.seg')).length, 1, 'merged inputs are deleted');
    });
});
