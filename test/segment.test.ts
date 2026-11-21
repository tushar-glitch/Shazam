import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FOOTER_BYTES, VarintReader, writeVarint } from '../backend/storage/segment-format.js';
import { SegmentReader } from '../backend/storage/segment-reader.js';
import { SegmentWriter } from '../backend/storage/segment-writer.js';
import { type PostingMap, postingMap, randomPrints, rng, tempDir } from './helpers.js';

function writeSegment(file: string, postings: PostingMap): void {
    const writer = new SegmentWriter(file);
    for (const [hash, list] of postings) {
        writer.add(hash, list.map(p => p[0]), list.map(p => p[1]), list.length);
    }
    writer.finish();
    writer.publish();
}

function readAll(reader: SegmentReader): PostingMap {
    const out: PostingMap = new Map();
    for (const { hash, postings } of reader.entries()) {
        out.set(hash, Array.from(postings.songs.subarray(0, postings.n), (song, i) => [song, postings.times[i]!]));
    }
    return out;
}

describe('varint', () => {
    it('round-trips boundary values', () => {
        const values = [0, 1, 127, 128, 255, 16383, 16384, 2 ** 21, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1];
        const buf = Buffer.alloc(values.length * 5);
        let pos = 0;
        for (const v of values) pos = writeVarint(buf, pos, v);
        const reader = new VarintReader(buf);
        for (const v of values) assert.equal(reader.next(), v);
        assert.equal(reader.pos, pos);
    });

    it('rejects values it cannot encode', () => {
        const buf = Buffer.alloc(16);
        for (const bad of [-1, 2 ** 32, 1.5, NaN]) assert.throws(() => writeVarint(buf, 0, bad), RangeError);
    });
});

describe('segment file', () => {
    let dir: string;
    let cleanup: () => void;
    beforeEach(() => ({ dir, cleanup } = tempDir()));
    afterEach(() => cleanup());

    it('round-trips postings and supports random lookups', () => {
        const random = rng(7);
        const songs = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, randomPrints(random, 400)] as const));
        const expected = postingMap(songs);
        const file = path.join(dir, 'a.seg');
        writeSegment(file, expected);

        const reader = SegmentReader.open(file);
        assert.deepEqual(readAll(reader), expected);
        assert.equal(reader.keyCount, expected.size);
        assert.equal(reader.postingCount, [...expected.values()].reduce((sum, l) => sum + l.length, 0));
        reader.verify();

        for (const [hash, list] of [...expected].slice(0, 50)) {
            const i = reader.find(hash);
            const p = reader.postings(i);
            assert.equal(reader.counts[i], list.length);
            assert.deepEqual(Array.from(p.songs.subarray(0, p.n), (s, k) => [s, p.times[k]]), list);
        }
        assert.equal(reader.find(999_999), -1);
        reader.close();
    });

    it('drops exact duplicate postings', () => {
        const file = path.join(dir, 'dup.seg');
        const writer = new SegmentWriter(file);
        writer.add(5, [1, 1, 1, 2], [10, 10, 11, 10], 4);
        assert.deepEqual(writer.finish(), { keys: 1, postings: 3, bytes: fs.statSync(writer.tmpFile).size });
        writer.publish();
        const reader = SegmentReader.open(file);
        assert.deepEqual(readAll(reader), new Map([[5, [[1, 10], [1, 11], [2, 10]]]]));
        reader.close();
    });

    it('handles large ids and times', () => {
        const file = path.join(dir, 'big.seg');
        const writer = new SegmentWriter(file);
        writer.add(2 ** 26 - 1, [1, 2 ** 31 + 5, 2 ** 32 - 1], [2 ** 32 - 1, 0, 7], 3);
        writer.finish();
        writer.publish();
        const reader = SegmentReader.open(file);
        assert.deepEqual(readAll(reader), new Map([[2 ** 26 - 1, [[1, 2 ** 32 - 1], [2 ** 31 + 5, 0], [2 ** 32 - 1, 7]]]]));
        reader.close();
    });

    it('writes an empty segment', () => {
        const file = path.join(dir, 'empty.seg');
        const writer = new SegmentWriter(file);
        writer.finish();
        writer.publish();
        const reader = SegmentReader.open(file);
        assert.equal(reader.keyCount, 0);
        assert.equal(reader.find(1), -1);
        reader.verify();
        reader.close();
    });

    it('rejects unsorted input and leaves no file behind on abort', () => {
        const file = path.join(dir, 'bad.seg');
        const writer = new SegmentWriter(file);
        writer.add(10, [1], [1], 1);
        assert.throws(() => writer.add(10, [1], [2], 1), /ascending/);
        assert.throws(() => writer.add(11, [2, 1], [0, 0], 2), /not sorted/);
        writer.abort();
        assert.deepEqual(fs.readdirSync(dir), []);
    });

    it('is only visible under its final name once finished', () => {
        const file = path.join(dir, 'x.seg');
        const writer = new SegmentWriter(file);
        writer.add(1, [1], [1], 1);
        assert.equal(fs.existsSync(file), false);
        assert.equal(fs.existsSync(SegmentWriter.tmpName(file)), true);
        writer.finish();
        writer.publish();
        assert.deepEqual(fs.readdirSync(dir), ['x.seg']);
    });

    it('detects truncation and corruption', () => {
        const file = path.join(dir, 'c.seg');
        writeSegment(file, postingMap(new Map([[1, randomPrints(rng(3), 2000)]])));
        const bytes = fs.readFileSync(file);

        fs.writeFileSync(file, bytes.subarray(0, bytes.length - 1));
        assert.throws(() => SegmentReader.open(file), /footer/);

        const flippedTable = Buffer.from(bytes);
        flippedTable[bytes.length - FOOTER_BYTES - 3]! ^= 0xff; // inside the key table
        fs.writeFileSync(file, flippedTable);
        assert.throws(() => SegmentReader.open(file), /key table checksum/);

        const flippedPostings = Buffer.from(bytes);
        flippedPostings[20]! ^= 0x01; // inside the postings
        fs.writeFileSync(file, flippedPostings);
        const reader = SegmentReader.open(file);
        assert.throws(() => reader.verify(), /postings checksum/);
        reader.close();

        fs.writeFileSync(file, Buffer.from('definitely not a segment, but long enough to have a header and a footer......'));
        assert.throws(() => SegmentReader.open(file), /not a segment/);
    });
});
