export type HistoryEntry = { song: string; at: number };

// Recent matches, kept in this browser only. Storage can be unavailable
// (private mode, blocked site data), so every access is guarded.
export class MatchHistory {
    private static readonly key = 'constellation.history';
    private static readonly limit = 6;

    all(): HistoryEntry[] {
        try {
            const data: unknown = JSON.parse(localStorage.getItem(MatchHistory.key) ?? '[]');
            if (!Array.isArray(data)) return [];
            return data.filter((e): e is HistoryEntry => typeof e?.song === 'string' && typeof e?.at === 'number');
        } catch {
            return [];
        }
    }

    add(song: string): HistoryEntry[] {
        const entries = [{ song, at: Date.now() }, ...this.all().filter(e => e.song !== song)].slice(0, MatchHistory.limit);
        this.save(entries);
        return entries;
    }

    clear(): void {
        this.save([]);
    }

    private save(entries: HistoryEntry[]): void {
        try {
            localStorage.setItem(MatchHistory.key, JSON.stringify(entries));
        } catch {
            // Not persisted; the list still shows for this visit
        }
    }
}
