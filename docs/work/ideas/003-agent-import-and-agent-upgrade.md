# 003. `agent import` and `agent upgrade`

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P1       | Large  | Shipped |

**Payoff:** Complete the native-to-neutral-to-native loop.

Delivered by [`agent import`](../../commands/agent-import.md) and [`agent
upgrade`](../../commands/agent-upgrade.md). The proposal below is the original text; where the
implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn agent import ./existing-plugin --from auto --output ./portable
cairn agent import . --from cursor-project --output ./portable --dry-run
cairn agent upgrade ./portable --to-schema 2 --check
```

`convert` accepts a neutral bundle and a legacy Claude plugin, but there is no general path
from existing native projects/plugins into maintainable neutral source. Add importers for the
same targets the tool renders. Import should:

- Detect the source platform and plugin versus project scope.
- Normalize portable components and preserve untranslatable pieces in native overlays.
- Emit a migration report with provenance for every source file and field.
- Be idempotent: importing the same unchanged source produces byte-identical output.
- Refuse to merge into a nonempty destination unless an explicit merge strategy is selected.

This differs from a host's user-environment migration feature: the output is a portable,
version-controlled source bundle that can subsequently generate all targets.

Keep schema evolution separate as `agent upgrade`. It should migrate a neutral bundle
between schema versions with `--check`, `--dry-run`, and explicit notes for changes that need
human judgment.

---

[Back to the idea index](_contents.md)
