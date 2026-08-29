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
