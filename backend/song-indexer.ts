import fs from 'node:fs';
import path from 'node:path';
import { Fingerprinter, type Fingerprint } from '../engine/index.js';
import { AudioDecoder } from './audio-decoder.js';
import type { FingerprintDatabase } from './fingerprint-database.js';

// Fingerprints audio and stores it. The song name is the file name ("Artist - Title").
export class SongIndexer {
    constructor(
        private readonly db: FingerprintDatabase,
        private readonly fingerprinter = new Fingerprinter()
    ) {}

    // Returns how many hashes were stored
    addAudio(name: string, pcm: Float32Array, replace = false): number {
        const prints = this.fingerprinter.fingerprintAudio(pcm);
        this.db.addSong(name, prints, replace);
        return prints.length;
    }

    // Same, for fingerprints made elsewhere (e.g. on a worker thread)
    addPrints(name: string, prints: Fingerprint[], replace = false): number {
        this.db.addSong(name, prints, replace);
        return prints.length;
    }

    indexFile(file: string): void {
        const name = path.parse(file).name;
        if (this.db.hasSong(name)) return;

        try {
            const count = this.addAudio(name, AudioDecoder.decode(file));
            console.log(`Indexed "${name}" (${count} hashes)`);
        } catch (error) {
            // One bad file must not stop a run over thousands
            console.error(`Failed "${name}": ${(error as Error).message}`);
        }
    }

    // Skips unfinished downloads (.part) and songs already in the DB
    indexFolder(folder: string): void {
        for (const entry of fs.readdirSync(folder)) {
            if (!entry.endsWith('.part')) this.indexFile(path.join(folder, entry));
        }
    }
}
