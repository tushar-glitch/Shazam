// A strong point in the spectrogram: at this frame, this frequency bin was loud
export type Peak = { frame: number; bin: number };

// One hash (a pair of peaks + their time gap) and when its anchor peak happened
export type Fingerprint = { hash: number; t: number };

// What the server answers for a clip. confidence 1 = statistically significant match
export type Match = { song: string; score: number; offsetSeconds: number; confidence: number };
