import { parentPort } from 'node:worker_threads';
import { Fingerprinter } from '../engine/index.js';
import { AudioDecoder } from './audio-decoder.js';

// Runs on a worker thread (see FingerprintPool): decode + fingerprint one file, the CPU-heavy part.
// Results go back as typed arrays, which are moved to the main thread without copying.
const fingerprinter = new Fingerprinter();

parentPort!.on('message', (file: string) => {
    try {
        const prints = fingerprinter.fingerprintAudio(AudioDecoder.decode(file));
        const hashes = Int32Array.from(prints, p => p.hash);
        const times = Int32Array.from(prints, p => p.t);
        parentPort!.postMessage({ hashes, times }, [hashes.buffer, times.buffer]);
    } catch (error) {
        parentPort!.postMessage({ error: (error as Error).message });
    }
});
