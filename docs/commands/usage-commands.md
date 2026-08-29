# `usage commands`

## Synopsis

```text
cairn usage commands [options]
```

Slash command usage by name, with how many sessions each reached.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## How a slash command is found

There is no field in the logs recording a slash command. What is recorded is a marker block
inside the user's own message text, and the name is extracted from that.

The consequence is that this reports commands as they were typed, including one that failed or
was never defined.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage skills`](usage-skills.md) reports skill invocations by name.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
