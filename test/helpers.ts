import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Fingerprint } from '../engine/index.js';

// A fresh temporary directory, removed when the returned function is called
export function tempDir(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shazam-test-'));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Deterministic pseudo-random numbers (32-bit LCG) so failures are reproducible
export function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

// A fake song's fingerprints: hashes drawn from a small space so songs share hashes
// (that is what makes voting, stop words and merges non-trivial)
export function randomPrints(random: () => number, count: number, hashSpace = 5000, maxT = 2000): Fingerprint[] {
    return Array.from({ length: count }, () => ({
        hash: Math.floor(random() * hashSpace),
        t: Math.floor(random() * maxT),
    }));
}

// Postings grouped by hash, each list sorted by (song, t), duplicates removed
export type PostingMap = Map<number, [song: number, t: number][]>;

export function postingMap(songs: Map<number, Fingerprint[]>): PostingMap {
    const map: PostingMap = new Map();
    for (const [song, prints] of songs) {
        for (const { hash, t } of prints) {
            const list = map.get(hash) ?? [];
            list.push([song, t]);
            map.set(hash, list);
        }
    }
    for (const [hash, list] of map) {
        list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        map.set(hash, list.filter((p, i) => i === 0 || p[0] !== list[i - 1]![0] || p[1] !== list[i - 1]![1]));
    }
    return new Map([...map].sort((a, b) => a[0] - b[0]));
}
