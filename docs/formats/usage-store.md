# Usage store format

A SQLite database holding every transcript the [`usage`](../commands/usage/common.md) commands
have imported, for every provider. One store, not one per provider.

## Location

```text
$XDG_DATA_HOME/cairn/usage.db      # default: ~/.local/share/cairn/usage.db
```

**`$XDG_DATA_HOME`, not `$XDG_CACHE_HOME`, and the distinction is load-bearing.** The JSON
shard store this replaced was a cache: losing it cost a re-parse and nothing else. This is
data. Once `archive run --include transcripts` has run and the source logs are pruned, this
store is the only record of that usage left on the machine — and a cache directory is somewhere
tools are entitled to delete without asking.

`--no-index` bypasses the store entirely: neither reads it nor writes it.

## Versioning

The schema version lives in `PRAGMA user_version`, where SQLite keeps it in the file header so
it costs no table and cannot itself need migrating. `src/usage/db/migrations.ts` is the list;
`LATEST_VERSION` is what this build writes.

This is a **hand-owned** version, the fifth in the project, and the first that is _migrated
rather than discarded_. Three rules follow, and none of them applies to the disposable caches:

- **A shipped migration is never edited.** A store in the field has already run it; changing it
  means two databases claim the same version with different shapes. Add a new migration.
- **A migration must run on real data**, not only on an empty file.
- **A store from the future is refused, not opened.** A newer build may have written columns
  this one knows nothing about, and opening it read-write risks dropping them on the next
  write.

[`usage migrate`](../commands/usage/migrate.md) applies pending migrations;
[`usage index`](../commands/usage/index.md) reports the current version.

It is not part of the payload contract — it versions a file on disk, not a payload shape — but
it is listed in [the contract's hand-owned version table](../contract.md#the-other-hand-owned-versions)
so a consumer reading a `schemaVersion` knows which kind it is looking at.

## Two grains

The store keeps a per-occurrence `event` table **alongside** the day rollup, never instead of
it.

| Grain         | Rows (full corpus) | Read by                             |
| ------------- | ------------------ | ----------------------------------- |
| `day*` rollup | ~82,000            | every report this tool offers       |
| `event`       | ~2,500,000         | nothing here — it is for direct SQL |

Keeping the rollup means a report never scans the event table, and means the reports produce
byte-identical output to the JSON shard cache they replaced, because they are fed the same
`DayBucket` shape from the same numbers.

**Providers emit events alongside the buckets they already built, never derived from them**, in
one pass. `tests/unit/usage-events.test.ts` folds the event stream back with `foldDays` and
asserts it reproduces `aggregate.days` — so adding a counter to a provider without emitting its
event fails there rather than shipping a quietly short event table.

## Schema

### `meta`

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

### `file` — one row per imported transcript

```sql
CREATE TABLE file(
  id                INTEGER PRIMARY KEY,
  provider          TEXT    NOT NULL,
  relative          TEXT    NOT NULL,
  path              TEXT    NOT NULL,
  size              INTEGER NOT NULL,
  mtime_ms          REAL    NOT NULL,
  session_id        TEXT    NOT NULL,
  kind              TEXT    NOT NULL,      -- 'main' | 'subagent'
  parent_session_id TEXT,
  agent_id          TEXT,
  agent_type        TEXT,
  agent_path        TEXT,
  spawn_depth       INTEGER,
  project           TEXT    NOT NULL,
  title             TEXT,
  git_branch        TEXT,
  tool_version      TEXT,
  first_ts          TEXT    NOT NULL,
  last_ts           TEXT    NOT NULL,
  malformed_lines   INTEGER NOT NULL DEFAULT 0,
  imported_at       TEXT    NOT NULL,
  UNIQUE(provider, relative)
);
```

The freshness key is `(size, mtime_ms)`. A transcript is append-only, so a file that has not
changed cannot hold a record the stored aggregate is missing — only files that grew are
reopened.

`malformed_lines` is what a truncated final line lands in: reported, never fatal.

**A session id is unique only within its provider.** `sessionKey()` qualifies it as
`provider \0 sessionId` — a NUL separator, because it cannot occur in either half. Counting or
grouping on the bare id merges two providers' sessions when they mint the same UUID, which they
do.

### `event` — the per-occurrence grain

```sql
CREATE TABLE event(
  id             INTEGER PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  ts             TEXT    NOT NULL,
  day            TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  model          TEXT,  tool  TEXT,  name TEXT,  status TEXT,
  duration_ms    INTEGER,
  depth          INTEGER,
  input          INTEGER,  output         INTEGER,
  cache_read     INTEGER,  cache_write    INTEGER,
  cache_write_5m INTEGER,  cache_write_1h INTEGER,
  thinking       INTEGER,  web_search     INTEGER,  web_fetch INTEGER,
  requests       INTEGER
);
```

`kind` is one of:

| Kind         | Carries                                                     |
| ------------ | ----------------------------------------------------------- |
| `response`   | `model` and the whole token column set                      |
| `tool_use`   | `tool` — the raw name, before classification                |
| `agent`      | `name`, and `depth` where the provider records one          |
| `skill`      | `name`                                                      |
| `command`    | `name`                                                      |
| `prompt`     | —                                                           |
| `error`      | —                                                           |
| `compaction` | —                                                           |
| `hook`       | `name`, `status` (`ok`/`failed`/`cancelled`), `duration_ms` |
| `hook_error` | `name`                                                      |

Token counts on a `response` event are **already corrected for each provider's distortions** —
Claude Code deduplicated by response id, Codex differenced and cache-adjusted, Antigravity
summed, Gemini CLI deduplicated _and_ summed _and_ cache-adjusted. See the per-provider usage pages under [Providers](../providers.md).

`hook_error` exists because Claude Code's `stop_hook_summary` reports failures with no matching
execution record, so a hook's failure count and its execution count legitimately diverge.
Emitting a `hook` event per failure would invent runs that never happened.

### The day rollup

```sql
CREATE TABLE day(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  prompts INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0,
  UNIQUE(file_id, day)
);
```

Six child tables hang off it, each keyed by `(day_id, <name>)` and cascading on delete:

| Table         | Key column | Counters                                                                                                                              |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `day_model`   | `model`    | `input`, `output`, `cache_read`, `cache_write`, `cache_write_5m`, `cache_write_1h`, `thinking`, `web_search`, `web_fetch`, `requests` |
| `day_tool`    | `tool`     | `calls`                                                                                                                               |
| `day_skill`   | `skill`    | `calls`                                                                                                                               |
| `day_command` | `command`  | `calls`                                                                                                                               |
| `day_agent`   | `agent`    | `count`, `max_depth`                                                                                                                  |
| `day_hook`    | `hook`     | `count`, `failures`, `cancelled`, `total_ms`, `max_ms`                                                                                |

A day is a **UTC calendar day**, taken from the record's own timestamp. Codex's directory
layout is local time and is never used for this.

### Indexes

```sql
CREATE INDEX file_provider_session ON file(provider, session_id);
CREATE INDEX file_project          ON file(project);
CREATE INDEX file_kind             ON file(provider, kind);
CREATE INDEX day_file              ON day(file_id);
CREATE INDEX day_day               ON day(day);
CREATE INDEX event_file_ts         ON event(file_id, ts);
CREATE INDEX event_day_kind        ON event(day, kind);
```

## A filtered import may not delete

`--since` and `--no-subagents` prune **discovery**, so dropping rows for what such a walk did
not find would evict every entry it never looked at and make the next full import re-parse
everything.

Only a complete walk may delete. That is the `partial` flag in `src/usage/scan.ts`, and
`tests/e2e/usage.test.ts` guards it. The rule survived the move from JSON shards to SQLite
unchanged; only the storage did.

## Day granularity is deliberate

`--since` and `--until` are inclusive **day** bounds. The rollup is what makes
`usage tokens --by day` cheap, and the bounds are pushed into SQL against it. Accepting an
instant would promise a precision the rollup cannot keep, even though the `event` table could
answer it.

The lower bound also prunes the walk by file mtime before anything is opened, which is what
makes `--since 7d` cheap over a large corpus.

## Querying it directly

The event table exists to be queried outside this tool. Nothing here reads it:

```sql
-- tokens by hour of day, which no --by dimension can produce
SELECT substr(ts, 12, 2) AS hour,
       SUM(input + output + cache_read + cache_write) AS tokens
  FROM event WHERE kind = 'response' GROUP BY hour ORDER BY hour;
```

DuckDB reads the file natively if a columnar engine suits the question better.

## Known reporting inconsistencies

[`usage index`](../commands/usage/index.md) predates the store and keeps two fields that no
longer mean what their names suggest. They are recorded in the contract registry `notes` and in
that command's page rather than quietly fixed, because changing them is breaking:

- `shards` is retained at `0` — one store replaced the per-project shard files, but it is a
  required property of the published schema
- `bytes` on a `caches` entry is the whole store's size, repeated, rather than a per-entry
  figure
- `removed` now counts transcripts, not files

## Related

- [Shared usage command behavior](../commands/usage/common.md)
- [`usage index`](../commands/usage/index.md), [`usage import`](../commands/usage/import.md),
  [`usage migrate`](../commands/usage/migrate.md)
- Per-provider parsing: [Claude Code](../providers/claude-code/usage-logs.md),
  [Codex](../providers/codex/usage-logs.md),
  [Antigravity](../providers/antigravity/usage-logs.md),
  [Gemini CLI](../providers/gemini-cli/usage-logs.md),
  [OpenCode](../providers/opencode/usage-logs.md),
  [Cursor](../providers/cursor/usage-logs.md)
