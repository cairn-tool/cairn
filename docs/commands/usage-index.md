# `usage index`

## Synopsis

```text
cairn usage index [options]
```

Shows, rebuilds, or clears the scan cache.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--rebuild`                                      | —       | Re-parse every transcript and rewrite the cache.                                                                                                          |
| `--clear`                                        | —       | Delete the cache.                                                                                                                                         |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## The cache

Each transcript is reduced once and stored under
`$XDG_CACHE_HOME/cairn/usage/<provider>/`, one shard per project. The key is each file's
path, size, and modification time, so an unchanged transcript is never reopened.

With no flag this reports where the cache is, how many shards and transcripts it holds, its
size, and when it was last written. `--rebuild` re-parses everything and rewrites it;
`--clear` deletes it. The two are mutually exclusive.

Nothing outside the cache directory is written, which is why every `usage` command declares
itself non-writing in the contract. The cache is private and self-invalidating: its internal
format is not published and can change without notice, and a mismatch simply discards the
shard.

`--rebuild` respects `--project`, `--since`, and `--no-subagents`, but a filtered rebuild only
refreshes what it looked at; it does not evict the rest.

## Exit codes

| Condition                                           | Code | Stream |
| --------------------------------------------------- | ---- | ------ |
| Status written, or the cache was rebuilt or cleared | `0`  | stdout |
| Invocation error                                    | `1`  | stderr |

## Related surfaces

- [`usage summary`](usage-summary.md) gives the headline totals these rows break down.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the scan cache.
