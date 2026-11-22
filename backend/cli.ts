import fs from 'node:fs';
import path from 'node:path';
import { Fingerprinter } from '../engine/index.js';
import { AudioDecoder } from './audio-decoder.js';
import { backendConfig } from './config.js';
import { LicensedFetcher } from './licensed-fetcher.js';
import { LyricsService } from './lyrics-service.js';
import { RecentMatches } from './recent-matches.js';
import { loadSongImages } from './song-images.js';
import { SelfCheck } from './self-check.js';
import { SongFetcher } from './song-fetcher.js';
import { SongIndexer } from './song-indexer.js';
import { SongMatcher } from './song-matcher.js';
import { BackgroundCompactor } from './storage/compaction.js';
import { FingerprintIndex, type IndexOptions } from './storage/fingerprint-index.js';
import { importLegacy } from './storage/legacy-import.js';
import { WebServer } from './web-server.js';

const usage = `Usage:
  npm start -- serve                 web app + matching API on http://localhost:${backendConfig.port}
  npm start -- fetch                 download popular songs into ./songs and index each one
  npm start -- fetch-licensed        [artistsAtOnce=6]  index every artist in queries.txt from the licensed API (resumes)
  npm start -- index [folder]        index every audio file in a folder (default ./songs)
  npm start -- add <audioFile> [name]
  npm start -- match <audioFile>
  npm start -- index-stats           songs, segments and size of the index
  npm start -- import-legacy [file]  build the index from an old ${backendConfig.dbPath} (opened read-only, never changed)`;

const WRITE_COMMANDS = new Set(['fetch', 'fetch-licensed', 'index', 'add']);

const indexOptions: IndexOptions = {
    flushPostings: backendConfig.flushPostings,
    flushIntervalMs: backendConfig.flushIntervalMs,
    mergeFactor: backendConfig.mergeFactor,
};

// Reads the command you typed and wires the right objects together
export class Cli {
    async run([command, file, name]: string[]): Promise<void> {
        SelfCheck.run();

        if (command === 'import-legacy') return this.importLegacy(file ?? backendConfig.dbPath);

        if (!FingerprintIndex.exists(backendConfig.indexDir) && fs.existsSync(backendConfig.dbPath)) {
            throw new Error(
                `Found ${backendConfig.dbPath} from the previous version, but no index in ${backendConfig.indexDir}.\n` +
                `Run "npm start -- import-legacy" first (it only reads ${backendConfig.dbPath}, never changes it).`
            );
        }

        // Commands that add songs merge segments on a worker thread as they go
        const compactor = WRITE_COMMANDS.has(command ?? '')
            ? new BackgroundCompactor({ dir: backendConfig.indexDir, options: indexOptions })
            : null;
        const index = FingerprintIndex.open(backendConfig.indexDir, {
            ...indexOptions,
            ...(compactor && { onFlush: () => compactor.request() }),
        });
        compactor?.request(); // catch up on merges an earlier run did not finish

        if (command === 'serve') {
            console.log(`Songs in index: ${index.songCount()}`);
            new WebServer(index, new SongMatcher(index), new LyricsService(), new RecentMatches(), loadSongImages(backendConfig.licensedMetadataFile)).start();
            return; // keep the index open while the server runs
        }

        try {
            await this.runCommand(command, file, name, index);
        } finally {
            index.close(); // flushes songs still in the write-ahead log
            if (compactor) {
                console.log('Finishing background merges...');
                await compactor.close();
            }
        }
    }

    private async runCommand(command: string | undefined, file: string | undefined, name: string | undefined, index: FingerprintIndex): Promise<void> {
        const indexer = new SongIndexer(index);

        if (command === 'fetch') {
            await new SongFetcher(indexer).run();
            console.log(`\nDone. Songs in index: ${index.songCount()}`);
        } else if (command === 'fetch-licensed') {
            await new LicensedFetcher(indexer).run(Number(file) || undefined);
            console.log(`\nDone. Songs in index: ${index.songCount()}`);
        } else if (command === 'index') {
            indexer.indexFolder(file ?? backendConfig.songsDir);
            console.log(`\nDone. Songs in index: ${index.songCount()}`);
        } else if (command === 'add' && file) {
            const count = indexer.addAudio(name ?? path.parse(file).name, AudioDecoder.decode(file));
            console.log(`Added (${count} hashes). Songs in index: ${index.songCount()}`);
        } else if (command === 'match' && file) {
            const match = new SongMatcher(index).match(new Fingerprinter().fingerprintAudio(AudioDecoder.decode(file)));
            console.log(match
                ? `Match: "${match.song}" at ${match.offsetSeconds.toFixed(1)} s (score ${match.score})`
                : 'No match');
        } else if (command === 'index-stats') {
            Cli.printStats(index);
        } else {
            console.log(`Self-check passed.\n${usage}`);
        }
    }

    // Reads the old single-file store (read-only) into a new, empty index and verifies the result
    private async importLegacy(legacyFile: string): Promise<void> {
        const started = Date.now();
        const index = FingerprintIndex.open(backendConfig.indexDir, indexOptions);
        try {
            const report = await importLegacy(legacyFile, index, {
                maxOccurrences: backendConfig.maxHashOccurrences,
                voteCandidates: backendConfig.voteCandidates,
                log: message => console.log(message),
            });
            console.log(`\nImported ${report.songs} songs, ${report.postings} hashes into ${report.segments} segments ` +
                `in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
            console.log(`Verified: identical matching on ${report.clipsCompared} sample clips, identical hashes per song.`);
            for (const [file, sha] of Object.entries(report.sha256)) console.log(`Unchanged: ${file} (sha256 ${sha})`);
            Cli.printStats(index);
        } finally {
            index.close();
        }
    }

    private static printStats(index: FingerprintIndex): void {
        const { songs, pendingPostings, segments } = index.stats();
        const bytes = segments.reduce((sum, s) => sum + s.bytes, 0);
        const postings = segments.reduce((sum, s) => sum + s.postings, 0);
        console.log(`Songs: ${songs}`);
        console.log(`Segments: ${segments.length} (${postings} hashes, ${(bytes / 1e6).toFixed(1)} MB)`);
        for (const s of segments) console.log(`  ${s.file}  ${s.postings} hashes  ${(s.bytes / 1e6).toFixed(1)} MB`);
        if (pendingPostings > 0) console.log(`Waiting in write-ahead log: ${pendingPostings} hashes`);
    }
}
