import { songRow, splitName } from './song-glyph.js';
import { SongSearch } from './song-search.js';

// The searchable song library: the first thing on the page, so a visitor checks a song is
// indexed before playing it. Results are plain information, not links.
// All text goes through textContent, so song names can never inject HTML.
export class LibraryView {
    private readonly summary = LibraryView.byId('library-summary');
    private readonly input = LibraryView.byId<HTMLInputElement>('library-search');
    private readonly hint = LibraryView.byId('library-hint');
    private readonly results = LibraryView.byId('library-results');
    private search: SongSearch | null = null;

    constructor() {
        this.input.addEventListener('input', () => this.render());
        // "/" jumps to the search from anywhere (unless typing in a field already)
        document.addEventListener('keydown', event => {
            if (event.key !== '/' || event.target instanceof HTMLInputElement) return;
            event.preventDefault();
            this.focusSearch();
        });
    }

    setLibrary(songs: string[]): void {
        this.search = new SongSearch(songs);
        const artists = new Set(songs.map(s => splitName(s).artist).filter(Boolean)).size;
        this.summary.textContent = `${songs.length.toLocaleString()} songs by ${artists.toLocaleString()} artists are indexed. Only these can be recognised, so search before you play.`;
        this.render();
    }

    setUnavailable(): void {
        this.summary.textContent = 'The library list could not be loaded right now.';
    }

    focusSearch(): void {
        this.input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.input.focus({ preventScroll: true });
    }

    private render(): void {
        const query = this.input.value.trim();
        if (!this.search || !query) {
            this.hint.textContent = '';
            this.results.replaceChildren();
            return;
        }
        const found = this.search.search(query, 20);
        this.hint.textContent = found.length === 0
            ? `No match for “${query}”: not in the library yet, so it can’t be recognised`
            : found.length === 20 ? 'Top 20 matches · type more to narrow down' : `${found.length} in the library`;
        this.results.replaceChildren(...found.map(song => songRow(song, 'Indexed')));
    }

    private static byId<T extends HTMLElement = HTMLElement>(id: string): T {
        const element = document.getElementById(id);
        if (!element) throw new Error(`Missing #${id} in index.html`);
        return element as T;
    }
}
