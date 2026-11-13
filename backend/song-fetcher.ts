import fs from 'node:fs';
import path from 'node:path';
import { backendConfig } from './config.js';
import type { SongIndexer } from './song-indexer.js';

type Track = { trackName: string; artistName: string; previewUrl?: string };
type Source = { label: string; getTracks: () => Promise<Track[]> };

// Downloads popular songs: Apple top charts + an iTunes search for each line in
// queries.txt. Free, no API key, but only 30 s previews.
// Download → index → next. Files already on disk or in the DB are skipped,
// so a run can be stopped and restarted safely.
export class SongFetcher {
    constructor(
        private readonly indexer: SongIndexer,
        private readonly songsDir: string = backendConfig.songsDir,
        private readonly queriesFile: string = backendConfig.queriesFile
    ) {}

    async run(): Promise<void> {
        fs.mkdirSync(this.songsDir, { recursive: true });

        for (const { label, getTracks } of this.sources()) {
            try {
                const tracks = await getTracks();
                console.log(`\n== ${label}: ${tracks.length} tracks`);
                await this.downloadAndIndex(tracks);
            } catch (error) {
                console.error(`Source failed "${label}": ${(error as Error).message}`);
            }
        }
    }

    private sources(): Source[] {
        const charts = ['in', 'us', 'gb'].map(country => ({
            label: `Top 100 (${country})`,
            getTracks: () => this.chartTracks(country)
        }));

        const searches = fs.readFileSync(this.queriesFile, 'utf8')
            .split(/\r?\n/).map(q => q.trim()).filter(Boolean)
            .map(query => ({
                label: `Search "${query}"`,
                getTracks: () => this.searchTracks(query)
            }));

        return [...charts, ...searches];
    }

    // Pause after every call to stay under the iTunes rate limit
    private async itunes(url: string): Promise<any> {
        const response = await fetch(url);
        await new Promise(resolve => setTimeout(resolve, backendConfig.itunesDelayMs));
        if (!response.ok) throw new Error(`${response.status} for ${url}`);
        return response.json();
    }

    private async chartTracks(country: string): Promise<Track[]> {
        const feed = await this.itunes(`https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/songs.json`);
        const ids = feed.feed.results.map((r: { id: string }) => r.id).join(',');
        return (await this.itunes(`https://itunes.apple.com/lookup?id=${ids}&country=${country}`)).results;
    }

    private async searchTracks(query: string): Promise<Track[]> {
        const term = encodeURIComponent(query);
        return (await this.itunes(`https://itunes.apple.com/search?term=${term}&entity=song&country=in&limit=200`)).results;
    }

    private async downloadAndIndex(tracks: Track[]): Promise<void> {
        for (const track of tracks) {
            if (!track.previewUrl) continue;

            const name = `${track.artistName} - ${track.trackName}`.replace(/[\\/:*?"<>|]/g, '').trim();
            const file = path.join(this.songsDir, `${name}.m4a`);

            if (!fs.existsSync(file)) {
                try {
                    await this.download(track.previewUrl, file);
                } catch (error) {
                    console.error(`Download failed "${name}": ${(error as Error).message}`);
                    continue;
                }
            }

            this.indexer.indexFile(file);
        }
    }

    // Write to .part then rename, so an interrupted download never looks complete
    private async download(url: string, file: string): Promise<void> {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        fs.writeFileSync(`${file}.part`, Buffer.from(await response.arrayBuffer()));
        fs.renameSync(`${file}.part`, file);
    }
}
