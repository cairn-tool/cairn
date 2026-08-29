# 010. Planned Markdown Fix Engine

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P2       | Large  | Shipped |

**Payoff:** Convert deterministic findings into safe edits.

Delivered by [`md fix`](../../commands/md-fix.md). The proposal below is the original text;
where the implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn md fix docs --check
cairn md fix docs --dry-run --rule toc --rule redirects
cairn md fix docs --write --rule relative-links
```

Several existing commands already know how to calculate safe edits. Extract their planning,
conflict detection, staging, and reporting into a shared edit engine, then expose only
deterministic fixers initially:

- Marker-scoped TOC synchronization.
- Canonical percent-encoding and relative-path normalization.
- Updating a URL to a confirmed permanent redirect when explicitly enabled.
- Markdownlint fixes only for rules with unambiguous transformations.

Default to `--check` or `--dry-run`; require `--write` to mutate. A plan should include byte
ranges, expected old text, replacement text, and the originating diagnostic. Abort the full
transaction if inputs changed, edits overlap, or any target is outside the workspace.

Do not auto-guess broken link destinations in the MVP. Candidate suggestions are useful, but
fuzzy repairs should require a selected candidate or a separate explicit flag.

---

[Back to the idea index](_contents.md)
