# `usage index`

## Synopsis

```text
cairn usage index [options]
```

Shows, rebuilds, or clears the usage store.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--rebuild`                                      | —       | Re-parse every transcript and rewrite its rows.                                                                                                           |
| `--clear`                                        | —       | Drop the selected providers' rows.                                                                                                                        |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## The store

Each transcript is reduced once into a SQLite store at `$XDG_DATA_HOME/cairn/usage.db`. The key
is each file's path, size, and modification time, so an unchanged transcript is never reopened.

With no flag this reports where the store is, how many transcripts, day buckets and events it
holds, its schema version, its size, and when it was last written. `--rebuild` re-parses
everything and rewrites it; `--clear` drops rows. The two are mutually exclusive.

`--rebuild` respects `--project`, `--since`, and `--no-subagents`, but a filtered rebuild only
refreshes what it looked at; it does not evict the rest.

Nothing outside the store is written, which is why every `usage` command declares itself
non-writing in the contract.

## Reading the payload

One store holds every provider, which is why three of its fields do not mean what a
cache-per-provider would suggest. They are recorded here rather than quietly changed, because a
consumer may already read them:

| Field     | Meaning now                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shards`  | Always `0`. It counted the per-project JSON shard files this store replaced, and there is no longer any such thing.                              |
| `removed` | Transcripts dropped by `--clear`, not shard files deleted.                                                                                       |
| `bytes`   | The whole store's size including its write-ahead log, reported identically on every `caches` entry rather than partitioned, and so never summed. |

`entries` keeps its meaning exactly: transcripts held, per provider in `caches` and totalled in
`cache`. `days`, `events` and `schemaVersion` are new and describe the whole store.

`--clear` is scoped by `--provider`: clearing one provider leaves the others intact. The space is
not reclaimed, because `VACUUM` rewrites the entire file for pages the next import reuses anyway.

## Exit codes

| Condition                                           | Code | Stream |
| --------------------------------------------------- | ---- | ------ |
| Status written, or the store was rebuilt or cleared | `0`  | stdout |
| Invocation error                                    | `1`  | stderr |

## Related surfaces

- [`usage import`](usage-import.md) populates the store deliberately rather than as a side effect.
- [`usage migrate`](usage-migrate.md) moves the store between schema versions.
- [`usage summary`](usage-summary.md) gives the headline totals these rows break down.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
