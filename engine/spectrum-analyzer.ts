import { engineConfig } from './config.js';
import { FFT } from './fft.js';

const { sampleRate, frameSize } = engineConfig;

// Turns PCM (raw sound numbers) into spectra: how loud each frequency is, frame by frame
export class SpectrumAnalyzer {
    // Window is identical for every frame, so build it once (periodic Hann)
    private static readonly hannWindow = SpectrumAnalyzer.buildHannWindow();

    static binToHz(bin: number): number {
        return (bin * sampleRate) / frameSize;
    }

    static frameToSeconds(frame: number): number {
        return (frame * engineConfig.hopSize) / sampleRate;
    }

    // Magnitude spectrum of one windowed frame starting at `start`.
    // Real input → bins above N/2 mirror the lower half, so keep 0..N/2 only.
    frameSpectrum(pcm: Float32Array, start: number): Float64Array {
        const real = new Float64Array(frameSize);
        const imaginary = new Float64Array(frameSize);

        for (let j = 0; j < frameSize; j++) {
            real[j] = pcm[start + j]! * SpectrumAnalyzer.hannWindow[j]!;
        }

        FFT.transform(real, imaginary);

        const magnitude = new Float64Array(frameSize / 2 + 1);
        for (let k = 0; k < magnitude.length; k++) {
            magnitude[k] = Math.hypot(real[k]!, imaginary[k]!);
        }
        return magnitude;
    }

    // One magnitude spectrum per hop: the spectrogram
    spectrogram(pcm: Float32Array): Float64Array[] {
        const spectra: Float64Array[] = [];
        for (let start = 0; start + frameSize <= pcm.length; start += engineConfig.hopSize) {
            spectra.push(this.frameSpectrum(pcm, start));
        }
        return spectra;
    }

    private static buildHannWindow(): Float32Array {
        const window = new Float32Array(frameSize);
        for (let j = 0; j < frameSize; j++) {
            window[j] = (1 - Math.cos((2 * Math.PI * j) / frameSize)) / 2;
        }
        return window;
    }
}
