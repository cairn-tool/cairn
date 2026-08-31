# `cairn-archive`

Source: `plugins/cairn-archive/`. Bundle `schemaVersion: "2"`, version `1.0.0`.

Wraps the `archive` toolset: capturing plans, artifacts, transcripts, and logs into long-term storage before they are pruned, and getting them back.

See [the `archive` command listing](../commands.md) for the commands these skills invoke, and
[Cairn's own plugins](../plugins.md) for installing, building, and versioning all six.

## At a glance

| Component           | Count                                 |
| ------------------- | ------------------------------------- |
| Skills              | 3 (2 model-invoked, 1 slash commands) |
| Subagents           | 0                                     |
| Hooks               | 0                                     |
| MCP servers         | 0                                     |
| Assets              | 1                                     |
| Contract test cases | 5                                     |

## Skills

| Skill                                       | Invocation                          | Reference    |
| ------------------------------------------- | ----------------------------------- | ------------ |
| [`archive-operations`](#archive-operations) | model-invoked                       | `archive.md` |
| [`archive-retrieve`](#archive-retrieve)     | model-invoked                       | —            |
| [`archive-status`](#archive-status)         | `/archive-status [--archive <dir>]` | —            |

### `archive-operations`

Archive assistant plans, artifacts, transcripts, and logs into long-term storage with the cairn archive toolset. Use when capturing what an assistant produced before it is pruned, checking what an archive already holds, or verifying an archive's integrity.

Reference sidecar: `reference/archive.md`, loaded only when the body points at it.

### `archive-retrieve`

Find and extract a file from a cairn archive. Use when recovering an archived plan, artifact, transcript, or log, or when applying pending archive index migrations.

### `archive-status`

Report what a cairn archive holds.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `[--archive <dir>]`

## Subagents

None. A subagent earns its place when a workflow would otherwise flood the conversation
with intermediate output; these commands answer in one step.

## Hooks

None, deliberately. `archive run` can run for minutes and write gigabytes; it must never fire implicitly.

## MCP servers

None. The `cairn serve mcp` tools are all Markdown tools.

## Assets

| Asset           | Contents                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cli-basics.md` | Shared CLI conventions: output formats, exit codes, which stream carries a payload, and workspace configuration. |

Every skill links it rather than restating the conventions, and it is copied verbatim into every
target.

## Contract tests

`plugins/cairn-archive/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

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
itself stays portable — `cairn agent convert plugins/cairn-archive --target all` renders it for every
host — but Claude Code is the only marketplace published.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all six.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
- [Complete command listing](../commands.md) — every command these skills invoke.
