// Settings shared by the backend (indexing) and the browser (live listening).
// Changing any value changes the hashes: delete fingerprints.db* and re-index afterwards.
// Values were tuned with a benchmark of phone-in-a-room recordings (noise, echo, other music).
export const engineConfig = {
    sampleRate: 11025,
    frameSize: 1024,     // ~93 ms window, ~10.8 Hz per bin
    hopSize: 256,        // ~23 ms between frames

    // Peaks: a point is a peak if it is the loudest in its neighbourhood (±peakBins × ±peakFrames)
    // and stands out from that neighbourhood's average by at least minProminenceDb.
    // Ranking by prominence (not loudness) cancels a mic's or speaker's EQ.
    minBin: 10,          // ~108 Hz: phone speakers/mics barely reproduce deeper bass
    maxBin: 465,         // ~5 kHz: above this, phone mics and compressed audio lose detail
    peakBins: 12,
    peakFrames: 8,
    minProminenceDb: 6,
    maxBelowFrameDb: 50, // ignore anything this far below the frame's loudest bin (silence, noise floor)
    peaksPerSecond: 30,  // keep only the most prominent peaks: even density, fewer junk hashes

    // Pairs ("target zone"): each anchor pairs with the fanOut nearest later peaks that are
    // minDt..maxDt frames ahead and within ±maxDf bins. Wide gaps = distinctive hashes.
    fanOut: 6,
    minDt: 3,
    maxDt: 63,           // must fit in 6 bits
    maxDf: 120,
} as const;
