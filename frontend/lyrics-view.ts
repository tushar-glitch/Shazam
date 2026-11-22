import type { LyricLine, Lyrics } from '../engine/index.js';

const leadSeconds = 0.2; // light a line up slightly before it is sung, which feels in time

// The lyrics card. Synced lyrics scroll so the line being sung stays in the middle.
// All text goes through textContent, so lyrics from the internet can never inject HTML.
export class LyricsView {
    readonly stopButton = LyricsView.byId<HTMLButtonElement>('lyrics-stop');
    private readonly card = LyricsView.byId('lyrics');
    private readonly lines = LyricsView.byId('lyrics-lines');
    private readonly status = LyricsView.byId('lyrics-status');
    private synced: LyricLine[] = [];
    private elements: HTMLElement[] = [];
    private active = -2;
    private uncertain = false;

    showLoading(): void {
        this.reset();
        this.card.hidden = false;
        this.setStatus('Looking for lyrics…');
    }

    show(lyrics: Lyrics): void {
        this.reset();
        this.card.hidden = false;
        if (lyrics.status === 'synced') {
            this.synced = lyrics.lines;
            this.elements = lyrics.lines.map(line => {
                const element = document.createElement('p');
                element.className = 'lyric';
                element.textContent = line.text || '♪';
                if (!line.text) element.classList.add('lyric-gap');
                return element;
            });
            this.lines.replaceChildren(...this.elements);
            this.setStatus('Following along');
        } else if (lyrics.status === 'plain') {
            const text = document.createElement('p');
            text.className = 'lyrics-plain';
            text.textContent = lyrics.text;
            this.lines.replaceChildren(text);
            this.setStatus('Only unsynced lyrics are available for this song');
        } else {
            const message = document.createElement('p');
            message.className = 'lyrics-empty';
            message.textContent = lyrics.status === 'instrumental' ? '♪ This track is instrumental ♪' : 'Lyrics are not available for this song.';
            this.lines.replaceChildren(message);
            this.setStatus('');
        }
        this.card.dataset.kind = lyrics.status;
    }

    showUnavailable(): void {
        this.show({ status: 'not-found' });
        this.setStatus('Couldn’t reach the lyrics service');
    }

    // positions: where in the song we may be, most likely first. Several = a repeated part,
    // so only what all of them agree on is shown; the following lines stay dimmed.
    update(positions: number[]): void {
        if (this.synced.length === 0) return;
        const indexes = positions.map(p => this.lineAt(p + leadSeconds));
        const index = indexes[0]!;
        const sameText = indexes.every(i => this.textAt(i) === this.textAt(index));
        const uncertain = positions.length > 1;

        if (uncertain !== this.uncertain) {
            this.uncertain = uncertain;
            this.card.classList.toggle('uncertain', uncertain);
            this.setStatus(uncertain ? 'This part repeats in the song: finding your place…' : 'Following along');
            this.active = -2; // re-render: which lines are shown as certain changed
        }
        if (index === this.active) return;
        this.active = index;

        this.elements.forEach((element, i) => {
            element.classList.toggle('active', i === index && (sameText || !uncertain));
            element.classList.toggle('past', i < index);
        });
        // Keep the active line in the middle of the window (before the first line: the top)
        const target = this.elements[Math.max(0, index)]!;
        const middle = (this.lines.parentElement!.clientHeight - target.offsetHeight) / 2;
        this.lines.style.transform = `translateY(${Math.round(middle - target.offsetTop)}px)`;
    }

    setStatus(text: string): void {
        this.status.textContent = text;
    }

    hide(): void {
        this.reset();
        this.card.hidden = true;
    }

    private reset(): void {
        this.synced = [];
        this.elements = [];
        this.active = -2;
        this.uncertain = false;
        this.card.classList.remove('uncertain');
        this.lines.style.transform = '';
        this.lines.replaceChildren();
    }

    // Index of the last line that started at or before `seconds` (-1 = before the first line)
    private lineAt(seconds: number): number {
        let lo = 0;
        let hi = this.synced.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.synced[mid]!.time <= seconds) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found;
    }

    private textAt(index: number): string {
        return index < 0 ? '' : this.synced[index]!.text;
    }

    private static byId<T extends HTMLElement = HTMLElement>(id: string): T {
        const element = document.getElementById(id);
        if (!element) throw new Error(`Missing #${id} in index.html`);
        return element as T;
    }
}
