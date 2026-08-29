# `usage providers`

## Synopsis

```text
claude-cli usage providers [options]
```

Lists the log sources `usage` can report on, whether each has left anything on this
machine, and what its logs can answer.

## Options

| Option           | Default    | Description                                         |
| ---------------- | ---------- | --------------------------------------------------- |
| `--format <fmt>` | `llm`      | `llm`, `human`, or `json`. Not configurable.        |
| `--envelope`     | `false`    | Wrap `--format json` output in the result envelope. |
| `--logs <dir>`   | Discovered | Test discovery against this directory.              |
| `-h`, `--help`   | —          | Show help.                                          |

## Capabilities are data

Each provider declares what its logs can answer — tokens, cache tokens, tools, skills,
subagents, hooks, MCP, slash commands, projects. Reports read those flags rather than branching
on a provider's name, which is what keeps registering a second assistant to one new module and
one registry line.

`available` is false when the provider has left nothing on this machine. That is not an error:
this command exits `0` either way, and reporting an unavailable provider is the point of it.

## Exit codes

| Condition        | Code | Stream |
| ---------------- | ---- | ------ |
| Listing written  | `0`  | stdout |
| Invocation error | `1`  | stderr |

## Related surfaces

- [`usage summary`](usage-summary.md) gives the headline totals these rows break down.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the scan cache.
