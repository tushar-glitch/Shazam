import fs from 'node:fs';
import zlib from 'node:zlib';
import {
    checkHeader, decodeFooter, FOOTER_BYTES, HEADER_BYTES, KEY_ENTRY_BYTES, VarintReader,
} from './segment-format.js';

// Decoded postings of one hash. The arrays are reused by the next call: copy what you keep.
export type Postings = { songs: Uint32Array; times: Uint32Array; n: number };

const SEQUENTIAL_WINDOW_BYTES = 8 << 20;

// Read access to one immutable segment file. The key table is loaded into memory on open
// (16 B per distinct hash); postings are read from disk on demand, so the OS page cache does
// the caching. Not thread-safe: use one reader per thread.
export class SegmentReader {
    readonly keys: Uint32Array;
    readonly counts: Uint32Array;
    readonly postingCount: number;
    readonly byteSize: number;
    // offsets[i]..offsets[i + 1] = byte range of key i's postings (last entry = key table start)
    private readonly offsets: Float64Array;
    private readonly postingsCrc: number;
    private fd: number | null;
    private scratch = Buffer.allocUnsafe(64 << 10);
    private songs = new Uint32Array(1024);
    private times = new Uint32Array(1024);
    private readonly varints = new VarintReader(this.scratch);

    private constructor(readonly file: string, fd: number) {
        this.fd = fd;
        try {
            this.byteSize = fs.fstatSync(fd).size;
            if (this.byteSize < HEADER_BYTES + FOOTER_BYTES) throw new Error(`${file}: too small to be a segment`);
            checkHeader(this.read(0, HEADER_BYTES), file);
            const footer = decodeFooter(this.read(this.byteSize - FOOTER_BYTES, FOOTER_BYTES), file);

            const tableBytes = footer.keyCount * KEY_ENTRY_BYTES;
            if (footer.keyTableOffset < HEADER_BYTES || footer.keyTableOffset + tableBytes + FOOTER_BYTES !== this.byteSize) {
                throw new Error(`${file}: footer does not match the file size (truncated or corrupt)`);
            }
            const table = this.read(footer.keyTableOffset, tableBytes);
            if (zlib.crc32(table) !== footer.keyTableCrc) throw new Error(`${file}: key table checksum mismatch`);

            this.keys = new Uint32Array(footer.keyCount);
            this.counts = new Uint32Array(footer.keyCount);
            this.offsets = new Float64Array(footer.keyCount + 1);
            for (let i = 0; i < footer.keyCount; i++) {
                const at = i * KEY_ENTRY_BYTES;
                this.keys[i] = table.readUInt32LE(at);
                this.counts[i] = table.readUInt32LE(at + 4);
                this.offsets[i] = Number(table.readBigUInt64LE(at + 8));
            }
            this.offsets[footer.keyCount] = footer.keyTableOffset;
            this.postingCount = footer.postingCount;
            this.postingsCrc = footer.postingsCrc;
        } catch (error) {
            fs.closeSync(fd);
            this.fd = null;
            throw error;
        }
    }

    // Opens and validates header, footer and key table checksum (cheap). Postings are checked by verify().
    static open(file: string): SegmentReader {
        return new SegmentReader(file, fs.openSync(file, 'r'));
    }

    get keyCount(): number {
        return this.keys.length;
    }

    // Index of hash in the key table, or -1
    find(hash: number): number {
        let lo = 0;
        let hi = this.keys.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const key = this.keys[mid]!;
            if (key < hash) lo = mid + 1;
            else if (key > hash) hi = mid - 1;
            else return mid;
        }
        return -1;
    }

    // Postings of key i (random access: reads exactly that key's bytes)
    postings(i: number): Postings {
        const start = this.offsets[i]!;
        const length = this.offsets[i + 1]! - start;
        if (length > this.scratch.length) this.scratch = Buffer.allocUnsafe(length);
        this.readInto(this.scratch, start, length);
        return this.decode(i, this.scratch, 0, length);
    }

    // Every key in ascending order, reading the file sequentially in large windows (for merges)
    *entries(): Generator<{ hash: number; postings: Postings }> {
        let window = Buffer.allocUnsafe(SEQUENTIAL_WINDOW_BYTES);
        let windowStart = 0;
        let windowEnd = 0;
        for (let i = 0; i < this.keys.length; i++) {
            const start = this.offsets[i]!;
            const end = this.offsets[i + 1]!;
            if (end > windowEnd) {
                const length = Math.min(Math.max(end - start, SEQUENTIAL_WINDOW_BYTES), this.offsets[this.keys.length]! - start);
                if (length > window.length) window = Buffer.allocUnsafe(length);
                this.readInto(window, start, length);
                windowStart = start;
                windowEnd = start + length;
            }
            yield { hash: this.keys[i]!, postings: this.decode(i, window, start - windowStart, end - start) };
        }
    }

    // Full integrity check of the postings region against its checksum
    verify(): void {
        const end = this.offsets[this.keys.length]!;
        const chunk = Buffer.allocUnsafe(SEQUENTIAL_WINDOW_BYTES);
        let crc = 0;
        for (let pos = HEADER_BYTES; pos < end; pos += chunk.length) {
            const length = Math.min(chunk.length, end - pos);
            this.readInto(chunk, pos, length);
            crc = zlib.crc32(chunk.subarray(0, length), crc);
        }
        if (crc !== this.postingsCrc) throw new Error(`${this.file}: postings checksum mismatch`);
    }

    close(): void {
        if (this.fd !== null) fs.closeSync(this.fd);
        this.fd = null;
    }

    private decode(i: number, buf: Uint8Array, from: number, length: number): Postings {
        const n = this.counts[i]!;
        if (n > this.songs.length) {
            this.songs = new Uint32Array(n);
            this.times = new Uint32Array(n);
        }
        const reader = this.varints;
        reader.reset(buf, from);
        let song = 0;
        let t = 0;
        for (let k = 0; k < n; k++) {
            const songDelta = reader.next();
            const tValue = reader.next();
            t = songDelta === 0 && k > 0 ? t + tValue : tValue;
            song += songDelta;
            this.songs[k] = song;
            this.times[k] = t;
        }
        if (reader.pos !== from + length) throw new Error(`${this.file}: postings of hash ${this.keys[i]} are corrupt`);
        return { songs: this.songs, times: this.times, n };
    }

    private read(position: number, length: number): Buffer {
        const buf = Buffer.allocUnsafe(length);
        this.readInto(buf, position, length);
        return buf;
    }

    private readInto(buf: Buffer, position: number, length: number): void {
        if (this.fd === null) throw new Error(`${this.file}: reader is closed`);
        let done = 0;
        while (done < length) {
            const n = fs.readSync(this.fd, buf, done, length - done, position + done);
            if (n === 0) throw new Error(`${this.file}: unexpected end of file`);
            done += n;
        }
    }
}
