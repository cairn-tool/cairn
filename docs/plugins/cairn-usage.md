# `cairn-usage`

Source: `plugins/cairn-usage/`. Bundle `schemaVersion: "2"`, version `1.0.0`.

Wraps the `usage` toolset: the reports over local assistant transcripts, the SQLite store behind them, and what each provider's log format does to the numbers.

See [the `usage` command listing](../commands.md) for the commands these skills invoke, and
[Cairn's own plugins](../plugins.md) for installing, building, and versioning all five.

## At a glance

| Component           | Count                                 |
| ------------------- | ------------------------------------- |
| Skills              | 3 (2 model-invoked, 1 slash commands) |
| Subagents           | 1                                     |
| Hooks               | 0                                     |
| MCP servers         | 0                                     |
| Assets              | 1                                     |
| Contract test cases | 5                                     |

## Skills

| Skill                             | Invocation                                   | Reference    |
| --------------------------------- | -------------------------------------------- | ------------ |
| [`usage-reports`](#usage-reports) | model-invoked                                | `reports.md` |
| [`usage-store`](#usage-store)     | model-invoked                                | `store.md`   |
| [`usage-today`](#usage-today)     | `/usage-today [--since 7d] [--provider all]` | —            |

### `usage-reports`

Report on local LLM assistant usage with the cairn usage toolset — tokens by model or day, tool calls, sessions, projects, skills, subagents, hooks, and slash commands. Use when asked what an assistant cost, what it spent time on, which tools or skills were used, or how usage compares across projects or time.

Reference sidecar: `reference/reports.md`, loaded only when the body points at it.

### `usage-store`

Manage the cairn usage store and understand what its numbers mean. Use when importing transcripts, rebuilding or clearing the usage index, applying store migrations, or explaining why a usage figure differs from a raw count of the log files.

Reference sidecar: `reference/store.md`, loaded only when the body points at it.

### `usage-today`

Show recent cairn usage totals.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `[--since 7d] [--provider all]`

## Subagents

| Subagent                          | Model      | Tools           | Preloaded skills               |
| --------------------------------- | ---------- | --------------- | ------------------------------ |
| [`usage-analyst`](#usage-analyst) | `balanced` | `[read, shell]` | `[usage-reports, usage-store]` |

### `usage-analyst`

Investigates LLM usage and spend with cairn, chaining several reports and returning a conclusion. Use for open questions about cost or activity that need more than one query, where the intermediate JSON would otherwise flood the conversation.

Chains several usage reports and returns a conclusion, for open questions about cost or activity that need more than one query.

## Hooks

None. Reporting on transcripts is something you ask for, not something that should happen on every edit.

## MCP servers

None. The `cairn serve mcp` tools are all Markdown tools.

## Assets

| Asset           | Contents                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cli-basics.md` | Shared CLI conventions: output formats, exit codes, which stream carries a payload, and workspace configuration. |

Every skill links it rather than restating the conventions, and it is copied verbatim into every
target.

## Contract tests

`plugins/cairn-usage/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

| Case                                      |
| ----------------------------------------- |
| `renders-a-complete-claude-code-plugin`   |
| `manifest-omits-the-implied-fields`       |
| `explicit-skills-are-user-invocable-only` |
| `auto-skills-stay-model-invocable`        |
| `the-shared-reference-asset-ships`        |

These are model-free: every expectation is evaluated against the same in-memory render
`agent convert` would write.

## Rendering

The collection publishes this plugin for Claude Code only, in the `plugin` profile. The bundle
itself stays portable — `cairn agent convert plugins/cairn-usage --target all` renders it for every
host — but Claude Code is the only marketplace published.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all five.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
- [Complete command listing](../commands.md) — every command these skills invoke.
