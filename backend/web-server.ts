import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Fingerprint } from '../engine/index.js';
import { backendConfig } from './config.js';
import type { FingerprintDatabase } from './fingerprint-database.js';
import type { LyricsService } from './lyrics-service.js';
import type { RecentMatches } from './recent-matches.js';
import type { SongMatcher } from './song-matcher.js';

// Resolve files against the project root (this file runs from dist/backend/), not the working directory
const projectRoot = path.join(import.meta.dirname, '..', '..');

const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
};

// Serves the frontend + the matching API:
//   GET  /                  the web app
//   GET  /api/stats         { songs: number }
//   POST /match             body [[hash, t], ...] → Match | null
//   GET  /api/lyrics?song=  Lyrics for a song in the library
//   GET  /api/songs         { songs: every song name, images: { song: cover image URL } }
//   GET  /api/recent        { now, recent: [{ song, at }] } the last songs anyone identified
// The browser fingerprints the mic audio itself and sends only [hash, t] pairs.
export class WebServer {
    constructor(
        private readonly db: FingerprintDatabase,
        private readonly matcher: SongMatcher,
        private readonly lyrics: LyricsService,
        private readonly recent: RecentMatches,
        private readonly images: Record<string, string>,
        private readonly port: number = backendConfig.port
    ) {}

    start(): void {
        http.createServer((req, res) => this.handle(req, res))
            .listen(this.port, () => console.log(`Listening on http://localhost:${this.port}`));
    }

    // Trust boundary: accept only a bounded array of [int hash, int t] pairs
    static parsePrints(body: string): Fingerprint[] | null {
        let data: unknown;
        try { data = JSON.parse(body); } catch { return null; }

        if (!Array.isArray(data) || data.length > backendConfig.maxPairs) return null;

        const prints: Fingerprint[] = [];
        for (const pair of data) {
            if (!Array.isArray(pair) || pair.length !== 2) return null;
            const [hash, t] = pair;
            if (!Number.isInteger(hash) || hash < 0 || hash >= 2 ** 26) return null;
            if (!Number.isInteger(t) || t < 0 || t > 1e6) return null;
            prints.push({ hash, t });
        }
        return prints;
    }

    // Only these URLs map to files. Module names are restricted to [a-z0-9-],
    // so a request can never climb out of these folders ("../").
    static staticFile(url: string): string | undefined {
        const fixed: Record<string, string> = {
            '/': 'frontend/index.html',
            '/frontend/styles.css': 'frontend/styles.css',
            '/frontend/worklet.js': 'frontend/worklet.js',
        };
        if (fixed[url]) return fixed[url];

        const module = /^\/(frontend|engine)\/([a-z0-9-]+)\.js$/.exec(url);
        return module ? `dist/${module[1]}/${module[2]}.js` : undefined;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = (req.url ?? '/').split('?')[0]!;

        if (req.method === 'POST' && url === '/match') return this.handleMatch(req, res);
        if (req.method === 'GET' && url === '/api/stats') return this.sendJson(res, { songs: this.db.songCount() });
        if (req.method === 'GET' && url === '/api/lyrics') return void this.handleLyrics(req, res);
        if (req.method === 'GET' && url === '/api/songs') return this.sendJson(res, { songs: this.db.songNames(), images: this.images });
        if (req.method === 'GET' && url === '/api/recent') {
            return this.sendJson(res, { now: Date.now(), recent: this.recent.list() });
        }
        if (req.method === 'GET') return this.serveStatic(url, res);

        res.writeHead(405).end();
    }

    private handleMatch(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
            if (body.length > backendConfig.maxBodyBytes) {
                res.writeHead(413).end();
                req.destroy();
            }
        });
        req.on('end', () => {
            if (res.headersSent) return;
            const prints = WebServer.parsePrints(body);
            if (!prints) return void res.writeHead(400).end('Expected [[hash, t], ...]');
            const match = this.matcher.match(prints);
            if (match && match.confidence >= 1) this.recent.record(match.song);
            this.sendJson(res, match);
        });
    }

    // Only songs in the library: the server never becomes an open proxy to the lyrics service
    private async handleLyrics(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const song = new URL(req.url ?? '/', 'http://localhost').searchParams.get('song') ?? '';
        if (!song || song.length > 300 || !this.db.hasSong(song)) return void res.writeHead(404).end('Unknown song');
        try {
            this.sendJson(res, await this.lyrics.get(song));
        } catch (error) {
            console.error(`Lyrics lookup failed for "${song}": ${(error as Error).message}`);
            res.writeHead(502).end('Lyrics service unavailable');
        }
    }

    private serveStatic(url: string, res: http.ServerResponse): void {
        const file = WebServer.staticFile(url);
        if (!file) return void res.writeHead(404).end();

        // A missing file (e.g. frontend not compiled) must answer 404, not crash the server
        fs.createReadStream(path.join(projectRoot, file))
            .on('error', () => void (res.headersSent ? res.destroy() : res.writeHead(404).end()))
            .on('open', () => res.writeHead(200, {
                'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
                'Cache-Control': 'no-cache'
            }))
            .pipe(res);
    }

    private sendJson(res: http.ServerResponse, data: unknown): void {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }
}
