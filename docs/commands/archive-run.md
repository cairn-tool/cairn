# `archive run`

## Synopsis

```text
cairn archive run [options]
```

Archives new and changed artifacts.

## Options

| Option                                             | Default           | Description                                                    |
| -------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| `--provider <name>`                                | `claude-code`     | Log source to archive, or `all`.                               |
| `--include <classes>`                              | `plans,artifacts` | `plans`, `artifacts`, `transcripts`, `logs` (comma-separated). |
| `--logs <dir>`                                     | —                 | Read logs from this directory instead of the discovered one.   |
| `--dry-run`                                        | —                 | Report what would be archived without storing anything.        |
| `--segment-size <bytes>`                           | `67108864`        | Seal a segment once it reaches this many uncompressed bytes.   |
| `-v`, `--verbose`                                  | —                 | Print one line per artifact to stderr.                         |
| `--no-progress`                                    | —                 | Suppress the progress line.                                    |
| [Shared options](archive-common.md#common-options) | —                 | `--format`, `--envelope`, `--archive`, `-h`.                   |

## What it does

Walks the directories each provider declares, and takes in anything the selected classes match.
See [what gets archived](archive-common.md#what-gets-archived) for the per-provider sets and why
selection is an allowlist rather than a filtered sweep.

A run is incremental in two independent ways — unchanged files are never opened, and content
already stored is never written twice — so the second run over an unchanged corpus costs one
`stat` per file. A file whose content changes is stored again under a new hash, keeping its older
version rather than replacing it.

`--dry-run` opens nothing at all: it reports what the sets matched and how large it is, from the
`stat` the walk already performed. It is the right way to find out what `--include transcripts`
would cost before committing to it.

## Watching a long run

A run over a full corpus is tens of thousands of files and takes minutes, so it reports as it
goes. Two levels, answering different questions.

**The progress line** answers _is it still going, and how far in_. It rewrites itself in place on
stderr:

```text
  38% 9184/24093 files - 3.0G/7.8G - 12 seg - 41.2M/s - 1m14s - ...tool-results/report.pdf
```

Because it rewrites in place it appears only when **stderr is a terminal**, `--format` is not
`json`, and `CI` is unset — the same gate the update notice uses, and for the same reason: a
carriage-return-rewritten line is corruption in a redirected log and noise in a CI transcript.
`--no-progress` turns it off. On a narrow terminal the path gives way before the counters do.

**`--verbose`** answers _what exactly did it do to which file_, one durable line per artifact:

```text
stored    plan            13.3k  00be1c87ba76  /Users/you/.claude/plans/some-plan.md
duplicate artifact         2.1M  4f2a91c0de35  /Users/you/.claude/projects/x/page-3.jpg
unchanged transcript       881k  ------------  /Users/you/.claude/projects/x/session.jsonl
sealed    seg-000013.tar.gz  24.8M  431 blobs
```

An `unchanged` row carries no hash, because such a file is never opened — that is the whole point
of the freshness check. Verbose is **not** gated on a terminal, since being redirectable is what it
is for:

```bash
cairn archive run --provider all --include plans,artifacts,transcripts,logs -v 2> archive.log
```

`--verbose` suppresses the progress line, which would otherwise fight it for the same row. An
unreadable file is reported durably at either level.

## Reading the counters

| Counter      | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `discovered` | Files the sets matched.                                           |
| `unchanged`  | Already indexed at this size and modification time; never opened. |
| `hashed`     | Opened and hashed.                                                |
| `duplicate`  | Hashed, but the content was already held; only a row was written. |
| `stored`     | Written into a segment.                                           |
| `skipped`    | Matched but unreadable; also listed under `failures`.             |

A healthy second run is almost all `unchanged`. A run that is mostly `duplicate` means files are
being touched without being changed, which costs a hash but no storage.

## Exit codes

| Condition                          | Code | Stream |
| ---------------------------------- | ---- | ------ |
| Run completed                      | `0`  | stdout |
| Invocation error, or no logs found | `1`  | stderr |

An unreadable file is counted under `run.failures` and never fatal.

## Related surfaces

- [`archive status`](archive-status.md) reports what the archive holds afterwards.
- [`archive verify`](archive-verify.md) checks it against its index.
- [Shared archive command behavior](archive-common.md) documents selection, storage, and incrementality.
