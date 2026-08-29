# `archive migrate`

## Synopsis

```text
cairn archive migrate [options]
```

Applies pending archive index migrations.

## Options

| Option                                             | Default | Description                                  |
| -------------------------------------------------- | ------- | -------------------------------------------- |
| `--check`                                          | —       | Report what is pending without writing.      |
| [Shared options](archive-common.md#common-options) | —       | `--format`, `--envelope`, `--archive`, `-h`. |

## Why it exists

Every command that opens the index migrates it first, so this is needed only to migrate
deliberately, or with `--check` to see what is pending before committing to it.

## Migrated, not discarded

The index carries a hand-owned schema version, separate from the usage store's. Like that one it
is migrated forward rather than thrown away, and for a stronger reason: it is the only map from an
original path to the segment holding that file's bytes, and the archive may hold the only copy of
a file whose original has since been deleted.

The segments themselves are never touched by a migration. They are append-only and self-describing
— members named by their own hash — so a migration only ever changes how the index describes them.

**An index written by a newer `cairn` is refused, not opened.** It may carry columns this build
knows nothing about, which a write would drop.

## Exit codes

| Condition                                                           | Code | Stream |
| ------------------------------------------------------------------- | ---- | ------ |
| Index is current, or was migrated                                   | `0`  | stdout |
| Invocation error, or the index is newer than this build understands | `1`  | stderr |

## Related surfaces

- [`usage migrate`](usage-migrate.md) does the same for the usage store.
- [The contract](../contract.md) lists every hand-owned version in this project.
