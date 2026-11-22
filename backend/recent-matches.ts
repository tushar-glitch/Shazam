import fs from 'node:fs';
import { backendConfig } from './config.js';

export type RecentMatch = { song: string; at: number };

// The last few songs identified by anyone on this server, newest first, kept on disk so a
// restart doesn't empty the list. A song already listed within repeatWindowMs is not added
// again: one listener's lyrics re-sync (a match every few seconds) must not flood the list.
export class RecentMatches {
    private entries: RecentMatch[];

    constructor(
        private readonly file: string = backendConfig.recentMatchesFile,
        private readonly limit: number = backendConfig.recentMatchesShown,
        private readonly repeatWindowMs: number = 10 * 60 * 1000
    ) {
        this.entries = file && fs.existsSync(file) ? RecentMatches.parse(fs.readFileSync(file, 'utf8')) : [];
    }

    record(song: string, now: number = Date.now()): void {
        if (this.entries.some(e => e.song === song && now - e.at < this.repeatWindowMs)) return;
        this.entries = [{ song, at: now }, ...this.entries.filter(e => e.song !== song)].slice(0, this.limit);
        if (this.file) {
            fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.entries));
            fs.renameSync(`${this.file}.tmp`, this.file);
        }
    }

    list(): RecentMatch[] {
        return [...this.entries];
    }

    private static parse(text: string): RecentMatch[] {
        try {
            const data: unknown = JSON.parse(text);
            return Array.isArray(data) ? data.filter((e): e is RecentMatch => typeof e?.song === 'string' && typeof e?.at === 'number') : [];
        } catch {
            return [];
        }
    }
}
