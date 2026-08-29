# `usage tools`

## Synopsis

```text
cairn usage tools [options]
```

Tool calls rolled up by name, kind, MCP server, day, or session.

## Options

| Option                                           | Default   | Description                                                                                                                                               |
| ------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--by <dimension>`                               | `name`    | `name`, `kind`, `server`, `day`, `session`, or `provider`.                                                                                                |
| `--kind <kind>`                                  | All kinds | Limit to `builtin`, `mcp`, `agent`, or `skill` calls.                                                                                                     |
| [Shared options](usage-common.md#common-options) | —         | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## MCP

An MCP tool is recorded under the name `mcp__<server>__<tool>`. Rather than give MCP a
subcommand of its own, this command splits that name into its server and tool halves: `--by
name` reports `kind` and `server` on each row, `--by server` groups by server with every
builtin under a single `(builtin)` bucket, and `--kind mcp` narrows to MCP alone.

A server name may itself contain underscores, so the split is taken at the first boundary after
the prefix.

The subagent-spawning tool is classified as `agent` and the skill-invoking tool as `skill`, so
`--by kind` reads as a breakdown of what kind of work the calls were.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage agents`](usage-agents.md) reports what the subagent calls actually cost.
- [`usage skills`](usage-skills.md) reports skill invocations by name.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
