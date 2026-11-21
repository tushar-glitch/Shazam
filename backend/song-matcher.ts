import { SpectrumAnalyzer, type Fingerprint, type Match } from '../engine/index.js';
import { backendConfig } from './config.js';
import type { FingerprintDatabase, OffsetVote } from './fingerprint-database.js';

// A true match has many hashes agreeing on the same time offset (dbTime - clipTime).
// Vote per (song, offset); the tallest pile wins. Like Wang 2003, only a *significant*
// pile counts: it must reach minScore and clearly beat the best other song, whose pile
// is what chance alone produces for this clip.
export class SongMatcher {
    constructor(
        private readonly db: FingerprintDatabase,
        private readonly maxHashOccurrences: number = backendConfig.maxHashOccurrences
    ) {}

    match(prints: Fingerprint[]): Match | null {
        if (prints.length === 0) return null;
        const votes = this.db.topVotes(prints, this.maxHashOccurrences, backendConfig.voteCandidates);
        const [best, ...others] = SongMatcher.rankSongs(votes);
        if (!best) return null;

        // Another song matching nearly as strongly is the same recording stored twice (a re-release,
        // a 'From <film>' copy), not chance; the background is the best song that is NOT like that.
        const { minScore } = backendConfig;
        const chance = others.find(v => v.score < best.score / 2 || v.score < 2 * minScore);

        const alternatives = SongMatcher.alternatives(votes, best).map(SpectrumAnalyzer.frameToSeconds);
        return {
            song: this.db.songName(best.songId),
            score: best.score,
            offsetSeconds: SpectrumAnalyzer.frameToSeconds(best.offset),
            confidence: SongMatcher.confidence(best.score, chance?.score ?? 0),
            ...(alternatives.length > 0 && { alternatives }),
        };
    }

    // A repeated part of a song (a chorus produced as a copy) fits the clip at several offsets.
    // Returns those other offsets of the best song, in frames: piles at least
    // alternativeRatio as strong as the best one and more than 2 s away from it (and each other).
    static alternatives(votes: OffsetVote[], best: OffsetVote): number[] {
        const { alternativeRatio, maxAlternatives } = backendConfig;
        const minGap = Math.round(2 / SpectrumAnalyzer.frameToSeconds(1));
        const own = votes.filter(v => v.songId === best.songId);
        const scores = new Map(own.map(v => [v.offset, v.score]));

        const found: number[] = [];
        const piles = own
            .map(v => ({ offset: v.offset, score: v.score + (scores.get(v.offset + 1) ?? 0) }))
            .sort((a, b) => b.score - a.score || a.offset - b.offset);
        for (const pile of piles) {
            if (found.length >= maxAlternatives || pile.score < best.score * alternativeRatio) break;
            if ([best.offset, ...found].every(o => Math.abs(o - pile.offset) > minGap)) found.push(pile.offset);
        }
        return found;
    }

    // 0..1; 1 = significant enough to show as the answer
    static confidence(score: number, runnerUp: number): number {
        const { minScore, minRatio, chanceFloor } = backendConfig;
        const ratio = score / Math.max(runnerUp, chanceFloor);
        return Math.min(1, score / minScore, ratio / minRatio);
    }

    // A recording never lines up exactly with the stored frames, so a real match splits
    // its votes between two neighbouring offsets (e.g. 86 and 87). Score each pair of
    // neighbours together. Returns each song's best pile, strongest song first.
    static rankSongs(votes: OffsetVote[]): OffsetVote[] {
        const scores = new Map(votes.map(v => [`${v.songId}:${v.offset}`, v.score]));
        const bestPerSong = new Map<number, OffsetVote>();

        for (const vote of votes) {
            const next = scores.get(`${vote.songId}:${vote.offset + 1}`) ?? 0;
            const combined = vote.score + next;
            if (combined > (bestPerSong.get(vote.songId)?.score ?? 0)) {
                bestPerSong.set(vote.songId, { songId: vote.songId, offset: next > vote.score ? vote.offset + 1 : vote.offset, score: combined });
            }
        }
        return [...bestPerSong.values()].sort((a, b) => b.score - a.score);
    }
}
