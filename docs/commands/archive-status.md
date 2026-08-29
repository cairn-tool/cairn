# `archive status`

## Synopsis

```text
cairn archive status [options]
```

Reports what the archive holds.

## Options

| Option                                             | Default | Description                                  |
| -------------------------------------------------- | ------- | -------------------------------------------- |
| [Shared options](archive-common.md#common-options) | —       | `--format`, `--envelope`, `--archive`, `-h`. |

## Reading the payload

Opens no segment; every figure comes from the index.

| Field             | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `blobs`           | Distinct stored contents.                           |
| `artifacts`       | Rows held, counting every version of every path.    |
| `paths`           | Distinct original paths.                            |
| `bytes`           | Uncompressed bytes of stored content, deduplicated. |
| `compressedBytes` | What the segments actually occupy on disk.          |

`blobs` is below `artifacts` wherever files duplicate or have changed, and the gap between the two
is exactly what deduplication and version history are buying.

`byClass[].bytes` sums each artifact row's content, so a blob shared between two paths is counted
under both. The top-level `bytes` is the deduplicated figure. They are meant to differ.

## Exit codes

| Condition        | Code | Stream |
| ---------------- | ---- | ------ |
| Status written   | `0`  | stdout |
| Invocation error | `1`  | stderr |

An archive that does not exist yet reports `present: false` and exits `0`.

## Related surfaces

- [`archive list`](archive-list.md) lists the individual files.
- [Shared archive command behavior](archive-common.md) documents selection, storage, and incrementality.
