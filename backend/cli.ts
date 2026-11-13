import path from 'node:path';
import { Fingerprinter } from '../engine/index.js';
import { AudioDecoder } from './audio-decoder.js';
import { backendConfig } from './config.js';
import { FingerprintDatabase } from './fingerprint-database.js';
import { LicensedFetcher } from './licensed-fetcher.js';
import { SelfCheck } from './self-check.js';
import { SongFetcher } from './song-fetcher.js';
import { SongIndexer } from './song-indexer.js';
import { SongMatcher } from './song-matcher.js';
import { WebServer } from './web-server.js';

const usage = `Usage:
  npm start -- serve                 web app + matching API on http://localhost:${backendConfig.port}
  npm start -- fetch                 download popular songs into ./songs and index each one
  npm start -- fetch-licensed        [artistsAtOnce=6]  index every artist in queries.txt from the licensed API (resumes)
  npm start -- index [folder]       index every audio file in a folder (default ./songs)
  npm start -- add <audioFile> [name]
  npm start -- match <audioFile>`;

// Reads the command you typed and wires the right objects together
export class Cli {
    async run([command, file, name]: string[]): Promise<void> {
        SelfCheck.run();

        const db = new FingerprintDatabase(backendConfig.dbPath);
        const indexer = new SongIndexer(db);
        const matcher = new SongMatcher(db);

        if (command === 'serve') {
            this.merge(db); // songs indexed by an interrupted fetch become matchable here
            console.log(`Songs in DB: ${db.songCount()}`);
            new WebServer(db, matcher).start();
            return; // keep the DB open while the server runs
        }

        if (command === 'fetch') {
            await new SongFetcher(indexer).run();
            console.log(`\nDone. Songs in DB: ${db.songCount()}`);
        } else if (command === 'fetch-licensed') {
            await new LicensedFetcher(indexer).run(Number(file) || undefined);
            console.log(`\nDone. Songs in DB: ${db.songCount()}`);
        } else if (command === 'index') {
            indexer.indexFolder(file ?? backendConfig.songsDir);
            console.log(`\nDone. Songs in DB: ${db.songCount()}`);
        } else if (command === 'add' && file) {
            const count = indexer.addAudio(name ?? path.parse(file).name, AudioDecoder.decode(file));
            console.log(`Added (${count} hashes). Songs in DB: ${db.songCount()}`);
        } else if (command === 'match' && file) {
            this.merge(db);
            const match = matcher.match(new Fingerprinter().fingerprintAudio(AudioDecoder.decode(file)));
            console.log(match
                ? `Match: "${match.song}" at ${match.offsetSeconds.toFixed(1)} s (score ${match.score})`
                : 'No match');
        } else {
            console.log(`Self-check passed.\n${usage}`);
        }

        this.merge(db);
        db.close();
    }

    // Staged hashes → searchable index, in one sorted batch (see FingerprintDatabase.mergePending)
    private merge(db: FingerprintDatabase): void {
        const started = Date.now();
        const moved = db.mergePending();
        if (moved) console.log(`Merged ${moved} staged hashes into the index in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
}
