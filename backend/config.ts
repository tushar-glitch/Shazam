// Backend settings. Paths are relative to the folder you run the command from.
export const backendConfig = {
    dbPath: './fingerprints.db',
    songsDir: './songs',
    queriesFile: './queries.txt',
    port: Number(process.env.PORT ?? 3000),

    // Licensed full songs: GET <licensedTracksUrl>/<artist>/<page> → { ready, hasMore, songs: [{ artist, title, url, id, image_url }] }
    licensedTracksUrl: process.env.LICENSED_TRACKS_URL ?? 'http://localhost:3001/api/songs', // ← set your provider's endpoint here
    fullSongsDir: './songs-full',                    // temporary: audio is deleted once fingerprinted
    licensedProgressFile: './licensed-progress.json', // artist → next page to fetch
    licensedMetadataFile: './songs-metadata.json',    // "Artist - Title" → { id, image_url }

    minScore: 12,              // aligned hash hits needed to call it a match
    minRatio: 3,               // ...and it must beat the best other song by this factor
    chanceFloor: 3,            // runner-up below this counts as this (tiny piles are pure chance)
    maxHashOccurrences: 1000,  // skip hashes found more often than this ("stop words"); higher = slower, more votes
    voteCandidates: 200,       // top (song, offset) piles fetched before merging neighbours
    itunesDelayMs: 3000,       // iTunes API allows ~20 requests/minute
    maxBodyBytes: 1 << 20,     // largest POST /match body accepted
    maxPairs: 20000,           // ~60 s of audio, far more than a listen session sends
} as const;
