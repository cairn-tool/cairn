# `archive extract`

## Synopsis

```text
cairn archive extract <target> [options]
```

Writes an archived file back out. `<target>` is an original path or a sha256 prefix.

## Options

| Option                                     | Default | Description                                  |
| ------------------------------------------ | ------- | -------------------------------------------- |
| `--out <dir>`                              | `.`     | Directory to write into.                     |
| [Shared options](common.md#common-options) | —       | `--format`, `--envelope`, `--archive`, `-h`. |

## Resolution

A **path** resolves to its newest version. A **hash** resolves to that exact content, which is how
an older version is reached — take it from `archive list --format json`, or from a `run` payload.
A prefix is accepted, because a full sha256 is not something anyone types; a prefix matching more
than one blob is refused rather than resolved arbitrarily.

The content is re-hashed on the way out and compared against what the index claims, so an archive
whose index and bytes disagree reports that rather than handing back the wrong file.

The file is written under its original basename, never its original path: extraction is for
recovering a file, not for restoring a home directory over itself.

## Exit codes

| Condition                            | Code | Stream |
| ------------------------------------ | ---- | ------ |
| File written                         | `0`  | stdout |
| Invocation error, or nothing matched | `1`  | stderr |

## Recovering without cairn

Segments are ordinary `.tar.gz` files whose members are named by their own sha256, so a file can
be recovered with nothing but `tar`:

```bash
tar tzf archive/segments/seg-000001.tar.gz
tar xzf archive/segments/seg-000001.tar.gz blobs/aa/aada2718...
```

The index maps original paths to hashes; it is a convenience, not a dependency.

## Related surfaces

- [`archive list`](list.md) finds the path or hash to extract.
- [Shared archive command behavior](common.md) documents selection, storage, and incrementality.
