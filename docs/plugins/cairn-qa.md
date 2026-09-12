# `cairn-qa`

Source: `plugins/cairn-qa/`. Bundle `schemaVersion: "2"`, version `1.1.0`.

Wraps the `qa` toolset: running a queue of TC-N test-case plans across Cursor, Claude Code, and
Codex backends, the case-file schema the runner parses, and the run-record shapes the tracker reads
back.

See [the `qa` command listing](../commands.md#qa-commands) for the commands these skills invoke,
and [Cairn's own plugins](../plugins.md) for installing, building, and versioning all eight.

## At a glance

| Component           | Count                                |
| ------------------- | ------------------------------------ |
| Skills              | 4 (3 model-invoked, 1 slash command) |
| Subagents           | 0                                    |
| Hooks               | 0                                    |
| MCP servers         | 0                                    |
| Assets              | 0                                    |
| Contract test cases | 9                                    |

## Skills

| Skill                             | Invocation                                          | Reference                              |
| --------------------------------- | --------------------------------------------------- | -------------------------------------- |
| [`qa-case-plan`](#qa-case-plan)   | model-invoked                                       | `case-file.md`, `plan.md`              |
| [`qa-run-record`](#qa-run-record) | model-invoked                                       | `run-record.md`, `tracker-contract.md` |
| [`qa-runner`](#qa-runner)         | model-invoked                                       | `running.md`                           |
| [`run-qa`](#run-qa)               | `/run-qa [runs-dir] [--only tc-N,tc-M] [--dry-run]` | —                                      |

### `qa-case-plan`

The standard for a `cairn qa` test case — the `_plans/tc-N.yaml` case file with its seven keys and
its `parallel`/`tags` concurrency declaration, and the numbered plan document the running agent
receives as its entire briefing.

Reference sidecars: `reference/case-file.md` and `reference/plan.md`, loaded only when the body
points at them.

### `qa-run-record`

The standard for a run record — the `_report.md` sections and the `_results.md` `## Outcome` block,
the attestations, the verdict vocabulary, and the exact shapes `cairn qa summary` parses out of
them. A heading in the wrong form makes a real verdict unreadable rather than untidy.

Reference sidecars: `reference/run-record.md` and `reference/tracker-contract.md`.

### `qa-runner`

Run a queue of test-case plans: dispatching it, previewing it, checking what is pending, and
regenerating `summary.md`. Model-invoked, because reading a queue's state is something the assistant
should reach for on its own — launching one is not, which is what `run-qa` is for.

Reference sidecar: `reference/running.md`.

### `run-qa`

Run this repository's pending test-case queue with `cairn qa`.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never reaches
for it on its own. **`qa run` spawns agents with permission checks bypassed**, which is exactly the
kind of thing that must not activate on relevance.

Argument hint: `[runs-dir] [--only tc-N,tc-M] [--dry-run]`

## Subagents

None. The bundle this was ported from carries a planner and a read-only auditor, but both exist to
drive an authoring workflow built around one organization's QA process — an upstream index and
per-case step documents — which cairn knows nothing about. A read-only auditor for finished run
records would earn its place here later; it judges records against the standard alone.

## Hooks

None, deliberately. Authoring a case is not a lifecycle event, and `qa run` must never fire
implicitly: it launches agents that write wherever the case tells them to.

## MCP servers

None, and not only because the workspace engine is Markdown-specific. `cairn serve mcp` is
registered by [`cairn-markdown`](cairn-markdown.md) and nowhere else, because one server carries
every toolset's tools — registering it again here would hand a host that installs both plugins the
same seventeen tools twice. `qa run` could not appear there in any case: that server is read-only,
and process execution has no place behind it, the same rule as `scripts run`.

## Assets

None. The two newest bundles omit the shared `cli-basics.md`; each skill instead opens by naming the
guard, `cairn describe qa -fj`, which also confirms the toolset exists in the installed cairn. Every
`qa` command is `stability: experimental`, so that check is worth more here than a conventions link.

## Contract tests

`plugins/cairn-qa/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

| Case                                                                      |
| ------------------------------------------------------------------------- |
| `renders-a-complete-claude-code-plugin`                                   |
| `manifest-omits-the-implied-fields`                                       |
| `only-the-launching-skill-is-explicit`                                    |
| `the-runner-pins-the-load-bearing-facts`                                  |
| `the-pending-case-invariant-is-stated-wherever-a-folder-could-be-created` |
| `the-quoted-expectation-rule-survives-wherever-an-expectation-is-written` |
| `the-trackers-parse-rules-stay-exact`                                     |
| `every-reference-ships-with-the-skill-that-cites-it`                      |
| `the-cursor-plugin-namespaces-every-skill-and-keeps-the-references`       |

These are model-free: every expectation is evaluated against the same in-memory render
`agent convert` would write. Two of them guard rules rather than shapes — the quoted-expectation
rule, and the invariant that a `tc-N/` folder must never be created by hand — because losing either
is a silent regression rather than a broken build.

## Rendering

The collection publishes this plugin for Claude Code, Codex, and Cursor in the `plugin` profile.
The bundle itself stays portable — `cairn agent convert plugins/cairn-qa --target all` renders it
for every host, including hosts without a marketplace catalog.

Note that `run-qa`'s explicit invocation policy is advisory on Cursor, Antigravity and OpenCode
(`AB310`): those hosts may still activate it on relevance. The skill body states what it launches in
its first numbered step for that reason.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all eight.
- [QA case file](../formats/qa-case-file.md) — the `_plans/tc-N.yaml` schema.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
- [QA guide](../guide/qa.md) — why the toolset exists.
