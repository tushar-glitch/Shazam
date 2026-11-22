import fs from 'node:fs';
import type { LyricLine, Lyrics } from '../engine/index.js';
import { backendConfig } from './config.js';

// One search result from LRCLIB (https://lrclib.net/docs)
type LrclibTrack = {
    trackName?: string;
    artistName?: string;
    instrumental?: boolean;
    plainLyrics?: string | null;
    syncedLyrics?: string | null;
};

type CacheEntry = { lyrics: Lyrics; fetchedAt: number };

// Finds lyrics for a library song ("Artist - Title") on LRCLIB, preferring time-synced ones.
// Every answer is cached on disk, so each song is looked up once; "not found" is retried
// after lyricsNotFoundRetryDays (LRCLIB is community-run and keeps growing).
export class LyricsService {
    private readonly cache: Record<string, CacheEntry>;
    private readonly inFlight = new Map<string, Promise<Lyrics>>();

    constructor(
        private readonly apiUrl: string = backendConfig.lyricsApiUrl,
        private readonly cacheFile: string = backendConfig.lyricsCacheFile,
        private readonly fetchImpl: typeof fetch = fetch
    ) {
        this.cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
    }

    async get(song: string): Promise<Lyrics> {
        const cached = this.cache[song];
        const retryAfter = backendConfig.lyricsNotFoundRetryDays * 24 * 3600 * 1000;
        if (cached && (cached.lyrics.status !== 'not-found' || Date.now() - cached.fetchedAt < retryAfter)) return cached.lyrics;

        // Two listeners asking for the same new song share one lookup
        let pending = this.inFlight.get(song);
        if (!pending) {
            pending = this.lookUp(song).finally(() => this.inFlight.delete(song));
            this.inFlight.set(song, pending);
        }
        const lyrics = await pending;
        this.cache[song] = { lyrics, fetchedAt: Date.now() };
        this.save();
        return lyrics;
    }

    // Tries the exact names first, then cleaned-up ones, then a free-text search
    private async lookUp(song: string): Promise<Lyrics> {
        const { artist, title } = LyricsService.splitName(song);
        const titles = LyricsService.titleVariants(title);
        const artists = LyricsService.artistVariants(artist);

        const queries: Record<string, string>[] = [];
        for (const t of titles) for (const a of artists) queries.push({ track_name: t, artist_name: a });
        queries.push({ q: `${titles.at(-1)} ${artists.at(-1)}`.trim() });

        for (const query of queries) {
            const best = LyricsService.pickBest(await this.search(query), titles[titles.length - 1]!, artist);
            if (best) return LyricsService.toLyrics(best);
        }
        return { status: 'not-found' };
    }

    private async search(query: Record<string, string>): Promise<LrclibTrack[]> {
        const url = `${this.apiUrl.replace(/\/+$/, '')}/api/search?${new URLSearchParams(query)}`;
        const response = await this.fetchImpl(url, {
            headers: { 'User-Agent': 'Constellation song finder (personal project)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`Lyrics service answered ${response.status}`);
        const body: unknown = await response.json();
        return Array.isArray(body) ? body as LrclibTrack[] : [];
    }

    // Prefers synced lyrics, then a title that matches, then an artist that matches
    static pickBest(tracks: LrclibTrack[], title: string, artist: string): LrclibTrack | undefined {
        const wantTitle = LyricsService.normalize(title);
        const wantArtists = new Set(LyricsService.normalize(artist).split(' ').filter(w => w.length > 1));
        let best: LrclibTrack | undefined;
        let bestScore = 0;
        for (const track of tracks) {
            if (!track.syncedLyrics && !track.plainLyrics && !track.instrumental) continue;
            const gotTitle = LyricsService.normalize(LyricsService.titleVariants(track.trackName ?? '').at(-1)!);
            const titleScore = gotTitle === wantTitle ? 4 : gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle) ? 2 : 0;
            if (titleScore === 0) continue; // a different song
            const artistScore = LyricsService.normalize(track.artistName ?? '').split(' ').some(w => wantArtists.has(w)) ? 2 : 0;
            const score = titleScore + artistScore + (track.syncedLyrics ? 3 : 0);
            if (score > bestScore) {
                best = track;
                bestScore = score;
            }
        }
        return best;
    }

    static toLyrics(track: LrclibTrack): Lyrics {
        if (track.syncedLyrics) {
            const lines = LyricsService.parseLrc(track.syncedLyrics);
            if (lines.length > 0) return { status: 'synced', lines };
        }
        if (track.plainLyrics?.trim()) return { status: 'plain', text: track.plainLyrics.trim() };
        return track.instrumental ? { status: 'instrumental' } : { status: 'not-found' };
    }

    // LRC: "[mm:ss.xx] text". A line may carry several timestamps (a repeated chorus written once);
    // [offset:±ms] shifts everything; other [tag:value] lines are metadata.
    static parseLrc(lrc: string): LyricLine[] {
        let offset = 0;
        const lines: LyricLine[] = [];
        for (const raw of lrc.split(/\r?\n/)) {
            const tag = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw.trim());
            if (tag) offset = Number(tag[1]) / 1000;

            const stamps: number[] = [];
            let rest = raw.trim();
            for (let m; (m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest)); rest = rest.slice(m[0].length)) {
                stamps.push(Number(m[1]) * 60 + Number(m[2]!.replace(':', '.')));
            }
            const text = rest.trim();
            for (const time of stamps) lines.push({ time, text });
        }
        // LRC offset: positive = lyrics come earlier
        return lines.map(l => ({ time: Math.max(0, l.time - offset), text: l.text })).sort((a, b) => a.time - b.time);
    }

    // Song names are stored as "Artist - Title"
    static splitName(song: string): { artist: string; title: string } {
        const split = song.indexOf(' - ');
        return split > 0 ? { artist: song.slice(0, split).trim(), title: song.slice(split + 3).trim() } : { artist: '', title: song.trim() };
    }

    // Original title, then without decorations such as (From "Film"), [Remastered], feat. X, - Remix
    static titleVariants(title: string): string[] {
        const cleaned = title
            .replace(/\s*[([][^)\]]*(from|feat|ft\.|remaster|version|edit|live|mono|stereo)[^)\]]*[)\]]/gi, '')
            .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
            .replace(/\s+-\s+(from|remaster|.*version|.*edit|live).*$/i, '')
            .trim();
        const bare = cleaned.replace(/\s*[([].*?[)\]]/g, '').trim();
        return [...new Set([title.trim(), cleaned, bare].filter(Boolean))];
    }

    // "A.R. Rahman & Arijit Singh" → the full credit, then the first artist alone
    static artistVariants(artist: string): string[] {
        const first = artist.split(/\s*(?:,|&|\band\b|\bx\b|feat\.?|ft\.?)\s*/i)[0]?.trim() ?? '';
        return [...new Set([artist.trim(), first].filter(Boolean))];
    }

    private static normalize(text: string): string {
        return text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    // Write to a temp file then rename, so a crash never leaves half-written JSON
    private save(): void {
        fs.writeFileSync(`${this.cacheFile}.tmp`, JSON.stringify(this.cache));
        fs.renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    }
}
