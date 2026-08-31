# `cairn-jira`

Source: `plugins/cairn-jira/`. Bundle `schemaVersion: "2"`, version `1.0.0`.

Wraps the `jira` toolset: converting Jira and Confluence rich text between Atlassian Document Format and Markdown, in both directions, and reporting what each conversion approximated or lost.

See [the `jira` command listing](../commands.md#jira-commands) for the commands this skill
invokes, and [Cairn's own plugins](../plugins.md) for installing, building, and versioning all
six.

## At a glance

| Component           | Count             |
| ------------------- | ----------------- |
| Skills              | 1 (model-invoked) |
| Subagents           | 0                 |
| Hooks               | 0                 |
| MCP servers         | 0                 |
| Assets              | 0                 |
| Contract test cases | 5                 |

## Skills

| Skill                         | Invocation    | Reference     |
| ----------------------------- | ------------- | ------------- |
| [`adf-convert`](#adf-convert) | model-invoked | `fidelity.md` |

### `adf-convert`

Convert Jira and Confluence rich text between Atlassian Document Format and Markdown with the cairn jira toolset, in both directions, reporting exactly what each conversion approximated or lost. Use when asked to turn a Jira issue description or comment into Markdown, to turn a Markdown document into ADF for a Jira or Confluence API call, or to check what an ADF document contains before converting it.

Model-invoked rather than a slash command: a conversion is something an assistant should reach
for when it meets an ADF payload, not something a user has to know to ask for by name.

Reference sidecar: `reference/fidelity.md`, loaded only when the body points at it. It maps every
construct in both directions with the code it reports, which is what turns "some things were
approximated" into a specific answer.

## Subagents

None. A subagent earns its place when a workflow would otherwise flood the conversation with
intermediate output; a conversion answers in one step, and the interesting part is the diagnostic
list, which is already short.

## Hooks

None. Nothing here should fire implicitly: the converters write files under `--output`, and a
conversion the user did not ask for is a file they did not expect.

## MCP servers

None. The `cairn serve mcp` tools are all Markdown tools, and deliberately so — the server is a
workspace engine whose every path is confined to `--root`, while a conversion reads a document
that has nothing to do with the workspace.

## Assets

None. The one long reference belongs to the single skill, so it lives in that skill's
`reference/` rather than in a bundle-wide asset shared by nobody.

## Contract tests

`plugins/cairn-jira/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

| Case                                    |
| --------------------------------------- |
| `renders-a-complete-claude-code-plugin` |
| `manifest-omits-the-implied-fields`     |
| `the-skill-stays-model-invocable`       |
| `the-skill-pins-the-load-bearing-facts` |
| `the-fidelity-reference-ships`          |

The last two also assert that `cairn adf` never appears followed by a subcommand — the pre-`jira`
command path.
The toolset was written as a top-level `adf` group before it moved under `jira`, so a stale path
is the likeliest thing to survive an edit, and it would send a reader to a command that does not
exist.

These are model-free: every expectation is evaluated against the same in-memory render
`agent convert` would write.

## Rendering

The collection publishes this plugin for Claude Code only, in the `plugin` profile. The bundle
itself stays portable — `cairn agent convert plugins/cairn-jira --target all` renders it for
every host — but Claude Code is the only marketplace published.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all six.
- [Jira and Confluence rich text](../guide/jira.md) — why the toolset exists.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
