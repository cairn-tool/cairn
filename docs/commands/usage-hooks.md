# `usage hooks`

## Synopsis

```text
cairn usage hooks [options]
```

Hook executions by event and tool, with failure counts and latency.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## What a row means

Rows are keyed as `<Event>:<Tool>` — `PostToolUse:Write`, `PreToolUse:Bash` — exactly as the
log records the hook. A hook that exited non-zero counts under `failures`; one that was
cancelled before finishing counts under `cancelled` and not as a failure.

`mean` and `max` are wall-clock durations, which makes this the place to find a hook that is
quietly costing a second on every edit.

Stop hooks report through a per-session summary record rather than a per-execution one, and are
counted from it under the key `Stop`. Counting both surfaces cannot double-count a single
execution, because no hook appears on both.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage tools`](usage-tools.md) breaks tool calls down, including MCP.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
