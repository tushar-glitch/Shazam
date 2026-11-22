type Entry = { name: string; titleWords: string[]; artistWords: string[] };

// Searches the library's song names ("Artist - Title") as you type. Forgiving on purpose:
// any word order, partial words ("kesar"), accents ("café" = "cafe") and one typo per word
// ("kesaria" finds "Kesariya"). Every word typed must match something in the name.
export class SongSearch {
    private readonly entries: Entry[];
    private static readonly version = /\b(lo-?fi|remix|mashup|vocals only|slowed|sped up|reverb|synthwave|nightcore|club mix|unplugged|instrumental|karaoke)\b/i;

    constructor(names: readonly string[]) {
        this.entries = names.map(name => {
            const split = name.indexOf(' - ');
            const artist = split > 0 ? name.slice(0, split) : '';
            const title = split > 0 ? name.slice(split + 3) : name;
            return { name, titleWords: SongSearch.words(title), artistWords: SongSearch.words(artist) };
        });
    }

    get size(): number {
        return this.entries.length;
    }

    // Best matches first; originals before their "Lofi Mix"/"Remix" versions (shorter names)
    search(query: string, limit = 20): string[] {
        const terms = SongSearch.words(query);
        if (terms.length === 0) return [];

        const hits: { name: string; score: number }[] = [];
        for (const entry of this.entries) {
            let score = 0;
            for (const term of terms) {
                // A title hit counts a little more than an artist hit
                const best = Math.max(SongSearch.wordScore(term, entry.titleWords) * 1.2, SongSearch.wordScore(term, entry.artistWords));
                if (best === 0) {
                    score = 0;
                    break;
                }
                score += best;
            }
            // Originals first: alternate versions rank a little lower than the song itself
            if (score > 0) hits.push({ name: entry.name, score: score - (SongSearch.version.test(entry.name) ? 1 : 0) });
        }
        hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
        return hits.slice(0, limit).map(h => h.name);
    }

    // How well one typed word matches the best of these words: exact 3, start 2, inside 1, one typo 0.5
    private static wordScore(term: string, words: readonly string[]): number {
        let best = 0;
        for (const word of words) {
            if (word === term) return 3;
            if (word.startsWith(term)) best = Math.max(best, 2);
            else if (term.length >= 3 && word.includes(term)) best = Math.max(best, 1);
            else if (best < 0.5 && term.length >= 4 && SongSearch.withinOneEdit(term, word)) best = 0.5;
        }
        return best;
    }

    // True if a and b differ by at most one inserted, deleted or changed letter
    static withinOneEdit(a: string, b: string): boolean {
        if (Math.abs(a.length - b.length) > 1) return false;
        let i = 0;
        let j = 0;
        let edits = 0;
        while (i < a.length && j < b.length) {
            if (a[i] === b[j]) {
                i++;
                j++;
                continue;
            }
            if (++edits > 1) return false;
            if (a.length > b.length) i++;
            else if (a.length < b.length) j++;
            else {
                i++;
                j++;
            }
        }
        return edits + (a.length - i) + (b.length - j) <= 1;
    }

    // Lower case, accents removed, split on anything that is not a letter or digit
    static words(text: string): string[] {
        return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    }
}
