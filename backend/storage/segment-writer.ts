import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
    encodeFooter, encodeHeader, KEY_ENTRY_BYTES, MAX_POSTING_BYTES, writeVarint,
} from './segment-format.js';

export type SegmentStats = { keys: number; postings: number; bytes: number };

const BUFFER_BYTES = 1 << 20;

// Streams one segment to disk. Call add() once per hash in ascending hash order, then finish()
// and publish(). The file is written as "<final>.<pid>.tmp" and only renamed into place by
// publish(), after an fsync, so a crash never leaves a half-written file under a segment name.
export class SegmentWriter {
    readonly tmpFile: string;
    private readonly fd: number;
    private readonly buf = Buffer.allocUnsafe(BUFFER_BYTES);
    private bufLength = 0;
    private fileLength = 0;
    private postingsCrc = 0;
    private postingCount = 0;
    private lastHash = -1;
    private keys = new Uint32Array(1024);
    private counts = new Uint32Array(1024);
    private offsets = new Float64Array(1024);
    private keyCount = 0;
    private closed = false;

    constructor(readonly file: string) {
        this.tmpFile = SegmentWriter.tmpName(file);
        this.fd = fs.openSync(this.tmpFile, 'wx');
        this.write(encodeHeader());
    }

    // Temp files carry the writer's pid, so recovery can tell a crashed writer's leftovers
    // from a file another live process is still writing
    static tmpName(file: string): string {
        return `${file}.${process.pid}.tmp`;
    }

    // Postings of one hash, sorted by (song, t). Exact duplicates are dropped (the previous
    // store's primary key made (hash, song, t) unique, so the index stays equivalent).
    add(hash: number, songs: ArrayLike<number>, times: ArrayLike<number>, n: number): void {
        if (!Number.isInteger(hash) || hash <= this.lastHash || hash > 0xffffffff) {
            throw new Error(`hashes must be added in strictly ascending order (got ${hash} after ${this.lastHash})`);
        }
        if (n === 0) return;
        this.lastHash = hash;

        const offset = this.fileLength + this.bufLength;
        let count = 0;
        let prevSong = 0;
        let prevT = 0;
        for (let i = 0; i < n; i++) {
            const song = songs[i]!;
            const t = times[i]!;
            if (count > 0) {
                if (song < prevSong || (song === prevSong && t < prevT)) {
                    throw new Error(`postings of hash ${hash} are not sorted by (song, t)`);
                }
                if (song === prevSong && t === prevT) continue;
            }
            if (this.bufLength + MAX_POSTING_BYTES > BUFFER_BYTES) this.drain();
            let pos = writeVarint(this.buf, this.bufLength, song - prevSong);
            pos = writeVarint(this.buf, pos, song === prevSong && count > 0 ? t - prevT : t);
            this.bufLength = pos;
            prevSong = song;
            prevT = t;
            count++;
        }

        if (this.keyCount === this.keys.length) this.growKeyTable();
        this.keys[this.keyCount] = hash;
        this.counts[this.keyCount] = count;
        this.offsets[this.keyCount] = offset;
        this.keyCount++;
        this.postingCount += count;
    }

    // Adds [hash, song, t] rows sorted by (hash, song, t), e.g. straight from an ORDER BY query.
    // Returns the number of rows read.
    addSortedRows(rows: Iterable<readonly [number, number, number]>): number {
        let songs = new Uint32Array(1024);
        let times = new Uint32Array(1024);
        let hash = -1;
        let n = 0;
        let count = 0;
        for (const [h, song, t] of rows) {
            if (h !== hash) {
                if (n > 0) this.add(hash, songs, times, n);
                hash = h;
                n = 0;
            }
            if (n === songs.length) {
                const grownSongs = new Uint32Array(n * 2); grownSongs.set(songs); songs = grownSongs;
                const grownTimes = new Uint32Array(n * 2); grownTimes.set(times); times = grownTimes;
            }
            songs[n] = song;
            times[n] = t;
            n++;
            count++;
        }
        if (n > 0) this.add(hash, songs, times, n);
        return count;
    }

    // Writes key table + footer and fsyncs. The file stays under its temp name until publish(),
    // so callers can publish while holding the catalog's write lock.
    finish(): SegmentStats {
        this.drain();
        const keyTableOffset = this.fileLength;

        const table = Buffer.alloc(this.keyCount * KEY_ENTRY_BYTES);
        for (let i = 0; i < this.keyCount; i++) {
            const at = i * KEY_ENTRY_BYTES;
            table.writeUInt32LE(this.keys[i]!, at);
            table.writeUInt32LE(this.counts[i]!, at + 4);
            table.writeBigUInt64LE(BigInt(this.offsets[i]!), at + 8);
        }
        this.write(table);
        this.write(encodeFooter({
            keyTableOffset,
            keyCount: this.keyCount,
            postingCount: this.postingCount,
            keyTableCrc: zlib.crc32(table),
            postingsCrc: this.postingsCrc,
        }));

        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
        this.closed = true;
        return { keys: this.keyCount, postings: this.postingCount, bytes: this.fileLength };
    }

    // Moves the finished file to its final name (atomic rename, made durable)
    publish(): void {
        if (!this.closed) throw new Error('finish() the segment before publishing it');
        fs.renameSync(this.tmpFile, this.file);
        SegmentWriter.syncDirectory(path.dirname(this.file));
    }

    // Gives up on the segment: closes and deletes the temp file
    abort(): void {
        if (!this.closed) {
            fs.closeSync(this.fd);
            this.closed = true;
        }
        fs.rmSync(this.tmpFile, { force: true });
    }

    get postings(): number {
        return this.postingCount;
    }

    private drain(): void {
        if (this.bufLength === 0) return;
        const chunk = this.buf.subarray(0, this.bufLength);
        this.postingsCrc = zlib.crc32(chunk, this.postingsCrc);
        this.write(chunk);
        this.bufLength = 0;
    }

    private write(data: Uint8Array): void {
        let done = 0;
        while (done < data.length) done += fs.writeSync(this.fd, data, done, data.length - done, this.fileLength + done);
        this.fileLength += data.length;
    }

    private growKeyTable(): void {
        const size = this.keys.length * 2;
        const keys = new Uint32Array(size); keys.set(this.keys); this.keys = keys;
        const counts = new Uint32Array(size); counts.set(this.counts); this.counts = counts;
        const offsets = new Float64Array(size); offsets.set(this.offsets); this.offsets = offsets;
    }

    // Makes the rename durable. Windows cannot open directories for fsync (NTFS journals renames).
    private static syncDirectory(dir: string): void {
        if (process.platform === 'win32') return;
        const fd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
}
