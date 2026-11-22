// A strong point in the spectrogram: at this frame, this frequency bin was loud
export type Peak = { frame: number; bin: number };

// One hash (a pair of peaks + their time gap) and when its anchor peak happened
export type Fingerprint = { hash: number; t: number };

// What the server answers for a clip. confidence 1 = statistically significant match.
// alternatives: other places in the same song that fit the clip almost as well (a repeated
// chorus), in seconds; absent when the position is unambiguous.
export type Match = { song: string; score: number; offsetSeconds: number; confidence: number; alternatives?: number[] };

// GET /api/lyrics answer. Synced lines are sorted by time (seconds); an empty text is an instrumental gap.
export type LyricLine = { time: number; text: string };
export type Lyrics =
    | { status: 'synced'; lines: LyricLine[] }
    | { status: 'plain'; text: string }
    | { status: 'instrumental' }
    | { status: 'not-found' };
