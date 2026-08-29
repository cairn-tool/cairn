# `usage migrate`

## Synopsis

```text
cairn usage migrate [options]
```

Applies pending usage store migrations.

## Options

| Option       | Default | Description                                         |
| ------------ | ------- | --------------------------------------------------- |
| `--check`    | —       | Report what is pending without writing.             |
| `--format`   | `llm`   | Output format: `llm`, `human`, `json`.              |
| `--envelope` | —       | Wrap `--format json` output in the result envelope. |

## Why it exists

Every command that opens the store migrates it first, so this is needed only in two cases:
`--check`, which reports what is pending without writing, and migrating deliberately before a run
rather than discovering mid-report that it was needed.

## Migrated, not discarded

The store's schema version is hand-owned, and it is the first version in this project that is
migrated rather than thrown away. The other private caches here — the URL cache, the workspace
index — invalidate by discarding: a mismatch costs a re-parse and nothing else.

This one cannot work that way. Once [`archive run --include transcripts`](archive-run.md) has run
and the source logs are pruned, the store may be the only record of that usage left on the
machine. A version bump therefore has to carry the data forward.

Three rules follow, and they are enforced in `src/usage/db/migrations.ts`:

- a shipped migration is never edited, because a store in the field has already run it
- a migration has to work on real data, not only on an empty file
- **a store written by a newer `cairn` is refused, not guessed at** — it may carry columns this
  build knows nothing about, and opening it read-write risks dropping them

## Exit codes

| Condition                                                           | Code | Stream |
| ------------------------------------------------------------------- | ---- | ------ |
| Store is current, or was migrated                                   | `0`  | stdout |
| Invocation error, or the store is newer than this build understands | `1`  | stderr |

## Related surfaces

- [`usage import`](usage-import.md) fills the store this migrates.
- [`usage index`](usage-index.md) reports its schema version alongside its contents.
- [The contract](../contract.md) lists every hand-owned version in this project.
