# `usage tokens`

## Synopsis

```text
cairn usage tokens [options]
```

Token usage rolled up along one dimension.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--by <dimension>`                               | `model` | `model`, `day`, `week`, `month`, `project`, `session`, or `provider`.                                                                                     |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## Dimensions

`day`, `week`, and `month` are ordered chronologically; every other dimension is ranked by
token total, largest first. A week is keyed by the Monday it starts on.

`--by provider` is what makes `--provider all` legible: it splits a merged report back into one
row per assistant.

Each row carries the full token breakdown plus `requests` and the number of distinct sessions
that contributed to it.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage sessions`](usage-sessions.md) reports the same activity one session at a time.
- [`usage projects`](usage-projects.md) reports the same activity one project at a time.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the scan cache.
