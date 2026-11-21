import assert from 'node:assert';
import { engineConfig, Fingerprinter, SpectrumAnalyzer } from '../engine/index.js';
import { FingerprintDatabase } from './fingerprint-database.js';
import { LyricsTracker } from '../frontend/lyrics-tracker.js';
import { LicensedFetcher } from './licensed-fetcher.js';
import { LyricsService } from './lyrics-service.js';
import { SongIndexer } from './song-indexer.js';
import { SongMatcher } from './song-matcher.js';
import { WebServer } from './web-server.js';

const { sampleRate, frameSize } = engineConfig;

// Runs before every command: FFT accuracy, end-to-end recognition on synthetic
// songs, and the API's input checks. Any failure stops the program.
export class SelfCheck {
    private static seed = 1;

    static run(): void {
        SelfCheck.checkFft();
        SelfCheck.checkRecognition();
        SelfCheck.checkApiValidation();
        SelfCheck.checkStaticRoutes();
        SelfCheck.checkRepeatedParts();
        SelfCheck.checkLyrics();
        SelfCheck.checkLyricsTracker();
    }

    // A chorus produced as an exact copy fits a clip at two places: both are reported
    private static checkRepeatedParts(): void {
        SelfCheck.seed = 7;
        const db = new FingerprintDatabase(':memory:');
        const song = SelfCheck.synthSong(30);
        song.copyWithin(18 * sampleRate, 4 * sampleRate, 10 * sampleRate); // 0:04-0:10 again at 0:18-0:24
        new SongIndexer(db).addAudio('Chorus', song);
        db.mergePending();

        const clip = song.slice(5 * sampleRate, 9 * sampleRate);
        const match = new SongMatcher(db).match(new Fingerprinter().fingerprintAudio(clip));
        assert.strictEqual(match?.song, 'Chorus');
        const places = [match.offsetSeconds, ...(match.alternatives ?? [])].map(Math.round).sort((a, b) => a - b);
        assert.deepStrictEqual(places, [5, 19]);

        // An unrepeated part has a single place
        const verse = song.slice(12 * sampleRate, 16 * sampleRate);
        assert.strictEqual(new SongMatcher(db).match(new Fingerprinter().fingerprintAudio(verse))?.alternatives, undefined);
        db.close();
    }

    // LRC parsing, name clean-up and choosing among search results (no network involved)
    private static checkLyrics(): void {
        assert.deepStrictEqual(LyricsService.parseLrc('[ar:Someone]\n[00:01.50]One\n[00:10.00][01:00.25]Chorus\n[00:05]\n'), [
            { time: 1.5, text: 'One' }, { time: 5, text: '' }, { time: 10, text: 'Chorus' }, { time: 60.25, text: 'Chorus' },
        ]);
        assert.deepStrictEqual(LyricsService.parseLrc('[offset:+500]\n[00:02.00]Early'), [{ time: 1.5, text: 'Early' }]);
        assert.deepStrictEqual(LyricsService.titleVariants('Kesariya (From "Brahmastra")'), ['Kesariya (From "Brahmastra")', 'Kesariya']);
        assert.deepStrictEqual(LyricsService.titleVariants('Song feat. Somebody'), ['Song feat. Somebody', 'Song']);
        assert.deepStrictEqual(LyricsService.artistVariants('A.R. Rahman & Arijit Singh'), ['A.R. Rahman & Arijit Singh', 'A.R. Rahman']);
        assert.deepStrictEqual(LyricsService.splitName('Arijit Singh - Tum Hi Ho'), { artist: 'Arijit Singh', title: 'Tum Hi Ho' });

        const plain = { trackName: 'Tum Hi Ho', artistName: 'Arijit Singh', plainLyrics: 'words' };
        const synced = { ...plain, syncedLyrics: '[00:01.00]words' };
        const other = { trackName: 'Another Song', artistName: 'Arijit Singh', syncedLyrics: '[00:01.00]x' };
        assert.strictEqual(LyricsService.pickBest([plain, other, synced], 'Tum Hi Ho', 'Arijit Singh'), synced);
        assert.strictEqual(LyricsService.pickBest([other], 'Tum Hi Ho', 'Arijit Singh'), undefined);
        assert.deepStrictEqual(LyricsService.toLyrics(synced), { status: 'synced', lines: [{ time: 1, text: 'words' }] });
        assert.deepStrictEqual(LyricsService.toLyrics(plain), { status: 'plain', text: 'words' });
    }

    // Following the song: repeats resolve, one odd measurement is ignored, a real skip is followed
    private static checkLyricsTracker(): void {
        const tracker = new LyricsTracker(45, [110], 0);        // heard a chorus that is at 0:45 and 1:50
        assert.ok(tracker.ambiguous);
        assert.deepStrictEqual(tracker.positions(10_000), [55, 120]);
        tracker.observe(120.4, [], 10_000);                     // 10 s later only 2:00 fits: it was the second chorus
        assert.ok(!tracker.ambiguous);
        assert.strictEqual(Math.round(tracker.position(15_000)), 125);
        tracker.observe(30, [], 15_000);                        // one measurement far off: ignored
        assert.strictEqual(Math.round(tracker.position(20_000)), 130);
        tracker.observe(35, [], 20_000);                        // again: the song really jumped
        assert.strictEqual(Math.round(tracker.position(25_000)), 40);
        tracker.observe(45, [170], 30_000);                     // locked: a repeat elsewhere does not pull it away
        assert.strictEqual(Math.round(tracker.position(30_000)), 45);
        assert.ok(!tracker.ambiguous);
    }

    // A pure 1000 Hz sine must peak at the matching bin
    private static checkFft(): void {
        const toneHz = 1000;
        const sine = new Float32Array(frameSize);
        for (let i = 0; i < frameSize; i++) {
            sine[i] = Math.sin((2 * Math.PI * toneHz * i) / sampleRate);
        }

        const mag = new SpectrumAnalyzer().frameSpectrum(sine, 0);
        const peakBin = mag.indexOf(Math.max(...mag));
        assert.strictEqual(peakBin, Math.round((toneHz * frameSize) / sampleRate));
        assert.strictEqual(mag.length, frameSize / 2 + 1);
        assert.ok(new Fingerprinter().findPeaks([mag]).some(p => p.bin === peakBin));
        assert.strictEqual(Math.round(SpectrumAnalyzer.binToHz(peakBin) / 10), 100);
    }

    private static checkRecognition(): void {
        SelfCheck.seed = 1;
        const db = new FingerprintDatabase(':memory:');
        const indexer = new SongIndexer(db);
        const matcher = new SongMatcher(db);
        const fingerprinter = new Fingerprinter();

        const songA = SelfCheck.synthSong(20);
        indexer.addAudio('A', songA);
        indexer.addAudio('B', SelfCheck.synthSong(20));
        db.mergePending(); // new hashes are staged until merged

        // 4 s clip from 7 s into song A (not hop-aligned), with noise added
        const clip = songA.slice(7 * sampleRate + 100, 11 * sampleRate);
        for (let i = 0; i < clip.length; i++) clip[i]! += (SelfCheck.random() - 0.5) * 0.5;

        const match = matcher.match(fingerprinter.fingerprintAudio(clip));
        assert.strictEqual(match?.song, 'A');
        assert.strictEqual(match.confidence, 1);
        assert.ok(Math.abs(match.offsetSeconds - 7) < 0.1, `offset ${match.offsetSeconds}`);

        // Pure noise must never be a confident match
        const noise = new Float32Array(4 * sampleRate).map(() => SelfCheck.random() - 0.5);
        assert.ok((matcher.match(fingerprinter.fingerprintAudio(noise))?.confidence ?? 0) < 1);

        // Votes split across neighbouring offsets of the same song are added together
        assert.deepStrictEqual(
            SongMatcher.rankSongs([
                { songId: 1, offset: 87, score: 30 },
                { songId: 1, offset: 86, score: 25 },
                { songId: 2, offset: 10, score: 40 },
            ]),
            [{ songId: 1, offset: 87, score: 55 }, { songId: 2, offset: 10, score: 40 }]
        );
        assert.deepStrictEqual(SongMatcher.rankSongs([]), []);

        // Significance: a big pile that clearly beats every other song is confident; a close race is not
        assert.strictEqual(SongMatcher.confidence(60, 5), 1);
        assert.ok(SongMatcher.confidence(30, 20) < 1);
        assert.ok(SongMatcher.confidence(6, 0) < 1);

        // A full song replaces its preview of the same name instead of failing on UNIQUE
        indexer.addAudio('B', songA, true);
        db.mergePending();
        assert.strictEqual(db.songCount(), 2);
        // ...and two identical recordings (A and B now) still give a confident answer
        assert.strictEqual(matcher.match(fingerprinter.fingerprintAudio(clip))?.confidence, 1);
        assert.strictEqual(matcher.match(fingerprinter.fingerprintAudio(clip))?.offsetSeconds.toFixed(0), '7');

        db.close();
    }

    // The API boundary rejects malformed input
    private static checkApiValidation(): void {
        assert.deepStrictEqual(WebServer.parsePrints('[[5, 2]]'), [{ hash: 5, t: 2 }]);
        for (const bad of ['{}', '[[1]]', '[["1", 2]]', '[[1.5, 2]]', '[[-1, 2]]', `[[${2 ** 26}, 0]]`, 'nope']) {
            assert.strictEqual(WebServer.parsePrints(bad), null, bad);
        }

        const good = { artist: 'A', title: 'T', url: 'https://x.test/a.mp3', id: 'x1', image_url: 'https://x.test/a.jpg' };
        assert.deepStrictEqual(
            LicensedFetcher.parsePage({ ready: true, hasMore: true, songs: [good, { ...good, url: 'file:///etc/passwd' }, { title: 'T' }, null] }),
            { ready: true, hasMore: true, songs: [good] }
        );
        assert.throws(() => LicensedFetcher.parsePage([good]));
        assert.strictEqual(LicensedFetcher.songName({ ...good, artist: 'Arijit Singh', title: 'Atak Gaya - Arijit Singh' }), 'Arijit Singh - Atak Gaya');
    }

    // Only whitelisted files are reachable; no path tricks
    private static checkStaticRoutes(): void {
        assert.strictEqual(WebServer.staticFile('/'), 'frontend/index.html');
        assert.strictEqual(WebServer.staticFile('/engine/fft.js'), 'dist/engine/fft.js');
        assert.strictEqual(WebServer.staticFile('/frontend/app.js'), 'dist/frontend/app.js');
        for (const bad of ['/fingerprints.db', '/engine/../index.js', '/engine/x.ts', '/backend/cli.js', '/frontend/%2e%2e.js']) {
            assert.strictEqual(WebServer.staticFile(bad), undefined, bad);
        }
    }

    // Deterministic pseudo-random numbers so the check is repeatable
    private static random(): number {
        // 32-bit integer LCG (Numerical Recipes); plain float maths loses precision and repeats
        SelfCheck.seed = (Math.imul(SelfCheck.seed, 1664525) + 1013904223) >>> 0;
        return SelfCheck.seed / 2 ** 32;
    }

    // Fake "song": a new 3-note chord every 0.25 s, each note decaying like a plucked string
    private static synthSong(seconds: number): Float32Array {
        const out = new Float32Array(seconds * sampleRate);
        const noteLength = Math.round(sampleRate / 4); // whole samples: fractional indices are silently ignored
        for (let start = 0; start < out.length; start += noteLength) {
            const freqs = [SelfCheck.random(), SelfCheck.random(), SelfCheck.random()].map(r => 100 + r * 4000);
            for (let i = start; i < Math.min(start + noteLength, out.length); i++) {
                const decay = Math.exp(-6 * (i - start) / noteLength);
                for (const f of freqs) out[i]! += decay * Math.sin((2 * Math.PI * f * i) / sampleRate) / 3;
            }
        }
        return out;
    }
}
