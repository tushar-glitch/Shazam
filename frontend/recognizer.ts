import { engineConfig, Fingerprinter, SpectrumAnalyzer, type Match, type Peak } from '../engine/index.js';
import type { MatchClient } from './match-client.js';
import { Microphone } from './microphone.js';

export const recognizerConfig = {
    maxSeconds: 15,     // give up after this much audio
    tickMs: 1000,       // how often hashes are sent to the server
} as const;

// peaks/frames let the spectrogram mark exactly the points the engine hashed
export type Progress = { seconds: number; hashes: number; best: Match | null; peaks: Peak[]; frames: number };

export type Outcome =
    | { kind: 'matched'; match: Match; seconds: number }
    | { kind: 'no-match' }
    | { kind: 'stopped' };

export type RecognizerEvents = {
    onStarted(): void;                        // mic permission granted, audio flowing
    onSamples(samples: Float32Array): void;   // every raw mic block (~12 ms)
    onProgress(progress: Progress): void;     // after every server check (~1 s)
};

// The listening loop: record → fingerprint everything heard so far → ask the server,
// once per tick, until a significant match (confidence 1), a timeout, or stop().
export class Recognizer {
    private listening = false;

    constructor(
        private readonly client: MatchClient,
        private readonly fingerprinter = new Fingerprinter(),
        private readonly analyzer = new SpectrumAnalyzer()
    ) {}

    get isListening(): boolean {
        return this.listening;
    }

    stop(): void {
        this.listening = false;
    }

    async listen(events: RecognizerEvents): Promise<Outcome> {
        this.listening = true;
        const microphone = new Microphone();
        const chunks: Float32Array[] = [];

        try {
            await microphone.start(samples => {
                chunks.push(samples);
                events.onSamples(samples);
            });
            if (this.listening) events.onStarted();

            while (this.listening) {
                await Recognizer.sleep(recognizerConfig.tickMs);
                if (!this.listening) break;

                // ponytail: re-fingerprints the whole recording each tick (~15 s max, a few ms); go incremental if sessions get long
                const pcm = Recognizer.concat(chunks);
                const spectra = this.analyzer.spectrogram(pcm);
                const peaks = this.fingerprinter.findPeaks(spectra);
                const prints = this.fingerprinter.fingerprint(peaks);
                const seconds = pcm.length / engineConfig.sampleRate;
                const best = await this.client.match(prints);

                events.onProgress({ seconds, hashes: prints.length, best, peaks, frames: spectra.length });

                if (best && best.confidence >= 1) {
                    return { kind: 'matched', match: best, seconds };
                }
                if (seconds >= recognizerConfig.maxSeconds) return { kind: 'no-match' };
            }
            return { kind: 'stopped' };
        } finally {
            this.listening = false;
            await microphone.stop();
        }
    }

    private static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private static concat(chunks: Float32Array[]): Float32Array {
        const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }
}
