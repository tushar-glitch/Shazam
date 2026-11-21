# Fingerprint index: storage format and guarantees

The index maps every fingerprint hash to the songs and times it occurs at (an inverted index).
It is stored the way search engines such as Lucene store theirs: a set of immutable, sorted,
compressed **segment files** plus a small **catalog** that says which segments are live.
New songs never modify an existing file. They are written as new segments, and a background
**compaction** merges small segments into larger ones.

Code: [`backend/storage/`](../backend/storage/). Settings: `indexDir`, `flushPostings`,
`flushIntervalMs` and `mergeFactor` in [`backend/config.ts`](../backend/config.ts).

## Directory layout

```
fingerprint-index/
  catalog.db                     SQLite: songs, tombstones, live segments, write-ahead log
  seg-<uuid>.seg                 immutable segment files
  seg-<uuid>.seg.<pid>.tmp       a segment being written by process <pid>
```

### Catalog tables

| table | purpose |
|---|---|
| `songs(id, name)` | song ids are `AUTOINCREMENT`, so an id is never reused |
| `deleted_songs(id)` | tombstones of replaced songs whose postings may still sit in segments |
| `segments(id, file, keys, postings, bytes, created_at)` | the live segments; a file not listed here does not exist logically |
| `pending(song_id, hash, t)` | write-ahead log: fingerprints of songs not yet in a segment |

`PRAGMA user_version` holds the schema version. Migrations in `catalog.ts` run in order when the
index is opened, and a newer index is refused by older code.

## Segment file

All integers are little-endian.

```
header   16 B   magic "SHZSEG\0\x01" | format version u32 | flags u32 (0)
postings        for each hash in ascending order: its postings sorted by (song, t)
key table       for each hash in ascending order: hash u32 | posting count u32 | postings offset u64
footer   48 B   key table offset u64 | key count u32 | reserved u32 | posting count u64
                | key table crc32 u32 | postings crc32 u32 | format version u32 | reserved u32 | magic
```

Each posting is two LEB128 varints:

- **first:** the song id minus the previous posting's song id;
- **second:** the time minus the previous time if the song is the same, otherwise the full time.

A typical posting takes 2–3 bytes. The hash is stored once per key, not once per posting.
Exact duplicate `(hash, song, t)` triples are removed when a segment is written, as the previous
store's primary key did.

Because postings come before the key table, a writer streams them to disk and only keeps the key
table in memory. Readers load the key table (16 B per distinct hash) and fetch postings with
positioned reads, so the operating system's page cache does the caching.

How each check runs:

- **Footer magic, format version and file size** are checked when the file is opened.
- **Key-table CRC** is also checked on open.
- **Postings CRC** is checked by `SegmentReader.verify()`, which is a full read.

## Write path

1. **`addSong`:** inserts the song row and appends its fingerprints to `pending`, in one transaction.
   A song is durable once this returns.
2. **`flush`:** runs when `pending` reaches `flushPostings`, when `flushIntervalMs` has passed since
   the last flush, and on close. Under `BEGIN IMMEDIATE`, it:
   1. reads `pending` in `(hash, song, t)` order;
   2. writes `seg-<uuid>.seg.<pid>.tmp`;
   3. `fsync`s it;
   4. renames it to `seg-<uuid>.seg`;
   5. inserts the `segments` row and clears `pending`;
   6. commits.

   A segment is therefore visible only after it is complete on disk.
3. **Compaction:** a size-tiered policy (`merge-policy.ts`) puts each segment in a tier by its size
   (`flushPostings × mergeFactor^tier`). It merges `mergeFactor` segments of one tier into one segment
   of the next tier, which keeps both the write amplification and the number of segments a search
   reads at O(log n). Merges run on a worker thread and read without any lock. The swap is
   optimistic: it commits only if all input segments are still live, and otherwise the output is
   discarded. A merge drops the postings of tombstoned songs. When a merge covers every segment, its
   tombstones are cleared.

## Read path

`topVotes(clip, maxOccurrences, limit)` works through the clip's hashes:

1. **Look up the hash:** a binary search in every live segment, adding up its posting counts.
2. **Skip stop words:** hashes found more than `maxOccurrences` times are skipped. Postings of
   tombstoned songs are excluded from that count.
3. **Vote:** every remaining posting votes for `(song, its time − the clip's time)`.
4. **Return** the strongest piles, ordered by score descending, then song id, then offset.

The result is identical to the previous SQLite query. `test/fingerprint-index.test.ts` checks this
against that query on a random library that includes merges and tombstones.

Before each search the index checks `PRAGMA data_version`. When another process has committed
(a flush or a merge), it reloads the segment list. A `serve` running alongside a fetch therefore
sees new songs within `flushIntervalMs`.

## Concurrency and recovery

- **Writers:** any number of processes may open the same index. Writes that must be atomic across
  files and catalog take SQLite's write lock (`BEGIN IMMEDIATE`, 60 s busy timeout).
- **Renames under the lock:** a segment is renamed into place and registered in the same locked
  section. The recovery sweep also runs under that lock, so it can safely delete every `.seg` file
  the catalog does not list.
- **Recovery on open:** a writer opening the index deletes orphan segments and the `.tmp` files of
  processes that no longer run. It then flushes whatever a crashed writer left in `pending`. Nothing
  that `addSong` returned from is ever lost.
- **Deleting merged segments:** these files may still be open in another process. That works on
  POSIX and on Windows (libuv opens files with `FILE_SHARE_DELETE`). If a delete fails anyway, the
  next recovery sweep removes the file.

## Limits

- **Song ids** must be below 2^30.
- **Times** must be below 2^22 frames, about 27 hours. Vote keys pack `(song, offset)` into one double.
- **Memory:** about 16 B per distinct hash per open segment. The hash space is about 6.7M distinct
  values, so a fully merged index needs at most about 110 MB.

## Importing a pre-segment `fingerprints.db`

`npm start -- import-legacy` reads the old single-file store and builds a new, empty index from it.
It opens the old file with `SQLITE_OPEN_READONLY`, records the SHA-256 of the file and its `-wal`, and
then:

1. **Merged songs:** copies the songs, keeping their ids, and the `hashes` table into one segment.
   The table is read in primary-key order, so this is a sequential scan.
2. **Equivalence check:** compares old and new voting on 200 sample clips. The results must be
   identical.
3. **Staged songs:** copies `pending_hashes` into a second segment.
4. **Count check:** compares postings per song over both tables.
5. **Unchanged file:** checks that the SHA-256 values are unchanged.

Any difference aborts the import. The old file is never modified or deleted.
