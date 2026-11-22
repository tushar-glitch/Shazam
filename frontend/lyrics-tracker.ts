export const trackerConfig = {
    toleranceSeconds: 1.5, // a new measurement this close to a prediction confirms it
    jumpAfterMisses: 2,    // measurements in a row that fit no prediction before we jump (a skip or seek)
} as const;

// Where in the song we are, from repeated matches of the microphone audio.
// A repeated chorus can fit several places, so the tracker keeps every place that is still
// possible (hypotheses) and drops the ones later measurements contradict: once the music
// leaves the repeated part, only one survives. Times are performance.now() milliseconds.
export class LyricsTracker {
    private hypotheses: number[]; // song positions (seconds) at time `at`
    private at: number;
    private misses = 0;

    // The song was at `position` (or one of `alternatives`) at time `at`
    constructor(position: number, alternatives: readonly number[], at: number) {
        this.hypotheses = [position, ...alternatives];
        this.at = at;
    }

    // True while more than one place in the song is still possible
    get ambiguous(): boolean {
        return this.hypotheses.length > 1;
    }

    // Song position now; the first entry is the most likely one
    positions(now: number): number[] {
        const elapsed = (now - this.at) / 1000;
        return this.hypotheses.map(h => h + elapsed);
    }

    position(now: number): number {
        return this.positions(now)[0]!;
    }

    // A new match: the song was at `position` (or one of `alternatives`) at time `at`.
    // Measurements that fit a prediction refine it; ones that fit none twice in a row mean the
    // song really moved (skipped, paused, restarted), so we start over from them.
    observe(position: number, alternatives: readonly number[], at: number): void {
        const measured = [position, ...alternatives];
        const predicted = this.positions(at);
        const kept = measured.filter(m => predicted.some(p => Math.abs(p - m) <= trackerConfig.toleranceSeconds));

        if (kept.length > 0) {
            this.hypotheses = kept; // fresh measurements, best match first
            this.misses = 0;
        } else if (++this.misses >= trackerConfig.jumpAfterMisses) {
            this.hypotheses = measured;
            this.misses = 0;
        } else {
            return; // one odd measurement: keep following the current timeline
        }
        this.at = at;
    }
}
