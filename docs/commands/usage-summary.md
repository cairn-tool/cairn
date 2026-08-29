# `usage summary`

## Synopsis

```text
cairn usage summary [options]
```

Headline totals over the selected window: sessions, prompts, tokens by class and by
model, the busiest tools, and a count of each feature surface.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## What it reports

The token block separates input, output, cache read, and cache write, and splits the total
between main and subagent transcripts so the cost of delegation is visible rather than folded
in. `thinking` is the part of the output that was reasoning.

The feature block counts skill invocations, subagents spawned, hook executions and how many of
them failed, MCP tool calls, and slash commands.

Model and tool listings are capped at ten rows; use [`usage tokens`](usage-tokens.md) and
[`usage tools`](usage-tools.md) for the full picture.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage tokens`](usage-tokens.md) breaks the same tokens down by model, time, project, or session.
- [`usage sessions`](usage-sessions.md) reports the same activity one session at a time.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the scan cache.
