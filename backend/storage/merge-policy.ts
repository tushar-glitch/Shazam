export type SegmentSize = { id: number; postings: number };
export type MergePolicyOptions = { flushPostings: number; mergeFactor: number };

// Size-tiered merge policy (as in Cassandra STCS / a simplified Lucene TieredMergePolicy).
// A segment's tier is how many times bigger than a flush it is, in powers of mergeFactor:
// tier 0 ≤ 1 flush, tier 1 ≤ mergeFactor flushes, tier 2 ≤ mergeFactor² flushes, ...
// When a tier holds mergeFactor segments, they are merged into one segment of the next tier.
// Every posting is therefore rewritten about log_mergeFactor(total / flush) times, and a
// search reads at most about (mergeFactor - 1) segments per tier.
// Returns the segments to merge (smallest tier first), or null if nothing needs merging.
export function selectMerge(segments: readonly SegmentSize[], { flushPostings, mergeFactor }: MergePolicyOptions): SegmentSize[] | null {
    if (mergeFactor < 2) throw new RangeError('mergeFactor must be at least 2');
    const tiers = new Map<number, SegmentSize[]>();
    for (const segment of segments) {
        const tier = tierOf(segment.postings, flushPostings, mergeFactor);
        tiers.set(tier, [...(tiers.get(tier) ?? []), segment]);
    }
    for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
        const members = tiers.get(tier)!;
        if (members.length >= mergeFactor) {
            return [...members].sort((a, b) => a.postings - b.postings || a.id - b.id).slice(0, mergeFactor);
        }
    }
    return null;
}

export function tierOf(postings: number, flushPostings: number, mergeFactor: number): number {
    let tier = 0;
    for (let limit = flushPostings; postings > limit; limit *= mergeFactor) tier++;
    return tier;
}
