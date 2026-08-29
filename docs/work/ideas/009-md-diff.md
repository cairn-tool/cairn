# 009. `md diff`

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P1       | Medium | Shipped |

**Payoff:** Make documentation changes reviewable by meaning.

Delivered by [`md diff`](../../commands/md-diff.md). The proposal below is the original text;
where the implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn md diff --since origin/main docs
cairn md diff old.md new.md --format json
```

Provide an AST-aware change summary instead of another textual diff. Report added, removed,
moved, and renamed headings; frontmatter changes; links whose resolved target changed; task
state changes; code-block language/content changes; and tables or diagrams added/removed.

For Git comparisons, reuse the existing `--changed-since` machinery and parse the base
revision without modifying the worktree. Match headings conservatively and label probable
renames as heuristic rather than fact. JSON should retain old/new line and slug information.

This is useful in pull-request review, release notes, documentation ownership workflows, and
agent handoffs. It also provides a foundation for smarter but still reviewable fix plans.

---

[Back to the idea index](_contents.md)
