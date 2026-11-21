import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Fingerprint } from '../engine/index.js';
import { selectMerge, tierOf } from '../backend/storage/merge-policy.js';
import { SegmentReader } from '../backend/storage/segment-reader.js';
import { mergeSegments } from '../backend/storage/segment-merger.js';
import { SegmentWriter } from '../backend/storage/segment-writer.js';
import { type PostingMap, postingMap, randomPrints, rng, tempDir } from './helpers.js';

describe('merge policy', () => {
    const options = { flushPostings: 100, mergeFactor: 4 };
    const sizes = (...postings: number[]) => postings.map((p, i) => ({ id: i + 1, postings: p }));

    it('assigns tiers by powers of the merge factor', () => {
        assert.deepEqual([1, 100, 101, 400, 401, 1600, 1601].map(p => tierOf(p, 100, 4)), [0, 0, 1, 1, 2, 2, 3]);
    });

    it('does nothing below the merge factor', () => {
        assert.equal(selectMerge(sizes(50, 60, 70), options), null);
        assert.equal(selectMerge([], options), null);
    });

    it('merges a full tier, smallest segments first', () => {
        assert.deepEqual(selectMerge(sizes(90, 10, 50, 30, 70), options)?.map(s => s.id), [2, 4, 3, 5]);
    });

    it('prefers the lowest full tier and ignores mixed tiers', () => {
        // tier 1: 200, 300, 350 (3 < 4); tier 0: four small ones
        assert.deepEqual(selectMerge(sizes(200, 300, 350, 5, 6, 7, 8), options)?.map(s => s.id), [4, 5, 6, 7]);
        assert.equal(selectMerge(sizes(200, 300, 350, 5, 6, 7), options), null);
    });

    it('rejects a merge factor below 2', () => {
        assert.throws(() => selectMerge([], { flushPostings: 1, mergeFactor: 1 }), RangeError);
    });
});

describe('segment merger', () => {
    let dir: string;
    let cleanup: () => void;
    beforeEach(() => ({ dir, cleanup } = tempDir()));
    afterEach(() => cleanup());

    function write(name: string, songs: Map<number, Fingerprint[]>): SegmentReader {
        const file = path.join(dir, name);
        const writer = new SegmentWriter(file);
        for (const [hash, list] of postingMap(songs)) writer.add(hash, list.map(p => p[0]), list.map(p => p[1]), list.length);
        writer.finish();
        writer.publish();
        return SegmentReader.open(file);
    }

    function readAll(reader: SegmentReader): PostingMap {
        const out: PostingMap = new Map();
        for (const { hash, postings } of reader.entries()) {
            out.set(hash, Array.from(postings.songs.subarray(0, postings.n), (song, i) => [song, postings.times[i]!]));
        }
        return out;
    }

    it('produces exactly the union of its inputs, minus deleted songs', () => {
        const random = rng(11);
        const all = new Map<number, Fingerprint[]>();
        const inputs: SegmentReader[] = [];
        // Interleaved song ids across segments, so per-hash lists really need re-sorting
        for (let s = 0; s < 4; s++) {
            const songs = new Map<number, Fingerprint[]>();
            for (let k = 0; k < 8; k++) {
                const id = k * 4 + s + 1;
                songs.set(id, randomPrints(random, 300, 800));
                all.set(id, songs.get(id)!);
            }
            inputs.push(write(`in${s}.seg`, songs));
        }
        const deleted = new Set([3, 10, 17]);

        const { writer, stats } = mergeSegments(inputs, path.join(dir, 'out.seg'), deleted);
        writer.publish();
        const merged = SegmentReader.open(path.join(dir, 'out.seg'));
        merged.verify();

        const expected = postingMap(new Map([...all].filter(([id]) => !deleted.has(id))));
        assert.deepEqual(readAll(merged), expected);
        assert.equal(stats.postings, merged.postingCount);
        for (const reader of [...inputs, merged]) reader.close();
    });

    it('merges a single segment into an identical copy', () => {
        const songs = new Map([[1, randomPrints(rng(2), 500)], [2, randomPrints(rng(3), 500)]]);
        const input = write('one.seg', songs);
        mergeSegments([input], path.join(dir, 'copy.seg'), new Set()).writer.publish();
        const copy = SegmentReader.open(path.join(dir, 'copy.seg'));
        assert.deepEqual(readAll(copy), postingMap(songs));
        input.close();
        copy.close();
    });
});
