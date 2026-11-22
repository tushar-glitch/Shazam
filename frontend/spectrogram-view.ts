import { engineConfig, SpectrumAnalyzer, type Peak } from '../engine/index.js';

const { sampleRate, frameSize, hopSize, peakFrames } = engineConfig;

const minHz = 60;
const maxHz = sampleRate / 2;
const columnCssWidth = 3;      // px per frame → ~65 px per second
const dynamicRangeDb = 50;     // quietest visible level below the loudest
const contrast = 3.2;          // >1 pushes background noise down so the notes stand out
const ceilingDecayDb = 0.15;   // auto-gain: how fast the "loudest" reference falls per frame
const axisLabels = [100, 250, 500, 1000, 2000, 4000];
// A peak is final once the engine has seen this many frames after it (its neighbourhood
// + the ±0.5 s density window); newer ones may still change, so they are drawn later
const settleFrames = peakFrames + Math.round(sampleRate / hopSize / 2);

// Scrolling live spectrogram on a <canvas>: time runs right to left, pitch goes up on a
// log scale (how we hear), ink density is loudness, like a chart printed on paper. Signal-blue
// points are the engine's peaks: exactly the points that became fingerprints (from the
// Recognizer, about a second late). Colours come from the page's CSS, so light and dark both work.
export class SpectrogramView {
    showPeaks = true;

    private palette = new Uint8ClampedArray(256 * 3);
    private paper = 'rgb(243, 243, 241)';
    private signal = '#1d3bff';

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
        this.readColours();
        new ResizeObserver(() => this.resize()).observe(canvas);
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            this.readColours();
            this.clear();
        });
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
        const palette = this.palette;

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
        ctx.fillStyle = this.signal;
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
        this.context.fillStyle = this.paper;
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

    // Paper → ink in 256 steps, from the page's colour tokens
    private readColours(): void {
        const style = getComputedStyle(document.documentElement);
        const paper = SpectrogramView.rgb(style.getPropertyValue('--paper'), [243, 243, 241]);
        const ink = SpectrogramView.rgb(style.getPropertyValue('--ink'), [13, 13, 13]);
        this.signal = style.getPropertyValue('--signal').trim() || this.signal;
        this.paper = `rgb(${paper.join(',')})`;
        for (let i = 0; i < 256; i++) {
            for (let c = 0; c < 3; c++) this.palette[i * 3 + c] = paper[c]! + (ink[c]! - paper[c]!) * (i / 255);
        }
    }

    // "#rrggbb" → [r, g, b]
    private static rgb(hex: string, fallback: [number, number, number]): [number, number, number] {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
        return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : fallback;
    }
}