import { engineConfig } from './config.js';
import { SpectrumAnalyzer } from './spectrum-analyzer.js';
import type { Fingerprint, Peak } from './types.js';

// PCM → spectrogram → peaks (constellation map) → hashes.
// Follows Wang 2003 (Shazam) and Ellis' audfprint: sparse, evenly spread 2D peaks,
// paired inside a target zone that is far enough ahead in time to be distinctive.
export class Fingerprinter {
    constructor(private readonly analyzer = new SpectrumAnalyzer()) {}

    // pcm must be mono float32 at engineConfig.sampleRate
    fingerprintAudio(pcm: Float32Array): Fingerprint[] {
        return this.fingerprint(this.findPeaks(this.analyzer.spectrogram(pcm)));
    }

    // Constellation map. Returns peaks sorted by frame, then bin.
    findPeaks(spectra: Float64Array[]): Peak[] {
        const { minBin, maxBin, peakBins, peakFrames, minProminenceDb, maxBelowFrameDb, peaksPerSecond, sampleRate, hopSize } = engineConfig;
        const frames = spectra.length;
        const bins = maxBin - minBin;
        if (frames === 0) return [];

        // Loudness in dB, one row per frame
        const db = new Float32Array(frames * bins);
        const frameMax = new Float32Array(frames);
        for (let t = 0; t < frames; t++) {
            const mag = spectra[t]!;
            frameMax[t] = -Infinity;
            for (let b = 0; b < bins; b++) {
                const v = 20 * Math.log10(mag[minBin + b]! + 1e-9);
                db[t * bins + b] = v;
                if (v > frameMax[t]!) frameMax[t] = v;
            }
        }

        const localMax = Fingerprinter.boxFilter(db, frames, bins, peakFrames, peakBins, 'max');
        const localMean = Fingerprinter.boxFilter(db, frames, bins, peakFrames, peakBins, 'mean');

        const candidates: (Peak & { prominence: number })[] = [];
        for (let t = 0; t < frames; t++) {
            for (let b = 0; b < bins; b++) {
                const i = t * bins + b;
                const prominence = db[i]! - localMean[i]!;
                // Far below the frame's loudest point = silence/round-off noise, which would otherwise look "prominent"
                if (db[i] === localMax[i] && prominence >= minProminenceDb && db[i]! >= frameMax[t]! - maxBelowFrameDb) {
                    candidates.push({ frame: t, bin: minBin + b, prominence });
                }
            }
        }

        // Even density: keep a peak only if fewer than peaksPerSecond peaks within ±0.5 s
        // are more prominent. Sliding (not fixed blocks), so a clip and the full song agree.
        const half = Math.round(sampleRate / hopSize / 2);
        let lo = 0;
        return candidates.filter(peak => {
            while (candidates[lo]!.frame < peak.frame - half) lo++;
            let stronger = 0;
            for (let j = lo; j < candidates.length && candidates[j]!.frame <= peak.frame + half; j++) {
                if (candidates[j]!.prominence > peak.prominence && ++stronger >= peaksPerSecond) return false;
            }
            return true;
        }).map(({ frame, bin }) => ({ frame, bin }));
    }

    // Combinatorial hashing: each anchor pairs with the nearest later peaks in its target
    // zone. hash = f1 (10 bits) | f2 (10 bits) | dt (6 bits). Peaks must be sorted by frame.
    fingerprint(peaks: Peak[]): Fingerprint[] {
        const { fanOut, minDt, maxDt, maxDf } = engineConfig;
        const prints: Fingerprint[] = [];

        for (let i = 0; i < peaks.length; i++) {
            const anchor = peaks[i]!;
            let paired = 0;

            for (let j = i + 1; j < peaks.length && paired < fanOut; j++) {
                const target = peaks[j]!;
                const dt = target.frame - anchor.frame;
                if (dt < minDt) continue;
                if (dt > maxDt) break;
                if (Math.abs(target.bin - anchor.bin) > maxDf) continue;

                prints.push({ hash: (anchor.bin << 16) | (target.bin << 6) | dt, t: anchor.frame });
                paired++;
            }
        }
        return prints;
    }

    // Max or mean over a (2·rt+1) × (2·rb+1) box around every cell, clipped at the edges.
    // Separable: filter along bins, then along time. Both are streaming (cost independent of
    // the box size): max keeps a queue of candidates (Lemire), mean keeps a running sum.
    private static boxFilter(data: Float32Array, rows: number, cols: number, rt: number, rb: number, kind: 'max' | 'mean'): Float32Array {
        const pass = (src: Float32Array, n: number, stride: number, count: number, step: number, r: number) => {
            const out = new Float32Array(src.length);
            const queue = new Int32Array(n); // indices whose values decrease from head to tail
            for (let line = 0; line < count; line++) {
                const base = line * step;
                if (kind === 'max') {
                    let head = 0, tail = 0, next = 0;
                    for (let k = 0; k < n; k++) {
                        for (const last = Math.min(n - 1, k + r); next <= last; next++) {
                            const v = src[base + next * stride]!;
                            while (tail > head && src[base + queue[tail - 1]! * stride]! <= v) tail--;
                            queue[tail++] = next;
                        }
                        while (queue[head]! < k - r) head++;
                        out[base + k * stride] = src[base + queue[head]! * stride]!;
                    }
                } else {
                    // float32 inputs summed in float64: exact, so add/remove gives the same sums as re-adding
                    let sum = 0;
                    for (let m = 0; m <= Math.min(n - 1, r); m++) sum += src[base + m * stride]!;
                    for (let k = 0; k < n; k++) {
                        out[base + k * stride] = sum / (Math.min(n - 1, k + r) - Math.max(0, k - r) + 1);
                        if (k + r + 1 < n) sum += src[base + (k + r + 1) * stride]!;
                        if (k - r >= 0) sum -= src[base + (k - r) * stride]!;
                    }
                }
            }
            return out;
        };
        const alongBins = pass(data, cols, 1, rows, cols, rb);
        return pass(alongBins, rows, cols, cols, 1, rt);
    }
}
