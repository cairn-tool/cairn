# Archive commands in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats, exit codes, and config
discovery.

Every archive command takes `--archive <dir>`, defaulting to `XDG_DATA_HOME/cairn/archive`.

## `archive run`

| Option                   | Default          | Meaning                                                      |
| ------------------------ | ---------------- | ------------------------------------------------------------ |
| `--provider <name>`      | `claude-code`    | One log source, or `all`                                     |
| `--include <classes>`    | plans, artifacts | Comma-separated: `plans`, `artifacts`, `transcripts`, `logs` |
| `--logs <dir>`           | provider's own   | Read logs from here instead                                  |
| `--dry-run`              | off              | Report without storing anything                              |
| `--segment-size <bytes>` | —                | Seal a segment at this many uncompressed bytes               |
| `-v`, `--verbose`        | off              | One durable line per artifact, with disposition              |
| `--no-progress`          | off              | Suppress the progress line                                   |

A run is incremental twice over: unchanged files are never opened, and content already stored is
never written twice. What gets archived is **declared per provider** rather than swept from a home
directory.

`archive run` declares `writes: true` in the command contract even though it writes only to its
own store, because the archive's location is a durable directory the user chose and may point at
external storage.

## `archive status`

What the archive holds: artifact counts by class, segment count, and size. No options beyond
`--archive`.

## `archive list`

| Option              | Default | Meaning                                           |
| ------------------- | ------- | ------------------------------------------------- |
| `--provider <name>` | `all`   | Limit to one log source                           |
| `--class <name>`    | —       | `plan`, `artifact`, `transcript`, or `log`        |
| `--since <day>`     | —       | Only artifacts last seen on or after this ISO day |
| `--top <n>`         | `20`    | Rows to show; `0` for all                         |

## `archive extract <target>`

| Option        | Default | Meaning                 |
| ------------- | ------- | ----------------------- |
| `--out <dir>` | `.`     | Directory to write into |

The only archive command that writes outside the archive.

## `archive verify`

| Option   | Meaning                                             |
| -------- | --------------------------------------------------- |
| `--deep` | Also decompress every segment and re-hash each blob |

Exits `2` on corruption **without** `--strict`, unlike every other `usage` and `archive` command.
Corruption is the finding this command exists to report; making it opt-in would defeat the point.

## `archive migrate`

| Option    | Meaning                                |
| --------- | -------------------------------------- |
| `--check` | Report what is pending without writing |

The index version is hand-owned and **migrated rather than discarded**. Unlike a cache, a version
mismatch may not throw the file away: after `archive run --include transcripts` and a later prune
of the source logs, the archive can be the only record of that usage left. An index from a newer
build is refused, not opened.

## Cursor's second tree

Every other provider needs one root, because the usage provider's log root already contains
everything worth archiving. Cursor does not: its conversation store is in the Electron user-data
directory while its plans, agent transcripts and produced files are under `~/.cursor`. On macOS
those share only `$HOME`, and rooting a set there would be exactly the home-directory sweep the
per-provider declaration exists to prevent — so the profile names the second tree explicitly, and
its sets contribute nothing when that tree is absent.

Most of both trees is excluded, and the exclusions carry more weight here than elsewhere:
`extensions/` alone is 3.8 GB, and `CachedData/`, `Partitions/`, `WebStorage/`, `Cache/`,
`GPUCache/` and `blob_storage/` are another ~600 MB of derived state. `User/History/` is VS Code's
local file history, excluded for the same reason as Claude Code's `file-history/`, and
`~/.config/cursor/cli-config.json` holds a credential and is kept out of reach entirely.

The editor-store set matches `state.vscdb` by **exact equality**, which keeps out the live `-wal`
and `-shm` sidecars — the backup API folds those into the snapshot anyway — and keeps out
`state.vscdb.backup`, a stale multi-gigabyte copy on a real machine. Databases are captured
through SQLite's backup API rather than copied byte for byte.

## The store format

Segments are ordinary `.tar.gz` files. Members are named `blobs/<aa>/<sha256>` — 73 characters,
comfortably inside a ustar `name` field.

That naming is both deduplication and a path-length defence. The real paths are not short: the
corpus nests seven deep under project slugs that are themselves absolute paths with separators
replaced, and the writer refuses a path that will not fit a ustar header rather than escalating
to a PAX record. Storing by original path would fail on real data _and_ lose deduplication.

A blob still buffered in the current segment is not the same as a stored one — its `blob` row does
not exist until the segment is sealed.

## Related toolset

`cairn usage` reports on the same transcripts before they are archived.
