# `usage skills`

## Synopsis

```text
cairn usage skills [options]
```

Skill invocations by name, with how many sessions each reached.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## Where a skill invocation is found

A skill leaves a record on more than one surface depending on how it was invoked, and all of
them are counted: the skill-invoking tool call, the attachment recording which skills a turn
loaded, and the slash-command form.

Names appear exactly as the log records them, so a plugin skill keeps its `plugin:skill`
prefix and a bare project skill does not.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage commands`](usage-commands.md) reports slash command usage by name.
- [`usage tools`](usage-tools.md) breaks tool calls down, including MCP.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
