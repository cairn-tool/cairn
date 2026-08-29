# Feature Ideas

One file per idea, serially numbered. This page is the index; the numbered pages hold the
original proposals. This is a forward-looking backlog, not a commitment to implement every
item.

The analysis sections below are the original review, written against the repository at
`5d85165` on 2026-08-02, and are left as written — they are a snapshot of the reasoning, not
a description of current behavior. The **Status** column is the part kept current, and it is
checked against the shipped command surface rather than against this document.

A serial number is permanent. An idea that is dropped keeps its number and is marked
`Withdrawn` rather than being deleted and its number reused, so a reference to `014` means the
same thing forever.

## Ideas

| #                                                             | Idea                                            | Priority | Effort                   | Status      | Payoff                                                    |
| ------------------------------------------------------------- | ----------------------------------------------- | -------- | ------------------------ | ----------- | --------------------------------------------------------- |
| [001](001-target-conformance-profiles-and-agent-doctor.md)    | Target Conformance Profiles and `agent doctor`  | P0       | Medium                   | Shipped     | Prevent silently stale or invalid generated plugins       |
| [002](002-versioned-machine-readable-result-contracts.md)     | Versioned Machine-Readable Result Contracts     | P0       | Medium                   | Shipped     | Make the CLI a dependable API for agents and CI           |
| [003](003-agent-import-and-agent-upgrade.md)                  | `agent import` and `agent upgrade`              | P1       | Large                    | Shipped     | Complete the native-to-neutral-to-native loop             |
| [004](004-agent-init-and-agent-add.md)                        | `agent init` and `agent add`                    | P1       | Small-medium             | Shipped     | Make portable bundles easy to start correctly             |
| [005](005-native-overlays-and-a-richer-component-model.md)    | Native Overlays and a Richer Component Model    | P1       | Medium                   | Shipped     | Preserve platform-only features without false portability |
| [006](006-agent-package-and-marketplace-generation.md)        | `agent package` and Marketplace Generation      | P1       | Large                    | Shipped     | Turn rendered artifacts into installable products         |
| [007](007-agent-audit.md)                                     | `agent audit`                                   | P1       | Medium                   | Shipped     | Add security and supply-chain review before distribution  |
| [008](008-md-context.md)                                      | `md context`                                    | P1       | Medium                   | Shipped     | Produce focused, reproducible context packs for agents    |
| [009](009-md-diff.md)                                         | `md diff`                                       | P1       | Medium                   | Shipped     | Make documentation changes reviewable by meaning          |
| [010](010-planned-markdown-fix-engine.md)                     | Planned Markdown Fix Engine                     | P2       | Large                    | Shipped     | Convert deterministic findings into safe edits            |
| [011](011-composable-workspace-queries.md)                    | Composable Workspace Queries                    | P2       | Medium                   | Shipped     | Avoid a growing list of narrow query kinds                |
| [012](012-source-linked-snippet-checking.md)                  | Source-Linked Snippet Checking                  | P2       | Medium                   | Shipped     | Detect documentation examples that drift from code        |
| [013](013-agent-test.md)                                      | `agent test`                                    | P2       | Medium-large             | Shipped     | Catch behavioral-contract and artifact regressions        |
| [014](014-read-only-mcp-server.md)                            | Read-Only MCP Server                            | P2       | Medium                   | Shipped     | Expose the workspace engine directly to agent hosts       |
| [015](015-library-editor-and-ci-integrations.md)              | Library, Editor, and CI Integrations            | P3       | Large                    | Not started | Reuse the engine without shell parsing                    |
| [016](016-additional-targets-through-an-adapter-interface.md) | Additional Targets Through an Adapter Interface | P3       | Per target: medium-large | Not started | Broaden reach after target maintenance is sustainable     |
| [017](017-named-script-registry.md)                           | Named Script Registry and the `scripts` Toolset | P1       | Medium                   | Shipped     | Make hook and skill scripts resolve from any directory    |

Statuses are `Shipped`, `In progress`, `Not started`, or `Withdrawn`. This table replaces the
review's original priority summary, so priority and status cannot drift apart.

## Product Reading

`cairn` has grown into two related products behind one deterministic, local CLI:

1. A Markdown workspace engine for humans, coding agents, and CI. It parses documents,
   validates content, builds a persistent index and link graph, answers structured queries,
   and performs a small set of safe refactors.
2. A portable agent-bundle compiler. It normalizes skills, agents, hooks, rules, command
   policies, MCP configuration, and assets, then renders Claude Code, Codex, and Cursor
   plugin or project artifacts with explicit compatibility diagnostics.

The common value is not merely "Markdown utilities." It is **model-free, inspectable
compilation and analysis of the files that give agents context and behavior**. The best new
features should reinforce that identity:

- Stay agent- and provider-agnostic at the source-model and command-contract layers.
- Prefer deterministic local operations over calling a hosted model.
- Make machine-readable output a first-class API, without weakening the human and `llm`
  formats.
- Reuse the workspace AST, reference graph, index, diagnostics, and atomic-write machinery.
- Keep writes explicit, previewable, workspace-bounded, and recoverable.
- Model target-specific behavior honestly instead of reducing every platform to a weak
  common denominator.

## Current Capability Map

| Area                 | Existing commands                                                                                                | What is already covered                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Validation           | `md lint`, `lint-dir`, `audit`, `check-urls`, `validate-frontmatter`                                             | Markdown style, Mermaid, KaTeX, local references, URLs, schemas, graph and TOC checks, changed-file selection, JSONL, and SARIF |
| References and graph | `md refs`, `refs-to`, `links`, `orphans`, `graph`                                                                | Outbound and inbound links, broken targets, reachability, components, cycles, Mermaid, and DOT                                  |
| Document inspection  | `md headers`, `outline`, `toc`, `stats`, `structure`, `section`, `frontmatter`, `tasks`, `tables`, `code-blocks` | Structured extraction for the main Markdown constructs                                                                          |
| Workspace data       | `md query`, `index`                                                                                              | Focused cross-file queries and a persistent parsed-document cache                                                               |
| Refactoring          | `md rename-heading`, `rename-file`, plus `toc --write`                                                           | Previewable heading/file moves, inbound-link updates, and marker-scoped generated content                                       |
| Agent bundles        | `agent validate`, `inspect`, `compat`, `convert`                                                                 | Neutral bundle parsing, dependency diagnostics, target/profile rendering, strict/dry-run/check modes, and conversion reports    |
| Distribution         | `check-update`                                                                                                   | Non-blocking release notification and explicit registry checks                                                                  |

The largest gaps are lifecycle gaps rather than missing AST extractors. Markdown analysis can
find information but does not yet prepare it for a task or explain how it changed. Agent
conversion can emit files but does not yet scaffold, import, test, audit, or package the
complete distributable.

## Smaller, Low-Risk Improvements

These do not need to become major roadmap items.

**Shipped:**

- [`completion <shell>`](../../commands/completion.md) generates a static script for Bash, Zsh,
  Fish, and PowerShell from the same command walk `describe` uses.
- [`md audit --baseline`](../../commands/md-audit.md) suppresses known findings and fails only on
  regressions; `--write-baseline` makes recording explicit and reviewable. Entries are keyed
  without a line number, so unrelated edits do not resurface a known finding.
- [`md graph --focus <file> --depth <n>`](../../commands/md-graph.md) projects an undirected
  neighborhood out of the full graph.
- [`md query frontmatter-keys`](../../commands/md-query.md) inventories top-level key adoption
  with counts, coverage, and value types.
- [`agent convert --report <file>`](../../commands/agent-convert.md) writes the conversion report
  to any path, in every mode, without listing it among the artifacts.
- [`agent inspect --target`/`--profile`](../../commands/agent-inspect.md) narrow a large bundle
  using the renderer's own selection predicate and the target profiles.

**Still open:**

- Add a neutral binary alias in a future major packaging pass while retaining `cairn` for
  compatibility; the current name understates the agent-agnostic positioning.

## Suggested Delivery Sequence

1. Build target capability profiles, conformance fixtures, and `agent doctor`.
2. Publish machine-readable schemas and `describe`; refactor command actions toward shared
   result objects where needed.
3. Add `agent init`/`add`, native overlays, then general `agent import` and schema upgrades.
4. Add `agent audit`, followed by deterministic packaging and marketplace output.
5. Implement `md context` and `md diff` on the current workspace/index foundation.
6. Extract the shared edit planner, then add only conservative `md fix` rules.
7. Generalize workspace queries and add source-linked snippet checking.
8. Expose a library API, then build the read-only MCP server and CI integration.
9. Add new targets only through the conformance-backed adapter model.

## Features to Avoid or Defer

- **Hosted model calls in core commands.** They would add credentials, cost, nondeterminism,
  and provider coupling. Emit context and contracts that any agent can consume instead.
- **Executing fenced code by default.** Static snippet synchronization is useful; arbitrary
  execution creates a much larger trust and sandboxing problem.
- **A general Markdown formatter or renderer.** Prettier, markdownlint, and site generators
  already own that space. This project is more differentiated at structural validation,
  graph analysis, context assembly, and safe refactoring.
- **One command per narrow query.** Prefer a typed query engine plus a small number of common
  shortcuts.
- **Automatic publication or plugin installation in the first packaging release.** Produce
  deterministic artifacts and checks first; external mutations can be layered on with clear
  authentication and confirmation boundaries.
- **Immediate support for many agent platforms.** A smaller target set that is continuously
  conformant is more valuable than broad output that quietly drifts from native schemas.

## External Signals Used in This Review

The recommendations above are grounded primarily in this repository. These current official
platform references were used only to check the direction of the rapidly changing plugin
surfaces:

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins) documents
  Codex plugin manifests, marketplace metadata, MCP wiring, hooks, assets, and local/repository
  distribution.
- [Anthropic: Plugins reference](https://code.claude.com/docs/en/plugins-reference) documents
  Claude Code component schemas, native validation and management commands, and additional
  plugin component types.
- [Cursor 2.5: Plugins](https://cursor.com/changelog/2-5) establishes Cursor's first-class
  plugin bundle and marketplace model for skills, subagents, MCP servers, hooks, and rules.

Because these formats evolve independently, their details should be captured in versioned
target profiles and fixtures rather than copied permanently into this planning document.
