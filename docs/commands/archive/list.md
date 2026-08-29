# `archive list`

## Synopsis

```text
cairn archive list [options]
```

Lists archived artifacts.

## Options

| Option                                     | Default | Description                                        |
| ------------------------------------------ | ------- | -------------------------------------------------- |
| `--provider <name>`                        | `all`   | Limit to one log source.                           |
| `--class <name>`                           | —       | `plan`, `artifact`, `transcript`, or `log`.        |
| `--since <day>`                            | —       | Only artifacts last seen on or after this ISO day. |
| `--top <n>`                                | `20`    | Rows to show; `0` for all.                         |
| [Shared options](common.md#common-options) | —       | `--format`, `--envelope`, `--archive`, `-h`.       |

## Rows

One row per archived **path**, newest first. A path the archive holds several versions of is
listed once, with `versions` counting them — listing each version as its own line would bury the
current state of a corpus under its history.

To reach an older version, take its hash from the archive and pass it to
[`archive extract`](extract.md).

## Exit codes

| Condition        | Code | Stream |
| ---------------- | ---- | ------ |
| Listing written  | `0`  | stdout |
| Invocation error | `1`  | stderr |

An archive that does not exist yet lists nothing and exits `0`: having archived nothing is not an
error.

## Related surfaces

- [`archive extract`](extract.md) writes one of these back out.
- [Shared archive command behavior](common.md) documents selection, storage, and incrementality.
