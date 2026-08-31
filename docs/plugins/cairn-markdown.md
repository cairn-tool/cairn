# `cairn-markdown`

Source: `plugins/cairn-markdown/`. Bundle `schemaVersion: "2"`, version `1.0.0`.

Wraps the `md` toolset: linting and validation, reading a document's structure without opening it, querying a whole workspace, and safe refactors. The only plugin that carries both a hook and an MCP server.

See [the `md` command listing](../commands.md) for the commands these skills invoke, and
[Cairn's own plugins](../plugins.md) for installing, building, and versioning all six.

## At a glance

| Component           | Count                                 |
| ------------------- | ------------------------------------- |
| Skills              | 7 (4 model-invoked, 3 slash commands) |
| Subagents           | 1                                     |
| Hooks               | 1                                     |
| MCP servers         | 1                                     |
| Assets              | 1                                     |
| Contract test cases | 9                                     |

## Skills

| Skill                                     | Invocation                         | Reference          |
| ----------------------------------------- | ---------------------------------- | ------------------ |
| [`markdown-navigate`](#markdown-navigate) | model-invoked                      | `structure.md`     |
| [`markdown-query`](#markdown-query)       | model-invoked                      | `query-grammar.md` |
| [`markdown-refactor`](#markdown-refactor) | model-invoked                      | `refactor.md`      |
| [`markdown-validate`](#markdown-validate) | model-invoked                      | `validation.md`    |
| [`md-fix`](#md-fix)                       | `/md-fix [path]`                   | —                  |
| [`md-lint`](#md-lint)                     | `/md-lint [path] [--style]`        | —                  |
| [`md-toc`](#md-toc)                       | `/md-toc <file> [--max-depth <n>]` | —                  |

### `markdown-navigate`

Read the structure of a Markdown document without opening the whole file, using the cairn md toolset. Use when you need a document's headings, one specific section, its statistics, its code blocks, its tables, its task list, or its frontmatter — especially for a file too large to read comfortably.

Reference sidecar: `reference/structure.md`, loaded only when the body points at it.

### `markdown-query`

Query a whole Markdown workspace with the cairn md toolset instead of grepping. Use when a question spans many documents — find every page linking to a file, every pending task by owner, duplicate titles, unused assets, pages missing an H1 — or when assembling a context pack from the reference graph.

Reference sidecar: `reference/query-grammar.md`, loaded only when the body points at it.

### `markdown-refactor`

Modify Markdown files with the cairn md toolset — apply deterministic fixes, sync a table of contents, rename a heading or a file with every reference updated, and refresh source-linked snippets. Use when changing Markdown content or moving documents, not when only reading them.

Reference sidecar: `reference/refactor.md`, loaded only when the body points at it.

### `markdown-validate`

Lint and validate Markdown with the cairn md toolset. Use when checking a Markdown file or docs tree for broken internal links, invalid Mermaid diagrams, invalid KaTeX math, style violations, unreachable URLs, or frontmatter that does not match its schema.

Reference sidecar: `reference/validation.md`, loaded only when the body points at it.

### `md-fix`

Preview and apply cairn's deterministic Markdown fixes.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `[path]`

### `md-lint`

Lint a Markdown file or directory with cairn.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `[path] [--style]`

### `md-toc`

Generate or synchronize a Markdown table of contents with cairn.

User-invocable only: it renders with `disable-model-invocation: true`, so the model never
reaches for it on its own.

Argument hint: `<file> [--max-depth <n>]`

## Subagents

| Subagent                                | Model     | Tools           | Preloaded skills                      |
| --------------------------------------- | --------- | --------------- | ------------------------------------- |
| [`markdown-auditor`](#markdown-auditor) | `capable` | `[read, shell]` | `[markdown-validate, markdown-query]` |

### `markdown-auditor`

Audits a Markdown documentation tree with cairn and reports prioritized findings. Use when a whole docs directory needs checking and the individual findings would otherwise flood the conversation.

Audits a whole documentation tree and returns prioritized findings, so a directory's worth of individual findings never floods the conversation.

## Hooks

| Event           | Matcher       | Command                           | Timeout |
| --------------- | ------------- | --------------------------------- | ------- |
| `post-tool-use` | `Write\|Edit` | `${BUNDLE_ROOT}/hooks/md-lint.sh` | 30s     |

Lints a `.md` file immediately after it is written. It resolves `cairn` from `PATH` and exits
`0` when it is absent, so a machine without the binary installed still edits normally — the hook
can never block an edit.

Hooks render in the **plugin** profile only.

## MCP servers

| Server  | Command                    | Tools         |
| ------- | -------------------------- | ------------- |
| `cairn` | `cairn serve mcp --root .` | 11, read-only |

Exposes the read-only workspace engine as `mcp__plugin_cairn-markdown_cairn__*`. It ships here
and nowhere else: those eleven tools are all Markdown tools, so registering the same server in
five plugins would register the same eleven tools five times.

`scripts run` is deliberately absent from that surface — config may declare what a script is,
never how it is run. [`tests/unit/serve-tools.test.ts`](https://github.com/cairn-tool/cairn/blob/main/tests/unit/serve-tools.test.ts)
has a tripwire.

## Assets

| Asset           | Contents                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cli-basics.md` | Shared CLI conventions: output formats, exit codes, which stream carries a payload, and workspace configuration. |

Every skill links it rather than restating the conventions, and it is copied verbatim into every
target.

## Contract tests

`plugins/cairn-markdown/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

| Case                                            |
| ----------------------------------------------- |
| `renders-a-complete-claude-code-plugin`         |
| `manifest-omits-the-implied-fields`             |
| `explicit-skills-are-user-invocable-only`       |
| `auto-skills-stay-model-invocable`              |
| `the-hook-resolves-cairn-from-path`             |
| `mcp-invokes-cairn-from-path`                   |
| `the-shared-reference-asset-ships`              |
| `the-auditor-agent-maps-to-native-values`       |
| `the-project-profile-carries-no-plugin-surface` |

These are model-free: every expectation is evaluated against the same in-memory render
`agent convert` would write.

## Rendering

The collection publishes this plugin for Claude Code only, in the `plugin` profile. The bundle
itself stays portable — `cairn agent convert plugins/cairn-markdown --target all` renders it for every
host — but Claude Code is the only marketplace published.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all six.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
- [Complete command listing](../commands.md) — every command these skills invoke.
