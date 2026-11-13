import { AppView } from './app-view.js';
import { MatchClient } from './match-client.js';
import { MatchHistory } from './match-history.js';
import { Recognizer } from './recognizer.js';
import { SpectrogramView } from './spectrogram-view.js';

// Wires the pieces together: button → Recognizer (mic + fingerprints + server)
// → AppView (text, result, history) and SpectrogramView (live picture).
class App {
    private readonly view = new AppView();
    private readonly client = new MatchClient();
    private readonly recognizer = new Recognizer(this.client);
    private readonly history = new MatchHistory();
    private readonly spectrogram = new SpectrogramView(this.view.spectrogramCanvas, this.view.frequencyAxis);
    private level = 0;

    start(): void {
        this.view.listenButton.addEventListener('click', () => this.toggle());
        this.view.againButton.addEventListener('click', () => this.toggle());
        this.view.retryButton.addEventListener('click', () => this.toggle());
        this.view.peaksToggle.addEventListener('change', () => {
            this.spectrogram.showPeaks = this.view.peaksToggle.checked;
        });
        this.view.clearHistoryButton.addEventListener('click', () => {
            this.history.clear();
            this.view.renderHistory([]);
        });

        this.view.setState('idle');
        this.view.renderHistory(this.history.all());
        this.refreshLibrarySize();
    }

    private async toggle(): Promise<void> {
        if (this.recognizer.isListening) return this.recognizer.stop();

        this.view.setState('starting');
        this.spectrogram.reset();

        try {
            const outcome = await this.recognizer.listen({
                onStarted: () => this.view.setState('listening'),
                onSamples: samples => {
                    this.spectrogram.push(samples);
                    this.view.setLevel(this.updateLevel(samples));
                },
                onProgress: progress => {
                    this.view.showProgress(progress);
                    this.spectrogram.markPeaks(progress.peaks, progress.frames);
                },
            });

            if (outcome.kind === 'matched') {
                this.view.showMatch(outcome.match, outcome.seconds);
                this.view.renderHistory(this.history.add(outcome.match.song));
            } else if (outcome.kind === 'no-match') {
                this.view.showNoMatch();
            } else {
                this.view.setState('idle');
            }
        } catch (error) {
            this.view.showError(App.describeError(error));
        } finally {
            this.level = 0;
            this.view.setLevel(0);
        }
    }

    // Smoothed loudness (RMS): jumps up fast, falls slowly, like a VU meter
    private updateLevel(samples: Float32Array): number {
        let sum = 0;
        for (const s of samples) sum += s * s;
        const rms = Math.sqrt(sum / samples.length);
        this.level = Math.max(Math.min(1, rms * 6), this.level * 0.92);
        return this.level;
    }

    private async refreshLibrarySize(): Promise<void> {
        try {
            this.view.setLibrarySize(await this.client.librarySize());
        } catch {
            this.view.setLibrarySize(null);
        }
    }

    // Turn browser errors into something a person can act on
    private static describeError(error: unknown): string {
        const name = (error as { name?: string })?.name;
        if (!navigator.mediaDevices) return 'The microphone only works on a secure page. Open the app via http://localhost or https.';
        if (name === 'NotAllowedError') return 'Microphone access is blocked. Allow it from the icon in the address bar, then try again.';
        if (name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
        if (name === 'NotReadableError') return 'The microphone is busy in another app. Close it there and try again.';
        if (error instanceof TypeError) return 'Can’t reach the server. Make sure `npm start -- serve` is running.';
        return (error as Error)?.message ?? 'Unknown error';
    }
}

new App().start();
