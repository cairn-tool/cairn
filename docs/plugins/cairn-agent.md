# `cairn-agent`

Source: `plugins/cairn-agent/`. Bundle `schemaVersion: "2"`, version `1.3.0`.

Wraps the `agent` toolset: authoring a portable bundle, migrating a repository onto one, checking it against every host's conformance profile, and publishing it. This plugin is a worked example of what it documents — its own source is a bundle, built by the collection spec at the repository root.

See [the `agent` command listing](../commands.md) for the commands these skills invoke, and
[Cairn's own plugins](../plugins.md) for installing, building, and versioning all eight.

## At a glance

| Component           | Count                                 |
| ------------------- | ------------------------------------- |
| Skills              | 8 (5 model-invoked, 3 slash commands) |
| Subagents           | 1                                     |
| Hooks               | 1                                     |
| MCP servers         | 0                                     |
| Assets              | 1                                     |
| Contract test cases | 11                                    |

## Skills

| Skill                                       | Invocation                                                | Reference                    |
| ------------------------------------------- | --------------------------------------------------------- | ---------------------------- |
| [`agent-check`](#agent-check)               | `/agent-check [bundle-path]`                              | —                            |
| [`agent-migrate`](#agent-migrate)           | `/agent-migrate [path] [--from <target>]`                 | `cutover.md`, `discovery.md` |
| [`agent-new`](#agent-new)                   | `/agent-new <name> [--component skill\|agent\|hook\|mcp]` | —                            |
| [`bundle-authoring`](#bundle-authoring)     | model-invoked                                             | `bundle-format.md`           |
| [`bundle-publishing`](#bundle-publishing)   | model-invoked                                             | `marketplace.md`             |
| [`bundle-testing`](#bundle-testing)         | model-invoked                                             | `tests.md`                   |
| [`portability-triage`](#portability-triage) | model-invoked                                             | `diagnostics.md`             |
| [`target-portability`](#target-portability) | model-invoked                                             | `support-matrix.md`          |

### `agent-check`

Validate, doctor, test, and audit an agent bundle with cairn.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `[bundle-path]`

### `agent-migrate`

Convert a repository's inline provider-specific agent content into a portable cairn bundle, then regenerate the native trees from it.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `[path] [--from <target>]`

Reference sidecars: `reference/cutover.md` and `reference/discovery.md`, loaded only when the body points
at them.

### `agent-new`

Scaffold a new portable agent bundle with cairn.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `<name> [--component skill|agent|hook|mcp]`

### `bundle-authoring`

Author a portable agent bundle with the cairn agent toolset — scaffold it, add skills, subagents, rules, hooks, policies, and MCP config, then render it for each host. Use when creating or editing plugin content that should work on more than one assistant, or when importing an existing native plugin into a portable form.

Reference sidecar: `reference/bundle-format.md`, loaded only when the body points at it.

### `bundle-publishing`

Package, install, and publish agent bundles with the cairn agent toolset, including building a marketplace of several plugins from a collection spec. Use when preparing a bundle for distribution, installing one locally for testing, or assembling several bundles into one marketplace users add once.

Reference sidecar: `reference/marketplace.md`, loaded only when the body points at it.

### `bundle-testing`

Verify an agent bundle with the cairn agent toolset — conformance checks against target profiles, model-free contract tests, and a supply-chain audit. Use when checking that a bundle renders what it should, when a generated tree may have drifted, or before trusting or distributing someone's bundle.

Reference sidecar: `reference/tests.md`, loaded only when the body points at it.

### `portability-triage`

Decide what to do when a portable agent bundle will not render faithfully for a target — accept the approximation, exclude the component, use a conditional block, add a native overlay, or restructure to a portable surface. Use when agent convert, compat, doctor, or verify reports an approximate or unsupported mapping, or when a host-specific feature has no portable equivalent.

Reference sidecar: `reference/diagnostics.md`, loaded only when the body points at it.

### `target-portability`

Understand what each assistant host actually supports when a portable agent bundle is rendered — which component kinds map exactly, which are approximated, and which have no native surface at all. Use when deciding whether a skill, subagent, hook, rule, policy, or MCP server will work on more than one host, or when a feature must be dropped, approximated, or restricted to one target.

Reference sidecar: `reference/support-matrix.md`, loaded only when the body points at it.

## Subagents

| Subagent                              | Model     | Tools           | Preloaded skills                      |
| ------------------------------------- | --------- | --------------- | ------------------------------------- |
| [`bundle-reviewer`](#bundle-reviewer) | `capable` | `[read, shell]` | `[bundle-testing, bundle-publishing]` |

### `bundle-reviewer`

Reviews an agent bundle before it is published or trusted, running cairn's audit and conformance checks and returning a publish or no-publish call. Use before distributing a bundle, or before installing someone else's.

Runs the audit and conformance checks and returns a publish or no-publish call, so the intermediate JSON never reaches the conversation. It preloads `bundle-testing` and `bundle-publishing` and deliberately not the portability skills — portability is not the reviewer's question, and preloading two more would cost context on every review.

## Hooks

| Event          | Matcher                                | Command                                    | Timeout |
| -------------- | -------------------------------------- | ------------------------------------------ | ------- |
| `pre-tool-use` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `${BUNDLE_ROOT}/hooks/guard-generated.mjs` | 10s     |

Refuses an edit to a file cairn generated, and names the bundle source to edit instead. The
decision is [`agent guard`](../commands/agent/guard.md)'s; the script is plumbing — it reads the
host's event, pulls out the path, asks, and writes the answer back in the shape that host reads.

**A repository opts in.** `cairn agent guard` exits `0` on any repository that declares no
[`agent.guard`](../configuration.md#agentguard) block, which is what makes this hook safe to
install once for everything. It resolves `cairn` from `PATH` and allows the edit when the binary
is absent, times out, or reports an invocation error: a guard that failed closed would block
editing on any machine without the CLI, which is a worse failure than the edit it prevents.

One declaration serves every host. Event casing, envelope and handler nesting are the renderer's
job; the two differences that reach the handler are Cursor's `flat` handler shape — which is why
the script filters on the tool name itself rather than trusting the matcher — and the refusal
form, which is exit `2` with the reason on stderr for Claude Code and Codex and a JSON `deny`
decision on stdout for Cursor.

Hooks render in the **plugin** profile only, on every target. So the hook arrives with a plugin
install while the tree it protects is the project-profile one in whatever repository the
assistant is working in: the hook is global, the opt-in is per repository. OpenCode declares no
hook events at all, so no guard is installed there.

## MCP servers

None. The `cairn serve mcp` tools are all Markdown tools; they ship in `cairn-markdown` and nowhere else.

## Assets

| Asset           | Contents                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cli-basics.md` | Shared CLI conventions: output formats, exit codes, which stream carries a payload, and workspace configuration. |

Every skill links it rather than restating the conventions, and it is copied verbatim into every
target.

## Contract tests

`plugins/cairn-agent/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

| Case                                                        |
| ----------------------------------------------------------- |
| `renders-a-complete-claude-code-plugin`                     |
| `the-edit-guard-hook-renders-for-every-host-that-has-hooks` |
| `the-guard-hook-takes-each-hosts-own-shape`                 |
| `the-guard-hook-takes-cursors-flat-versioned-shape`         |
| `manifest-omits-the-implied-fields`                         |
| `explicit-skills-are-user-invocable-only`                   |
| `auto-skills-stay-model-invocable`                          |
| `the-shared-reference-asset-ships`                          |
| `skill-reference-sidecars-ship`                             |
| `the-migration-skill-drives-import-convert-and-verify`      |

These are model-free: every expectation is evaluated against the same in-memory render
`agent convert` would write.

## Rendering

The collection publishes this plugin for Claude Code only, in the `plugin` profile. The bundle
itself stays portable — `cairn agent convert plugins/cairn-agent --target all` renders it for every
host — but Claude Code is the only marketplace published.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all eight.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
- [Complete command listing](../commands.md) — every command these skills invoke.
