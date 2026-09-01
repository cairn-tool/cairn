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

| Provider      | Source                              | Notes                                                                                                |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `claude-code` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | The default. Records every surface.                                                                  |
| `codex`       | `$CODEX_HOME` or `~/.codex`         | No hook executions are written to the transcripts.                                                   |
| `antigravity` | `~/.gemini/antigravity-cli`         | CLI only; the IDE store is encrypted. No cache detail, skills, or MCP.                               |
| `gemini-cli`  | `~/.gemini`                         | No environment override. Slash commands come from a per-project `logs.json`; no MCP or hook records. |
| `opencode`    | `$XDG_DATA_HOME/opencode`           | One SQLite store for every session. No skills, hooks, MCP, or slash commands.                        |
| `cursor`      | The Cursor user-data directory      | One SQLite store for every conversation. **Stopped writing token counters in December 2025.**        |

Cursor is the only source that reads from a platform-specific location and the only one whose
files span two trees; see [its usage page](../../providers/cursor/usage-logs.md). It is also the
only one whose tokens have an end date: the figures it wrote are real, and it stopped writing
them, so a window after 2025 reports sessions and tools against no tokens.

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

- [`usage summary`](summary.md) gives the headline totals these rows break down.
- [Shared usage command behavior](common.md) documents log discovery, counting, windows, project selection, and the store.
