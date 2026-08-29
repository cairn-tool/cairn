# 012. Source-Linked Snippet Checking

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P2       | Medium | Shipped |

**Payoff:** Detect documentation examples that drift from code.

Delivered by [`md check-snippets`](../../commands/md-check-snippets.md), with the same engine
also available as [`md fix --rule snippets`](../../commands/md-fix.md) and as a
[`md audit`](../../commands/md-audit.md) check. The proposal below is the original text; where
the implementation diverged, the command's own documentation is authoritative.

The metadata syntax chosen was a namespaced fence attribute,
`cairn:snippet=<path>[#<region>]`, read from the parsed fence rather than from the raw
document — which is what makes a fenced example demonstrating the syntax unreachable rather
than merely guarded. Line spans were deliberately not implemented; a named region or the whole
file are the only selectors.

**Command sketch:**

```text
cairn md check-snippets docs
cairn md check-snippets docs --write
```

Allow fenced code blocks to declare a source file and named region or line span. The checker
would compare the documented snippet with the source, report drift, and optionally refresh
only explicitly linked blocks.

This fits the current code-block extraction and audit model and solves a common documentation
failure without executing untrusted code. Prefer named regions or stable markers over raw line
ranges. Define one conservative metadata syntax, preserve fence attributes and indentation,
and never run the snippet as part of synchronization.

---

[Back to the idea index](_contents.md)
