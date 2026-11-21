// On-disk layout of a segment file (all integers little-endian). See docs/index-format.md.
//
//   [header  16 B]  magic (8) | format version u32 | flags u32 (reserved, 0)
//   [postings    ]  per hash, ascending: its postings sorted by (songId, t), as varints:
//                   songId delta from the previous posting, then t (delta if the song is unchanged)
//   [key table   ]  per hash, ascending: hash u32 | posting count u32 | postings offset u64
//   [footer  48 B]  key table offset u64 | key count u32 | reserved u32 | posting count u64
//                   | key table crc32 u32 | postings crc32 u32 | format version u32 | reserved u32 | magic (8)
//
// Postings come first so a writer can stream them and only keep the key table in memory.
export const MAGIC = Buffer.from('SHZSEG\0\x01', 'latin1');
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 16;
export const KEY_ENTRY_BYTES = 16;
export const FOOTER_BYTES = 48;
export const SEGMENT_EXTENSION = '.seg';
// Largest encoded posting: two 5-byte varints (values are < 2^32)
export const MAX_POSTING_BYTES = 10;

export type Footer = {
    keyTableOffset: number;
    keyCount: number;
    postingCount: number;
    keyTableCrc: number;
    postingsCrc: number;
};

export function encodeHeader(): Buffer {
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(FORMAT_VERSION, 8);
    return header;
}

export function checkHeader(header: Buffer, file: string): void {
    if (header.length < HEADER_BYTES || !header.subarray(0, 8).equals(MAGIC)) {
        throw new Error(`${file}: not a segment file`);
    }
    const version = header.readUInt32LE(8);
    if (version !== FORMAT_VERSION) throw new Error(`${file}: unsupported segment format version ${version}`);
}

export function encodeFooter(footer: Footer): Buffer {
    const out = Buffer.alloc(FOOTER_BYTES);
    out.writeBigUInt64LE(BigInt(footer.keyTableOffset), 0);
    out.writeUInt32LE(footer.keyCount, 8);
    out.writeBigUInt64LE(BigInt(footer.postingCount), 16);
    out.writeUInt32LE(footer.keyTableCrc, 24);
    out.writeUInt32LE(footer.postingsCrc, 28);
    out.writeUInt32LE(FORMAT_VERSION, 32);
    MAGIC.copy(out, 40);
    return out;
}

export function decodeFooter(footer: Buffer, file: string): Footer {
    if (footer.length !== FOOTER_BYTES || !footer.subarray(40, 48).equals(MAGIC)) {
        throw new Error(`${file}: missing segment footer (truncated or corrupt)`);
    }
    const version = footer.readUInt32LE(32);
    if (version !== FORMAT_VERSION) throw new Error(`${file}: unsupported segment format version ${version}`);
    return {
        keyTableOffset: Number(footer.readBigUInt64LE(0)),
        keyCount: footer.readUInt32LE(8),
        postingCount: Number(footer.readBigUInt64LE(16)),
        keyTableCrc: footer.readUInt32LE(24),
        postingsCrc: footer.readUInt32LE(28),
    };
}

// LEB128 unsigned varint for values in [0, 2^32). Returns the position after the value.
export function writeVarint(buf: Buffer, pos: number, value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`varint out of range: ${value}`);
    while (value >= 0x80) {
        buf[pos++] = (value & 0x7f) | 0x80;
        value = Math.floor(value / 128); // not >>>: stays exact above 2^31
    }
    buf[pos++] = value;
    return pos;
}

// Sequential varint decoding over one buffer; `pos` is advanced by every read
export class VarintReader {
    pos = 0;

    constructor(private buf: Uint8Array, start = 0) {
        this.pos = start;
    }

    reset(buf: Uint8Array, start = 0): void {
        this.buf = buf;
        this.pos = start;
    }

    next(): number {
        let value = 0;
        let scale = 1;
        for (let i = 0; i < 5; i++) {
            const byte = this.buf[this.pos++];
            if (byte === undefined) throw new Error('varint runs past the end of the data');
            value += (byte & 0x7f) * scale;
            if (byte < 0x80) return value;
            scale *= 128;
        }
        throw new Error('varint longer than 5 bytes');
    }
}
