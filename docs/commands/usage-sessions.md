# `usage sessions`

## Synopsis

```text
cairn usage sessions [options]
```

One row per session, with its subagent transcripts folded in.

## Options

| Option                                           | Default  | Description                                                                                                                                               |
| ------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--sort <order>`                                 | `recent` | `recent`, `tokens`, `tools`, or `duration`.                                                                                                               |
| [Shared options](usage-common.md#common-options) | —        | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## What a row covers

A session's row includes the transcripts of every subagent it spawned: those are work the
session caused, and reporting them separately would make the expensive sessions look cheap.
`sub` counts how many such transcripts there were.

Identity — title, project, branch — comes from the main transcript, which is the only one that
carries it. `duration` is the span between the session's first and last recorded timestamp, so
an idle session that was resumed the next day reads as a long one.

`--last n` selects the n most recently active **sessions** rather than the n most recent files,
so a session's subagent spend is never dropped from its own row.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage projects`](usage-projects.md) reports the same activity one project at a time.
- [`usage agents`](usage-agents.md) reports what the subagent calls actually cost.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
