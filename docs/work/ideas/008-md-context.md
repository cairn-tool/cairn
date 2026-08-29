# 008. `md context`

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P1       | Medium | Shipped |

**Payoff:** Produce focused, reproducible context packs for agents.

Delivered by [`md context`](../../commands/md-context.md). The proposal below is the original
text; where the implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn md context docs/architecture.md --depth 2 --budget 24000
cairn md context --section "Release process" --entry README.md --format json
cairn md context --target src/cli.ts --include-backlinks
```

Turn the existing AST, graph, section extraction, backlinks, and workspace index into
reproducible context packs for coding agents. Starting from one or more files, headings, or
referenced assets, the command would traverse selected relationships and emit:

- Ordered Markdown content with source/line provenance.
- A JSON manifest explaining why each section was included.
- Broken or omitted dependencies and a deterministic budget/truncation report.
- Optional backlinks, child sections, frontmatter, and code-block contents.

The MVP should use deterministic graph distance and document order, not embeddings or an LLM.
Use a byte/character budget first, or a clearly labeled token estimate; exact model-specific
tokenization would compromise the provider-neutral design. A later pluggable ranker could be
added without changing the output contract.

This is probably the single Markdown feature with the most direct agent value: it converts
analysis into ready-to-use, auditable task context.

---

[Back to the idea index](_contents.md)
