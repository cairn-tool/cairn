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
