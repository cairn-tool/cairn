# `archive verify`

## Synopsis

```text
cairn archive verify [options]
```

Checks the archive against its index.

## Options

| Option                                             | Default | Description                                          |
| -------------------------------------------------- | ------- | ---------------------------------------------------- |
| `--deep`                                           | —       | Also decompress every segment and re-hash each blob. |
| [Shared options](archive-common.md#common-options) | —       | `--format`, `--envelope`, `--archive`, `-h`.         |

## Two passes

The default pass hashes each segment file and compares it with what the index recorded when the
segment was sealed. That catches truncation, corruption, and a segment lost from the directory,
for the cost of reading the archive once.

`--deep` additionally decompresses each segment and re-hashes every member. That catches one more
thing the shallow pass cannot: an index whose recorded offsets no longer point where it claims.

A segment whose own hash already fails is not opened further — it can say nothing reliable about
its members, and reporting a cascade of member failures under it would bury the real finding.

## Exit codes

| Condition                          | Code | Stream |
| ---------------------------------- | ---- | ------ |
| Archive matches its index          | `0`  | stdout |
| Invocation error                   | `1`  | stderr |
| The archive and its index disagree | `2`  | stderr |

This is the only command in the toolset that exits `2` without a `--strict` flag. Corruption is
the actionable finding it exists to report, so making it opt-in would defeat the point.

## Related surfaces

- [`archive status`](archive-status.md) reports what the archive holds without checking it.
- [Shared archive command behavior](archive-common.md) documents selection, storage, and incrementality.
