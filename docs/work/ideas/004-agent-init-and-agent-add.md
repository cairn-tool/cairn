# 004. `agent init` and `agent add`

| Priority | Effort       | Status  |
| -------- | ------------ | ------- |
| P1       | Small-medium | Shipped |

**Payoff:** Make portable bundles easy to start correctly.

Delivered by [`agent init`](../../commands/agent-init.md) and [`agent
add`](../../commands/agent-add.md). The proposal below is the original text; where the
implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn agent init release-helper --output ./release-helper
cairn agent add skill prepare-release ./release-helper
cairn agent add hook pre-tool-use ./release-helper
```

Provide a noninteractive scaffold for the neutral format. The differentiator from each
platform's native scaffold is that this starts with a portable bundle and target-aware
defaults. Useful options include selected component types, intended targets, plugin/project
profiles, license, and whether to include target overlays.

Generated examples should be minimal and valid, not a large demo that users must delete.
`agent add` should update the manifest safely and create one component at a time. Both
commands should support JSON plans, `--dry-run`, and `--check` so an agent can use them
without parsing prompts.

---

[Back to the idea index](_contents.md)
