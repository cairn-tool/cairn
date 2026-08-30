# `cairn-scripts`

Source: `plugins/cairn-scripts/`. Bundle `schemaVersion: "2"`, version `1.0.0`.

Wraps the `scripts` toolset: running a repository's named scripts, and authoring the `.cairn.yml` registry that declares them.

See [the `scripts` command listing](../commands.md) for the commands these skills invoke, and
[Cairn's own plugins](../plugins.md) for installing, building, and versioning all five.

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

| Skill                                   | Invocation                        | Reference       |
| --------------------------------------- | --------------------------------- | --------------- |
| [`run-script`](#run-script)             | `/run-script <name> [-- args...]` | —               |
| [`scripts-registry`](#scripts-registry) | model-invoked                     | —               |
| [`scripts-runner`](#scripts-runner)     | model-invoked                     | `resolution.md` |

### `run-script`

Run a named script from this repository's .cairn.yml.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `<name> [-- args...]`

### `scripts-registry`

Author the scripts block in a .cairn.yml registry for the cairn scripts toolset. Use when adding or changing a named script, choosing between a shell body and an argv array, or deciding where a script should run from.

### `scripts-runner`

Run a repository's named scripts with the cairn scripts toolset. Use when a task should invoke a project-defined command rather than a hardcoded one, when a script name needs resolving from a subdirectory, or when listing what scripts a repository declares.

Reference sidecar: `reference/resolution.md`, loaded only when the body points at it.

## Subagents

None. A subagent earns its place when a workflow would otherwise flood the conversation
with intermediate output; these commands answer in one step.

## Hooks

None, deliberately. Three commands do not justify one, and `scripts run` is the only command that executes anything — it must never fire implicitly.

## MCP servers

None. The read-only workspace engine is Markdown-specific and ships in `cairn-markdown`.

## Assets

| Asset           | Contents                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cli-basics.md` | Shared CLI conventions: output formats, exit codes, which stream carries a payload, and workspace configuration. |

Every skill links it rather than restating the conventions, and it is copied verbatim into every
target.

## Contract tests

`plugins/cairn-scripts/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

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
itself stays portable — `cairn agent convert plugins/cairn-scripts --target all` renders it for every
host — but Claude Code is the only marketplace published.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all five.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
- [Complete command listing](../commands.md) — every command these skills invoke.
