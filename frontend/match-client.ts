import type { Fingerprint, Lyrics, Match } from '../engine/index.js';

// Talks to the backend. Only fingerprints are sent, never audio.
export class MatchClient {
    async match(prints: Fingerprint[]): Promise<Match | null> {
        const response = await fetch('/match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prints.map(p => [p.hash, p.t]))
        });
        if (!response.ok) throw new Error(`Server error ${response.status}`);
        return response.json();
    }

    async lyrics(song: string): Promise<Lyrics> {
        const response = await fetch(`/api/lyrics?song=${encodeURIComponent(song)}`);
        if (response.status === 404) return { status: 'not-found' };
        if (!response.ok) throw new Error(`Server error ${response.status}`);
        return response.json();
    }

    async recent(): Promise<{ now: number; recent: { song: string; at: number }[] }> {
        const response = await fetch('/api/recent');
        if (!response.ok) throw new Error(`Server error ${response.status}`);
        return response.json();
    }

    async library(): Promise<{ songs: string[]; images?: Record<string, string> }> {
        const response = await fetch('/api/songs');
        if (!response.ok) throw new Error(`Server error ${response.status}`);
        return response.json();
    }

    async librarySize(): Promise<number> {
        const response = await fetch('/api/stats');
        if (!response.ok) throw new Error(`Server error ${response.status}`);
        return (await response.json()).songs;
    }
}
