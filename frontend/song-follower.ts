import { engineConfig, Fingerprinter, type Match } from '../engine/index.js';
import type { MatchClient } from './match-client.js';
import { Microphone } from './microphone.js';

export const followerConfig = {
    resyncMs: 5000,       // how often the song is re-matched
    windowSeconds: 8,     // how much recent audio each re-match uses
    minSeconds: 4,        // don't match before this much audio is in
    giveUpMs: 45000,      // stop when nothing was recognised for this long
    switchAfter: 2,       // re-matches of another song in a row before switching to it
} as const;

export type FollowerEvents = {
    onSamples(samples: Float32Array): void;
    // The current song was heard again; its clip started at clipStartedAt (performance.now() ms)
    onResync(match: Match, clipStartedAt: number): void;
    // A different song is playing now
    onSongChange(match: Match, clipStartedAt: number): void;
    // Nothing recognisable for giveUpMs; following has stopped
    onLost(): void;
};

// Keeps listening after a song was identified and re-matches the last few seconds every
// resyncMs, so the lyrics stay in step even if the song is skipped, paused or changed.
export class SongFollower {
    private session = 0; // stop() or a new follow() ends the current session

    constructor(private readonly client: MatchClient, private readonly fingerprinter = new Fingerprinter()) {}

    stop(): void {
        this.session++;
    }

    async follow(song: string, events: FollowerEvents): Promise<void> {
        const session = ++this.session;
        const active = () => this.session === session;
        const { sampleRate } = engineConfig;
        const microphone = new Microphone();
        const keep = (followerConfig.windowSeconds + 2) * sampleRate;
        let chunks: Float32Array[] = [];
        let buffered = 0;
        let lastChunkAt = 0;
        let lastHeard = performance.now();
        let otherSong = '';
        let otherCount = 0;

        try {
            await microphone.start(samples => {
                chunks.push(samples);
                buffered += samples.length;
                lastChunkAt = performance.now();
                // Drop audio older than the window
                while (buffered - chunks[0]!.length >= keep) buffered -= chunks.shift()!.length;
                events.onSamples(samples);
            });

            while (active()) {
                await new Promise(resolve => setTimeout(resolve, followerConfig.resyncMs));
                if (!active()) break;
                if (buffered < followerConfig.minSeconds * sampleRate) continue;

                // The last windowSeconds of audio, and when its first sample was heard
                const all = SongFollower.concat(chunks);
                const clip = all.subarray(Math.max(0, all.length - followerConfig.windowSeconds * sampleRate));
                const clipStartedAt = lastChunkAt - (clip.length / sampleRate) * 1000;
                const match = await this.client.match(this.fingerprinter.fingerprintAudio(clip));
                if (!active()) break;

                if (match && match.confidence >= 1) {
                    lastHeard = performance.now();
                    if (match.song === song) {
                        otherCount = 0;
                        events.onResync(match, clipStartedAt);
                    } else {
                        otherCount = match.song === otherSong ? otherCount + 1 : 1;
                        otherSong = match.song;
                        if (otherCount >= followerConfig.switchAfter) {
                            song = match.song;
                            otherCount = 0;
                            events.onSongChange(match, clipStartedAt);
                        }
                    }
                } else if (performance.now() - lastHeard > followerConfig.giveUpMs) {
                    events.onLost();
                    break;
                }
            }
        } finally {
            chunks = [];
            await microphone.stop();
        }
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
