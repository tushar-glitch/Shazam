import { engineConfig, SpectrumAnalyzer, type Peak } from '../engine/index.js';

const { sampleRate, frameSize, hopSize, peakFrames } = engineConfig;

const minHz = 60;
const maxHz = sampleRate / 2;
const columnCssWidth = 3;      // px per frame → ~65 px per second
const dynamicRangeDb = 65;     // quietest visible level below the loudest
const contrast = 2.2;          // >1 pushes background noise down so the notes stand out
const ceilingDecayDb = 0.15;   // auto-gain: how fast the "loudest" reference falls per frame
const background: [number, number, number] = [9, 10, 20];
const axisLabels = [100, 250, 500, 1000, 2000, 4000];
// A peak is final once the engine has seen this many frames after it (its neighbourhood
// + the ±0.5 s density window); newer ones may still change, so they are drawn later
const settleFrames = peakFrames + Math.round(sampleRate / hopSize / 2);

// Scrolling live spectrogram on a <canvas>: time runs right to left, pitch goes up on a
// log scale (how we hear), colour is loudness. White dots are the engine's peaks:
// exactly the points that became fingerprints (from the Recognizer, about a second late).
export class SpectrogramView {
    private static readonly palette = SpectrogramView.buildPalette();

    showPeaks = true;

    private readonly context: CanvasRenderingContext2D;
    private readonly analyzer = new SpectrumAnalyzer();
    private pending = new Float32Array(0);
    private rowBins: [number, number][] = [];
    private ceilingDb = -20;
    private pixelRatio = 1;
    private columns = 0;      // frames drawn since reset() = frame index of the next column
    private peaksDrawnTo = 0; // peaks before this frame are already on the canvas

    constructor(private readonly canvas: HTMLCanvasElement, axis: HTMLElement) {
        this.context = canvas.getContext('2d', { willReadFrequently: false })!;
        this.renderAxis(axis);
        new ResizeObserver(() => this.resize()).observe(canvas);
    }

    reset(): void {
        this.pending = new Float32Array(0);
        this.ceilingDb = -20;
        this.columns = 0;
        this.peaksDrawnTo = 0;
        this.clear();
    }

    // Feed raw mic samples; draws one column per hop, just like the engine frames audio
    push(samples: Float32Array): void {
        const merged = new Float32Array(this.pending.length + samples.length);
        merged.set(this.pending);
        merged.set(samples, this.pending.length);

        let start = 0;
        for (; start + frameSize <= merged.length; start += hopSize) {
            this.drawColumn(this.analyzer.frameSpectrum(merged, start));
            this.columns++;
        }
        this.pending = merged.slice(start);
    }

    private drawColumn(magnitude: Float64Array): void {
        const { width, height } = this.canvas;
        if (!width || !height) return;

        const columnWidth = Math.max(1, Math.round(columnCssWidth * this.pixelRatio));

        // Scroll everything left by one column
        this.context.drawImage(this.canvas, -columnWidth, 0);

        // Loudness in decibels, with a slowly falling ceiling so quiet rooms still show detail
        const db = new Float64Array(magnitude.length);
        let frameMax = -Infinity;
        for (let k = 0; k < magnitude.length; k++) {
            db[k] = 20 * Math.log10(magnitude[k]! + 1e-9);
            if (db[k]! > frameMax) frameMax = db[k]!;
        }
        this.ceilingDb = Math.max(frameMax, this.ceilingDb - ceilingDecayDb);
        const floorDb = this.ceilingDb - dynamicRangeDb;

        const image = this.context.createImageData(columnWidth, height);
        const palette = SpectrogramView.palette;

        for (let y = 0; y < height; y++) {
            const [lo, hi] = this.rowBins[y]!;
            let level = -Infinity;
            for (let k = lo; k <= hi; k++) if (db[k]! > level) level = db[k]!;

            const x = Math.pow(Math.min(1, Math.max(0, (level - floorDb) / dynamicRangeDb)), contrast);
            const color = Math.round(x * 255) * 3;

            for (let c = 0; c < columnWidth; c++) {
                const p = (y * columnWidth + c) * 4;
                image.data[p] = palette[color]!;
                image.data[p + 1] = palette[color + 1]!;
                image.data[p + 2] = palette[color + 2]!;
                image.data[p + 3] = 255;
            }
        }
        this.context.putImageData(image, width - columnWidth, 0);
    }

    // Peaks are found over the whole recording (frames = how many frames that covered).
    // Draws each settled peak once, at its column's current position on the scrolling canvas.
    markPeaks(peaks: Peak[], frames: number): void {
        const settled = frames - settleFrames;
        if (!this.showPeaks || settled <= this.peaksDrawnTo) return;

        const ctx = this.context;
        const columnWidth = Math.max(1, Math.round(columnCssWidth * this.pixelRatio));
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
        ctx.shadowBlur = 6 * this.pixelRatio;
        for (const { frame, bin } of peaks) {
            if (frame < this.peaksDrawnTo || frame >= settled) continue;
            const x = this.canvas.width - (this.columns - frame - 0.5) * columnWidth;
            if (x < 0) continue;
            ctx.beginPath();
            ctx.arc(x, this.hzToY(SpectrumAnalyzer.binToHz(bin)), 1.8 * this.pixelRatio, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
        this.peaksDrawnTo = settled;
    }

    // 0 = top (maxHz), height = bottom (minHz), logarithmic in between
    private hzToY(hz: number): number {
        const fraction = Math.log(maxHz / Math.max(hz, minHz)) / Math.log(maxHz / minHz);
        return fraction * this.canvas.height;
    }

    private yToHz(y: number): number {
        return maxHz * Math.pow(minHz / maxHz, y / this.canvas.height);
    }

    private resize(): void {
        this.pixelRatio = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(this.canvas.clientWidth * this.pixelRatio);
        this.canvas.height = Math.round(this.canvas.clientHeight * this.pixelRatio);

        // Which FFT bins each pixel row covers (several per row up high, one per many rows down low)
        const binHz = sampleRate / frameSize;
        const lastBin = frameSize / 2;
        this.rowBins = Array.from({ length: this.canvas.height }, (_, y) => {
            const lo = Math.min(lastBin, Math.floor(this.yToHz(y + 1) / binHz));
            const hi = Math.min(lastBin, Math.max(lo, Math.ceil(this.yToHz(y) / binHz)));
            return [lo, hi];
        });

        this.clear();
    }

    private clear(): void {
        this.context.fillStyle = `rgb(${background.join(',')})`;
        this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    private renderAxis(axis: HTMLElement): void {
        axis.replaceChildren(...axisLabels.map(hz => {
            const label = document.createElement('span');
            label.textContent = hz >= 1000 ? `${hz / 1000}k` : String(hz);
            label.style.top = `${(Math.log(maxHz / hz) / Math.log(maxHz / minHz)) * 100}%`;
            return label;
        }));
    }

    // 256-step colour scale: background → blue → cyan → green → yellow → red ("Turbo").
    // The quiet end fades into the background so silence looks calm, not purple.
    private static buildPalette(): Uint8ClampedArray {
        const palette = new Uint8ClampedArray(256 * 3);
        for (let i = 0; i < 256; i++) {
            const x = i / 255;
            const turbo = SpectrogramView.turbo(0.1 + 0.9 * x);
            const fade = Math.min(1, x / 0.3);
            for (let c = 0; c < 3; c++) {
                palette[i * 3 + c] = background[c]! + (turbo[c]! * 255 - background[c]!) * fade;
            }
        }
        return palette;
    }

    // Google's Turbo colormap, polynomial approximation (input and output 0..1)
    private static turbo(x: number): [number, number, number] {
        const r = 0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
        const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
        const b = 0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
        const clamp = (v: number) => Math.min(1, Math.max(0, v));
        return [clamp(r), clamp(g), clamp(b)];
    }
}
