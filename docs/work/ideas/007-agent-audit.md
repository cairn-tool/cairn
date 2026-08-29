# 007. `agent audit`

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P1       | Medium | Shipped |

**Payoff:** Add security and supply-chain review before distribution.

Delivered by [`agent audit`](../../commands/agent-audit.md). The proposal below is the original
text; where the implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn agent audit ./bundle --target all
cairn agent audit ./dist/codex/plugin --format sarif
```

Validation answers "is this structurally valid?" Audit should answer "what should a reviewer
inspect before trusting or distributing this?" Static checks could flag:

- Hook commands, executable assets, shell interpolation, absolute paths, and network tools.
- MCP servers that embed secret-looking values, inherit broad environment state, use an
  unexpected transport, or invoke an unpinned package.
- Overbroad tool permissions and policy rules whose examples do not cover risky boundaries.
- Symlinks, duplicate/case-colliding paths, unexpected binary files, and oversized resources.
- Manifest claims that do not match actual components or declared capabilities.
- Changes in executable files or permissions relative to a previous package/report.

Use stable diagnostic IDs and SARIF. Exit `2` should mean review findings, not proof that a
bundle is malicious. Make the limitations explicit: this is explainable static analysis, not
a sandbox or malware detector.

---

[Back to the idea index](_contents.md)
