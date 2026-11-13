import fs from 'node:fs';
import path from 'node:path';
import { backendConfig } from './config.js';
import { FingerprintPool } from './fingerprint-pool.js';
import type { SongIndexer } from './song-indexer.js';

export type LicensedTrack = { artist: string; title: string; url: string; id?: string; image_url?: string };
export type LicensedPage = { ready: boolean; hasMore: boolean; songs: LicensedTrack[] };
type Progress = Record<string, number>;                         // artist → next page to fetch, or DONE
const DONE = -1;                                                // artist has no more pages
type RetryPages = Record<string, number[]>;                     // artist → pages that had failed songs
const retryFile = './licensed-retry.json';                     // revisited at the start of every run
type Metadata = Record<string, { id?: string; image_url?: string }>; // "Artist - Title" → provider info

// Walks the provider's catalogue breadth first: page 1 of every artist (names from queries.txt),
// then page 2 of every artist, and so on.
//   GET <licensedTracksUrl>/<artist>/<page>  →  10 songs per page
// Each song: download → fingerprint → store id + image_url in the metadata file → delete the audio.
// After a page is done the artist's page number goes up by one and is saved to disk, so a run
// can be stopped at any time and the next run continues from the same page.
// New hashes are staged (fast) and only become matchable after db.mergePending(), which the
// CLI runs at the end of the command and before `serve`.
export class LicensedFetcher {
    private readonly progress: Progress;
    private readonly metadata: Metadata;
    private readonly seenIds: Set<string>;
    private readonly retry: RetryPages;
    private readonly inFlight = new Set<string>(); // names + ids being processed right now
    private readonly pool = new FingerprintPool();

    constructor(
        private readonly indexer: SongIndexer,
        private readonly endpoint: string = backendConfig.licensedTracksUrl,
        private readonly dir: string = backendConfig.fullSongsDir
    ) {
        this.progress = LicensedFetcher.readJson(backendConfig.licensedProgressFile, {});
        this.metadata = LicensedFetcher.readJson(backendConfig.licensedMetadataFile, {});
        this.retry = LicensedFetcher.readJson(retryFile, {});
        this.seenIds = new Set(Object.values(this.metadata).map(m => m.id).filter((id): id is string => !!id));
    }

    // Several artists at once (downloads overlap); decoding + fingerprinting runs on worker threads
    async run(parallelArtists = 6): Promise<void> {
        if (!this.endpoint) throw new Error('Set LICENSED_TRACKS_URL (or licensedTracksUrl in backend/config.ts)');
        fs.mkdirSync(this.dir, { recursive: true });

        const artists = fs.readFileSync(backendConfig.queriesFile, 'utf8')
            .split(/\r?\n/).map(a => a.trim()).filter(Boolean);
        // Provider pages start at 1 (also repairs a 0 from an older progress file)
        for (const artist of artists) {
            if (this.progress[artist] !== DONE) this.progress[artist] = Math.max(1, this.progress[artist] ?? 1);
        }
        this.saveProgress();

        console.log(`${parallelArtists} artists at a time, ${this.pool.size} fingerprint threads`);

        // Breadth first: an artist does ONE page, then goes to the back of the queue, so every
        // artist gets page 1 before any artist gets page 2. An artist is in the queue at most
        // once, so two workers never fetch the same artist at the same time.
        const queue = artists.filter(artist => this.progress[artist] !== DONE);
        const retried = new Set<string>();
        try {
            await Promise.all(Array.from({ length: parallelArtists }, async () => {
                while (queue.length) {
                    const artist = queue.shift()!;
                    if (!retried.has(artist)) {
                        retried.add(artist);
                        await this.retryFailedPages(artist);
                    }
                    if (await this.fetchNextPage(artist)) queue.push(artist);
                }
            }));
        } finally {
            await this.pool.close();
        }
    }

    // Pages that had failed songs are revisited once per run, before the artist's next page
    private async retryFailedPages(artist: string): Promise<void> {
        for (const page of [...(this.retry[artist] ?? [])]) {
            console.log(`\n== ${artist}: retrying failed songs of page ${page}`);
            await this.processPage(artist, page); // still failing = stays in the list
        }
    }

    // One page of one artist. true = the artist has more pages, put it back in the queue.
    private async fetchNextPage(artist: string): Promise<boolean> {
        const page = this.progress[artist]!;
        const result = await this.processPage(artist, page);
        if (!result) return false; // page number not advanced: retried on the next run

        if (!result.hasMore || result.songs.length === 0) {
            this.progress[artist] = DONE;
            this.saveProgress();
            console.log(`== ${artist}: done`);
            return false;
        }

        this.progress[artist] = page + 1;
        this.saveProgress();
        return true;
    }

    // Fetches one page and processes its songs. A page with failed songs is remembered in the
    // retry file; songs already indexed are skipped as copies when it is revisited.
    // Returns null if the page itself could not be loaded.
    private async processPage(artist: string, page: number): Promise<LicensedPage | null> {
        const url = `${this.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(artist)}/${page}`;

        let result: LicensedPage;
        try {
            const response = await LicensedFetcher.fetchWithRetry(url);
            if (!response.ok) throw new Error(await LicensedFetcher.describeError(response));
            result = LicensedFetcher.parsePage(await response.json());
        } catch (error) {
            console.error(`== ${artist} page ${page}: ${(error as Error).message}; skipping artist for now`);
            return null;
        }

        if (!result.ready) {
            console.log(`== ${artist}: provider not ready yet; skipping for now`);
            return null;
        }

        console.log(`\n== ${artist} page ${page}: ${result.songs.length} songs`);
        let failed = 0;
        for (const track of result.songs) if (!(await this.processTrack(track))) failed++;

        const pages = new Set(this.retry[artist] ?? []);
        if (failed) pages.add(page); else pages.delete(page);
        if (pages.size) this.retry[artist] = [...pages].sort((a, b) => a - b); else delete this.retry[artist];
        LicensedFetcher.writeJson(retryFile, this.retry);
        return result;
    }

    // true = indexed now or already (copy); false = failed, its page will be retried
    private async processTrack(track: LicensedTrack): Promise<boolean> {
        const name = LicensedFetcher.songName(track);

        // Provider sends copies: same id, or the same "Artist - Title" under another id.
        // inFlight catches a copy that another artist is processing right now.
        const keys = [name, ...(track.id ? [track.id] : [])];
        if ((track.id && this.seenIds.has(track.id)) || this.metadata[name] || keys.some(k => this.inFlight.has(k))) {
            console.log(`Skip copy "${name}"`);
            return true; // ponytail: if the in-flight copy then fails, this one isn't retried; track pairs if that matters
        }
        for (const k of keys) this.inFlight.add(k);

        const file = path.join(this.dir, `${name}${path.extname(new URL(track.url).pathname) || '.audio'}.part`);
        try {
            const response = await LicensedFetcher.fetchWithRetry(track.url);
            if (!response.ok) throw new Error(await LicensedFetcher.describeError(response));
            fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));

            const count = this.indexer.addPrints(name, await this.pool.fingerprintFile(file), true);
            this.metadata[name] = { ...(track.id && { id: track.id }), ...(track.image_url && { image_url: track.image_url }) };
            if (track.id) this.seenIds.add(track.id);
            LicensedFetcher.writeJson(backendConfig.licensedMetadataFile, this.metadata);
            console.log(`Indexed "${name}" (${count} hashes)`);
            return true;
        } catch (error) {
            // One bad track must not stop a run over thousands
            console.error(`Failed "${name}": ${(error as Error).message}`);
            return false;
        } finally {
            for (const k of keys) this.inFlight.delete(k);
            fs.rmSync(file, { force: true }); // audio is only needed until it is fingerprinted
        }
    }

    // Connections to the provider sometimes drop ("fetch failed"): retry those, and busy/5xx answers,
    // after a short wait. Other HTTP errors (4xx) are returned as they are.
    private static async fetchWithRetry(url: string, waitsMs = [2000, 5000, 15000]): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
                if ((response.status !== 429 && response.status < 500) || attempt >= waitsMs.length) return response;
            } catch (error) {
                if (attempt >= waitsMs.length) {
                    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
                    throw new Error(`${(error as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ''}`);
                }
            }
            await new Promise(resolve => setTimeout(resolve, waitsMs[attempt]));
        }
    }

    // Status code + the start of the provider's message, which usually says why
    private static async describeError(response: Response): Promise<string> {
        const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
        return `HTTP ${response.status}${body ? ` (${body})` : ''}`;
    }

    private saveProgress(): void {
        LicensedFetcher.writeJson(backendConfig.licensedProgressFile, this.progress);
    }

    // "Atak Gaya - Arijit Singh" by "Arijit Singh" → "Arijit Singh - Atak Gaya" (the UI splits on the first " - ")
    static songName({ artist, title }: LicensedTrack): string {
        const suffix = ` - ${artist}`;
        const cleanTitle = title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
        return `${artist.trim()} - ${cleanTitle.trim()}`.replace(/[\\/:*?"<>|]/g, '').trim();
    }

    // The provider is outside our control: keep only well-formed http(s) songs
    static parsePage(body: unknown): LicensedPage {
        const page = body as { ready?: unknown; hasMore?: unknown; songs?: unknown };
        if (typeof page !== 'object' || page === null || !Array.isArray(page.songs)) {
            throw new Error('Expected { songs: [...] }');
        }
        const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
        const songs = page.songs.filter((t): t is LicensedTrack =>
            text(t?.artist) && text(t.title) && typeof t.url === 'string' && /^https?:\/\//.test(t.url) && URL.canParse(t.url)
        );
        return { ready: page.ready !== false, hasMore: page.hasMore === true, songs };
    }

    private static readJson<T>(file: string, fallback: T): T {
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
    }

    // Write to a temp file then rename, so a crash never leaves half-written JSON
    private static writeJson(file: string, data: unknown): void {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
        fs.renameSync(`${file}.tmp`, file);
    }
}
