# Markdown

Why the `md` toolset exists: a repository's Markdown is a graph — links, anchors, images,
snippets, tables of contents — and nothing in a normal toolchain checks that the graph is
intact. `md` reads and repairs it, deterministically, with no model involved.

Per-command flags are under [`commands/md/`](../commands.md); options every `md` command shares
are in [shared Markdown command behavior](../commands/md/common.md).

## Four groups of commands

| Group            | Answers                   | Commands                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validation**   | Is anything broken?       | [`lint`](../commands/md/lint.md), [`lint-dir`](../commands/md/lint-dir.md), [`check-urls`](../commands/md/check-urls.md), [`validate-frontmatter`](../commands/md/validate-frontmatter.md), [`check-snippets`](../commands/md/check-snippets.md), [`audit`](../commands/md/audit.md)                                                                                                                             |
| **References**   | What points at what?      | [`refs`](../commands/md/refs.md), [`refs-to`](../commands/md/refs-to.md), [`links`](../commands/md/links.md), [`orphans`](../commands/md/orphans.md), [`graph`](../commands/md/graph.md), [`query`](../commands/md/query.md), [`index`](../commands/md/index.md), [`context`](../commands/md/context.md), [`diff`](../commands/md/diff.md)                                                                       |
| **Analysis**     | What is in this document? | [`headers`](../commands/md/headers.md), [`outline`](../commands/md/outline.md), [`toc`](../commands/md/toc.md), [`stats`](../commands/md/stats.md), [`code-blocks`](../commands/md/code-blocks.md), [`structure`](../commands/md/structure.md), [`section`](../commands/md/section.md), [`frontmatter`](../commands/md/frontmatter.md), [`tasks`](../commands/md/tasks.md), [`tables`](../commands/md/tables.md) |
| **Modification** | Change it safely          | [`fix`](../commands/md/fix.md), [`rename-file`](../commands/md/rename-file.md), [`rename-heading`](../commands/md/rename-heading.md)                                                                                                                                                                                                                                                                             |

Only five commands write: `rename-heading`, `rename-file`, `toc --write`, `fix --write`, and
`check-snippets --write`. Everything else is read-only.

## The checks

- **markdownlint** - Markdown structural and formatting rules (opt-in via `--style`)
- **mermaid** - Mermaid diagram syntax validation
- **katex** - KaTeX math expression validation
- **references** - Link, anchor, and image reference validation
- **snippets** - Fenced code blocks compared against the source regions they declare

Heading anchors follow GitHub's slugging behavior, including Unicode and duplicate-heading
suffixes. Inline links and full, collapsed, and shortcut reference-style links and images
are all resolved.

The `--style` rule configuration lives in `.markdownlintrc` at the package root and ships
with the published package.

## Over MCP

[`serve mcp`](../commands/serve.md) exposes the read-only workspace engine to a host as eleven of
its tools, so an assistant can ask for a document's outline or a workspace query without shelling
out. The same server also carries six read-only [PDF tools](pdf.md#over-mcp). It is read-only by construction: no writing command is reachable, and
`tests/unit/serve-tools.test.ts` has a tripwire that keeps `scripts run` off that surface.

## Configuration

`md` commands discover `.cairn.yml` by walking upward from the working directory, and the
directory holding it becomes the workspace root. The full schema is in
[project configuration](../configuration.md).

## Related

- [Shared Markdown command behavior](../commands/md/common.md) — the options every `md` command takes.
- [Project configuration](../configuration.md) — the `.cairn.yml` schema.
- [Markdown conventions](../formats/markdown-conventions.md) — the TOC and snippet markers Cairn writes.
- [`serve`](../commands/serve.md) — the MCP surface.
