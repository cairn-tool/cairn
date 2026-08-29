# 011. Composable Workspace Queries

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P2       | Medium | Shipped |

**Payoff:** Avoid a growing list of narrow query kinds.

Delivered by [`md query`](../../commands/md-query.md). The proposal below is the original text;
where the implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn md query documents --where frontmatter.status=published --where has:h1
cairn md query documents --where links-to:docs/api.md --select file,title,line
cairn md query tasks --where status=pending --group-by frontmatter.owner
```

The existing query kinds prove the value of the workspace index, but adding one enum value
per new question will eventually become limiting. Add a small typed predicate model for
documents, headings, links, tasks, code blocks, and frontmatter.

Start with repeatable, validated predicates and explicit `--select`/`--group-by` fields. Do
not begin with a general expression language or arbitrary JavaScript. The same query plan can
serve the CLI, MCP tools, and future editor integration, while existing kinds remain as stable
shortcuts.

---

[Back to the idea index](_contents.md)
