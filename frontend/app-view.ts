import type { Match } from '../engine/index.js';
import type { HistoryEntry } from './match-history.js';
import { recognizerConfig, type Progress } from './recognizer.js';

export type ViewState = 'idle' | 'starting' | 'listening' | 'matched' | 'no-match' | 'error';

const ringCircumference = 2 * Math.PI * 54; // matches r="54" in index.html

// Everything the user sees. All text goes through textContent, so song names
// (which come from the internet) can never inject HTML.
export class AppView {
    readonly listenButton = AppView.byId<HTMLButtonElement>('listen');
    readonly againButton = AppView.byId<HTMLButtonElement>('again');
    readonly retryButton = AppView.byId<HTMLButtonElement>('retry');
    readonly clearHistoryButton = AppView.byId<HTMLButtonElement>('clear-history');
    readonly peaksToggle = AppView.byId<HTMLInputElement>('show-peaks');
    readonly spectrogramCanvas = AppView.byId<HTMLCanvasElement>('spectrogram');
    readonly frequencyAxis = AppView.byId<HTMLElement>('freq-axis');

    private readonly listenLabel = AppView.byId('listen-label');
    private readonly progressBar = AppView.byId('progress-bar');
    private readonly status = AppView.byId('status');
    private readonly detail = AppView.byId('detail');
    private readonly statSeconds = AppView.byId('stat-seconds');
    private readonly statHashes = AppView.byId('stat-hashes');
    private readonly confidenceBar = AppView.byId('confidence-bar');
    private readonly confidenceValue = AppView.byId('confidence-value');
    private readonly bestGuess = AppView.byId('best-guess');
    private readonly result = AppView.byId('result');
    private readonly notice = AppView.byId('notice');
    private readonly historyCard = AppView.byId('history-card');
    private readonly historyList = AppView.byId('history-list');
    private readonly libraryCount = AppView.byId('library-count');

    setState(state: ViewState): void {
        document.body.dataset.state = state;
        const active = state === 'starting' || state === 'listening';

        this.listenButton.setAttribute('aria-pressed', String(active));
        this.listenButton.setAttribute('aria-label', active ? 'Stop listening' : 'Start listening');
        this.listenLabel.textContent = active ? 'Tap to stop' : 'Tap to listen';
        this.result.hidden = state !== 'matched';
        this.notice.hidden = state !== 'no-match' && state !== 'error';

        if (state === 'idle') this.setText("What's playing?", 'Play a song nearby, then tap the button.');
        if (state === 'starting') this.setText('Waiting for the microphone…', 'Allow microphone access if your browser asks.');
        if (state === 'listening') {
            document.body.dataset.audio = 'seen'; // spectrogram has content: hide its placeholder
            this.setText('Listening…', 'Hold your device close to the music.');
            this.showProgress({ seconds: 0, hashes: 0, best: null, peaks: [], frames: 0 });
        }
    }

    // Status copy changes as the search goes on, so a long search never feels stuck
    showProgress({ seconds, hashes, best }: Progress): void {
        const confidence = best?.confidence ?? 0;

        this.statSeconds.textContent = `${Math.round(seconds)} s`;
        this.statHashes.textContent = hashes.toLocaleString();
        this.confidenceBar.style.transform = `scaleX(${confidence})`;
        this.confidenceValue.textContent = `${Math.round(confidence * 100)}%`;
        // Weak guesses are coincidences; only mention a song once it's halfway to significant
        this.bestGuess.textContent = best && confidence >= 0.5 ? `Leaning towards ${AppView.splitName(best.song).title}…` : '';
        this.progressBar.style.strokeDashoffset = String(ringCircumference * (1 - Math.min(1, seconds / recognizerConfig.maxSeconds)));

        if (seconds >= 3) {
            this.setText(seconds < 8 ? 'Analysing the sound…' : 'Still searching…',
                seconds < 8 ? 'Comparing fingerprints with the library.' : 'Try moving closer to the speaker.');
        }
    }

    showMatch(match: Match, seconds: number): void {
        const { artist, title } = AppView.splitName(match.song);

        this.setState('matched');
        this.setText('Song identified', 'Tap the button to find another.');
        AppView.byId('result-title').textContent = title;
        AppView.byId('result-artist').textContent = artist || 'Unknown artist';
        AppView.paintCover(AppView.byId('result-cover'), match.song);

        AppView.byId('result-meta').replaceChildren(
            AppView.chip(`At ${AppView.formatTime(match.offsetSeconds)} in the track`),
            AppView.chip(`Matched in ${Math.round(seconds)} s`),
            AppView.chip(`${match.score} fingerprints agree`)
        );

        const youtube = AppView.byId<HTMLAnchorElement>('youtube');
        youtube.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(match.song)}`;
        this.againButton.focus({ preventScroll: true });
    }

    showNoMatch(): void {
        this.setState('no-match');
        this.setText('No match this time', 'It might not be in the library yet.');
        this.setNotice('Couldn’t recognise that one', 'A few things that usually help:', true);
        this.retryButton.focus({ preventScroll: true });
    }

    showError(message: string): void {
        this.setState('error');
        this.setText('Something went wrong', message);
        this.setNotice('Something went wrong', message, false);
    }

    // 0..1 microphone loudness drives the ripple size around the button
    setLevel(level: number): void {
        document.body.style.setProperty('--level', level.toFixed(3));
    }

    setLibrarySize(songs: number | null): void {
        this.libraryCount.textContent = songs === null
            ? 'Library offline'
            : `${songs.toLocaleString()} songs in library`;
    }

    renderHistory(entries: HistoryEntry[]): void {
        this.historyCard.hidden = entries.length === 0;
        this.historyList.replaceChildren(...entries.map(entry => {
            const { artist, title } = AppView.splitName(entry.song);

            const link = document.createElement('a');
            link.className = 'history-item';
            link.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(entry.song)}`;
            link.target = '_blank';
            link.rel = 'noopener';

            const cover = document.createElement('span');
            cover.className = 'cover cover-small';
            AppView.paintCover(cover, entry.song);

            const text = document.createElement('span');
            text.className = 'history-text';
            const titleEl = document.createElement('strong');
            titleEl.textContent = title;
            const artistEl = document.createElement('span');
            artistEl.textContent = artist || 'Unknown artist';
            text.append(titleEl, artistEl);

            const time = document.createElement('time');
            time.dateTime = new Date(entry.at).toISOString();
            time.textContent = AppView.timeAgo(entry.at);

            link.append(cover, text, time);
            const item = document.createElement('li');
            item.append(link);
            return item;
        }));
    }

    private setText(status: string, detail: string): void {
        this.status.textContent = status;
        this.detail.textContent = detail;
    }

    private setNotice(title: string, text: string, showTips: boolean): void {
        AppView.byId('notice-title').textContent = title;
        AppView.byId('notice-text').textContent = text;
        AppView.byId('notice-tips').hidden = !showTips;
    }

    // Song names are stored as "Artist - Title"
    static splitName(name: string): { artist: string; title: string } {
        const split = name.indexOf(' - ');
        return split > 0
            ? { artist: name.slice(0, split), title: name.slice(split + 3) }
            : { artist: '', title: name };
    }

    // No artwork in the library, so each song gets its own stable gradient + initials
    private static paintCover(element: HTMLElement, song: string): void {
        let hash = 0;
        for (const char of song) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
        const hue = hash % 360;
        const hue2 = (hue + 40 + (hash >> 9) % 80) % 360;
        element.style.background = `linear-gradient(135deg, hsl(${hue} 80% 62%), hsl(${hue2} 75% 38%))`;

        const words = AppView.splitName(song).title.replace(/\(.*?\)|\[.*?\]/g, '').trim().split(/\s+/);
        element.textContent = words.slice(0, 2).map(w => Array.from(w)[0] ?? '').join('').toUpperCase();
    }

    private static chip(text: string): HTMLLIElement {
        const chip = document.createElement('li');
        chip.textContent = text;
        return chip;
    }

    private static formatTime(seconds: number): string {
        const s = Math.max(0, seconds);
        return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    }

    private static timeAgo(at: number): string {
        const minutes = Math.round((Date.now() - at) / 60000);
        const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
        if (minutes < 60) return format.format(-minutes, 'minute');
        if (minutes < 60 * 24) return format.format(-Math.round(minutes / 60), 'hour');
        return format.format(-Math.round(minutes / (60 * 24)), 'day');
    }

    private static byId<T extends HTMLElement = HTMLElement>(id: string): T {
        const element = document.getElementById(id);
        if (!element) throw new Error(`Missing #${id} in index.html`);
        return element as T;
    }
}
