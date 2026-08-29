# Archive store format

Long-term storage for what an assistant leaves behind: plan documents, the files tools
produced, and optionally the session transcripts and logs.

The design constraint is that the archive should **outlive the tool that wrote it**. Segments
are ordinary `.tar.gz` files whose members are named by their own hash, so `tar` recovers the
contents with no index and no `cairn`. The database is a convenience, not the archive.

## Location

```text
$XDG_DATA_HOME/cairn/archive/       # default: ~/.local/share/cairn/archive/
  archive.db
  segments/
    seg-000000.tar.gz
    seg-000001.tar.gz
```

`--archive <dir>` points it somewhere else — external or network storage — which is the
expected shape once transcripts are included. Under `$XDG_DATA_HOME` for the same reason as the
usage store, only more strongly: this one may hold the only copy of files whose originals have
since been deleted.

## Segments

A segment is a deterministic `.tar.gz` built by the same writer `agent package` uses. Once
sealed it is **never rewritten**: a later run adds a new segment. That is what makes the archive
safe to copy to slower storage, and what keeps an interrupted run from corrupting what came
before.

### Members are named by content hash

```text
blobs/<first two hex digits>/<full sha256>
```

Two properties fall out of that, and both are load-bearing:

**Deduplication.** Two identical files are one member. A file whose bytes have not changed
between runs is never stored again.

**Path length.** Every member name is exactly 73 characters, comfortably inside the ustar
`name` field. The real paths are not: the source corpus nests seven deep under project slugs
that are themselves absolute paths with the separators replaced, and the tar writer throws
`TarPathTooLongError` rather than escalating to a PAX header. Storing by original path would
fail on real data **and** lose deduplication at the same time.

### Sealing

The default threshold is 64 MiB of **uncompressed** bytes, because that is what bounds memory:
the tar is built whole before it is compressed. A blob larger than the threshold gets a segment
to itself rather than being split, since a member spanning two archives could not be read by
`tar`.

A segment is written to a temporary name and renamed, so an interrupted run never leaves a
half-written file the index would claim is complete.

**Member offsets are read back from the archive that was just built**, rather than predicted
from the entry sizes. Predicting them would duplicate the writer's padding and header rules in
a second place where they could drift; reading them back cannot be wrong about a file this same
process just produced.

## The index

`archive.db`, a SQLite database. Version in `PRAGMA user_version`, migrations in
`src/archive/db.ts`, applied by [`archive migrate`](../commands/archive/migrate.md). The same
rules as the [usage store](usage-store.md#versioning) apply: a shipped migration is never
edited, a migration must run on real data, and a store from the future is refused.

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE segment(
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  bytes     INTEGER NOT NULL,      -- size of the .tar.gz on disk
  blobs     INTEGER NOT NULL,
  sha256    TEXT    NOT NULL,      -- hash of the .tar.gz; what `archive verify` checks
  sealed_at TEXT    NOT NULL
);

CREATE TABLE blob(
  sha256     TEXT    PRIMARY KEY,
  size       INTEGER NOT NULL,
  segment_id INTEGER NOT NULL REFERENCES segment(id),
  offset     INTEGER NOT NULL,     -- byte offset of the member's data, uncompressed
  stored_at  TEXT    NOT NULL
);

CREATE TABLE artifact(
  id         INTEGER PRIMARY KEY,
  provider   TEXT    NOT NULL,
  set_id     TEXT    NOT NULL,
  class      TEXT    NOT NULL,     -- plan | artifact | transcript | log
  path       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL REFERENCES blob(sha256),
  size       INTEGER NOT NULL,
  mtime_ms   REAL    NOT NULL,
  mode       INTEGER NOT NULL,
  first_seen TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  UNIQUE(provider, path, sha256)
);

CREATE INDEX artifact_path  ON artifact(provider, path);
CREATE INDEX artifact_class ON artifact(class, last_seen);
CREATE INDEX blob_segment   ON blob(segment_id);
```

### Content addressing makes it incremental twice over

- a file whose bytes have not changed is already a `blob` and is not stored again
- a file whose bytes **have** changed gets a second `artifact` row against a new blob

So the archive keeps every version it ever saw, without anyone asking it to, and
`UNIQUE(provider, path, sha256)` is what expresses that: one row per (path, content) pair, with
`first_seen` and `last_seen` bracketing when that content was observed at that path.

### The artifact key

Candidates are matched to stored rows through **one** helper, `artifactKey`, and both sides
call it. The two sides were once written separately with different separators, and the result
was an archive that re-hashed its entire corpus on every run while still producing correct
output — a bug with no wrong answer to give it away.

The separator is a NUL, for the same reason `sessionKey` uses one: it cannot occur in either
half, and a space can and does occur in a path.

### Pending blobs are not stored blobs

A run keeps `storedBlobs` and `pendingBlobs` apart. A second file with the same content as one
still buffered in the current segment cannot have its artifact row written yet — the `blob` row
it references does not exist until the segment is sealed. Conflating them is a foreign key
violation, not a subtle miscount.

## Artifact classes

| Class        | Default | What it is                                         |
| ------------ | ------- | -------------------------------------------------- |
| `plan`       | yes     | plan documents a session produced                  |
| `artifact`   | yes     | files tools produced, memory, other session output |
| `transcript` | no      | session and subagent transcripts                   |
| `log`        | no      | prompt history, CLI logs, databases                |

`plan` and `artifact` are archived by default: they are the durable output of a session, they
are small, and nothing else keeps them. `transcript` and `log` are opt-in because they are
three orders of magnitude larger — the same corpus is roughly 150 MB of the first two and over
9 GB with the rest.

`--include` accepts singular or plural spellings, because plural is what the classes are called
on the command line and singular is what a row reports.

What each provider contributes is declared per provider; see the archiving page for
[Claude Code](../providers/claude-code/archiving.md),
[Codex](../providers/codex/archiving.md),
[Antigravity](../providers/antigravity/archiving.md), and
[Gemini CLI](../providers/gemini-cli/archiving.md), and
[OpenCode](../providers/opencode/archiving.md).

## SQLite snapshotting

An artifact set may declare `snapshot: "sqlite"`. Every Codex `.sqlite` and all 501 Antigravity
`.db` files on the reference corpus carry live `-wal` sidecars, so copying the main file alone
can capture a torn page image — byte-complete, but not a valid database.

`snapshot: "sqlite"` routes the read through SQLite's online backup API, producing a consistent
snapshot with the WAL contents folded in. The sidecars are never archived themselves.

## Reading a segment back

`src/archive/tar-read.ts` is the first reader of a format this repository has only ever
written. It handles **only** what the writer emits — regular files, directories, and the ustar
`prefix` split for long paths. A PAX or GNU long-name header is refused rather than guessed at,
because this reader's whole job is to say exactly what a segment contains.

[`archive extract`](../commands/archive/extract.md) resolves a blob by hash or by original path,
reads the segment, slices at the recorded offset, and **re-checks the hash** — an archive whose
index and bytes disagree should say so rather than hand back the wrong file. The file is
written into the output directory under its original basename.

Nothing about recovery depends on this tool:

```bash
tar tzf ~/.local/share/cairn/archive/segments/seg-000000.tar.gz
tar xzf ~/.local/share/cairn/archive/segments/seg-000000.tar.gz blobs/9f/9f2b…
```

## `archive verify` exits 2 without `--strict`

Every other `usage` and `archive` command treats an unreadable file as routine and reports it,
because over thousands of artifacts a file removed mid-walk is normal.

Corruption is not routine. It is the finding
[`archive verify`](../commands/archive/verify.md) exists to report, so making it opt-in would
defeat the point.

`--deep` re-reads every segment and re-hashes every member, rather than checking only the
segment-level hashes.

## `archive run` declares `writes: true`

Both `archive run` and `usage index` write only to their own store, but the archive's location
is a durable directory the user chose and may point at external storage, so calling it
non-writing would be misleading. `archive extract` is also a writer, and the only one that
writes outside the archive.

## Related

- [Shared archive command behavior](../commands/archive/common.md)
- [`archive run`](../commands/archive/run.md), [`archive verify`](../commands/archive/verify.md),
  [`archive extract`](../commands/archive/extract.md)
- [Deterministic tar](deterministic-tar.md) — the segment container
- [Usage store format](usage-store.md) — what archiving transcripts makes load-bearing
