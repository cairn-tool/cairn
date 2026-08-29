# `usage providers`

## Synopsis

```text
cairn usage providers [options]
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

## Registered providers

| Provider      | Source                              | Notes                                                                  |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `claude-code` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | The default. Records every surface.                                    |
| `codex`       | `$CODEX_HOME` or `~/.codex`         | No hook executions are written to the transcripts.                     |
| `antigravity` | `~/.gemini/antigravity-cli`         | CLI only; the IDE store is encrypted. No cache detail, skills, or MCP. |

Cursor is not registered. It keeps its chat history in a SQLite store whose shape is undocumented,
and adding it needs a machine with real data to write and verify a parser against.

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
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
