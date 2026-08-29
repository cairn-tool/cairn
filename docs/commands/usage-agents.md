# `usage agents`

## Synopsis

```text
cairn usage agents [options]
```

Subagent activity by agent type, with the tokens each actually cost.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--by <dimension>`                               | `role`  | `role` or `path`.                                                                                                                                         |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## Where the numbers come from

`spawns` is counted from the parent session's tool calls. `tokens`, `tools`, and `transcripts`
come from the subagent transcripts themselves.

That split is deliberate. The parent's own record of a subagent call carries a token figure,
but it is the subagent's _final message_ only, which understates the real total several-fold.
Reading the subagent transcript is the only way to get an honest number, which is also why
`--no-subagents` leaves this command with spawn counts and no token figures.

`depth` is the deepest nesting observed for that type: `1` is a subagent of the main session,
`2` a subagent of a subagent. A subagent transcript whose type was not recorded is grouped
under `(unrecorded)` rather than dropped.

## Role and path

`--by role` groups by the reusable agent type — the thing you would spawn again. `--by path`
groups by the task-specific identifier, which only some providers record and which turns the
rollup into a per-task listing rather than a type breakdown.

Spawn counts come from the parent's tool calls, which name an agent by its type. There is no
per-path spawn record, so under `--by path` the transcript count _is_ the spawn count.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage tools`](usage-tools.md) breaks tool calls down, including MCP.
- [`usage sessions`](usage-sessions.md) reports the same activity one session at a time.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the scan cache.
