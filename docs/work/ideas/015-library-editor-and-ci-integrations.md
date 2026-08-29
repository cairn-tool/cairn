# 015. Library, Editor, and CI Integrations

| Priority | Effort | Status      |
| -------- | ------ | ----------- |
| P3       | Large  | Not started |

**Payoff:** Reuse the engine without shell parsing.

Not implemented. This page records the original proposal, not current behavior.

First expose a documented ESM API from the existing package (or a later
`@bstockus/cairn-core` package) for workspace loading, queries, diagnostics, context
packing, and edit plans. This is a prerequisite for integrations that should not parse shell
output.

Useful consumers, in likely order, are:

1. A reusable GitHub Action that caches URL/index data, supports changed-document audits,
   uploads SARIF, and writes a concise job summary.
2. A watch mode for local documentation work, with incremental diagnostics.
3. A language server for broken-link/frontmatter diagnostics, heading completion, backlinks,
   and rename operations.

Keep these adapters in separate entry points so normal CLI startup does not pay for editor or
server dependencies.

---

[Back to the idea index](_contents.md)
