# 006. `agent package` and Marketplace Generation

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P1       | Large  | Shipped |

**Payoff:** Turn rendered artifacts into installable products.

Delivered by [`agent package`](../../commands/agent-package.md). The proposal below is the
original text; where the implementation diverged, the command's own documentation is
authoritative.

**Command sketch:**

```text
cairn agent package ./bundle --target all --output ./dist
cairn agent package ./bundle --target codex --marketplace repo --check
cairn agent package ./bundle --target claude-code --archive
```

Conversion produces a directory tree, but distribution also needs marketplace entries,
install-surface metadata, archive layout, integrity information, and publish-readiness checks.
Add packaging as a separate stage so `convert` remains a pure compiler.

An MVP should support local/repository marketplace catalogs for the selected targets and
validate:

- Display name, short/long descriptions, categories, starter prompts, publisher details,
  icons/screenshots, legal links, and component paths where supported.
- Manifest and marketplace version agreement.
- Required files, asset dimensions/types, archive contents, executable modes, and paths.
- Checksums plus a simple software-bill-of-materials inventory for scripts and bundled
  executables.
- Deterministic archives and a `--check` mode suitable for release CI.

Actual publication, authentication, or submission should remain outside the first version.
The command can produce a complete package and a checklist without taking an irreversible
external action.

---

[Back to the idea index](_contents.md)
