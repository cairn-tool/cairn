---
name: portability-triage
description: Decide what to do when a portable agent bundle will not render faithfully for a target — accept the approximation, exclude the component, use a conditional block, add a native overlay, or restructure to a portable surface. Use when agent convert, compat, doctor, or verify reports an approximate or unsupported mapping, or when a host-specific feature has no portable equivalent.
---

# When a bundle will not render faithfully

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`${PLUGIN_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## Read the diagnostic first

Every mapping loss has a code, and the code says which remedy applies. Get them machine-readable
rather than reading the prose:

```bash
cairn agent convert <bundle> --target all --output ./dist -fj
cairn agent compat  <bundle> --target all -fj
```

The `AB3xx` range is organized by feature: `AB302` placeholders, `AB310` skills, `AB32x` hooks,
`AB33x`/`AB340` subagents, `AB35x` rules, `AB36x` policies, `AB370` MCP. Full list in
[`reference/diagnostics.md`](reference/diagnostics.md).

**`--strict` is a decision, not a default.** It turns approximations into blocking findings,
which is right in CI for a bundle you publish and wrong for `agent audit`, where forwarded
render warnings say nothing about whether a bundle is safe to trust.

## Five remedies, best first

| #   | Remedy                              | Use when                                      | Cost                                                                      |
| --- | ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Accept it, and say so               | The loss is real but tolerable.               | You must name it in the description.                                      |
| 2   | Restructure to a portable surface   | A portable kind already covers it.            | Usually none. This is the one people miss.                                |
| 3   | `include:` / `exclude:` frontmatter | The component only makes sense on some hosts. | The feature is absent elsewhere, deliberately.                            |
| 4   | A conditional block                 | Only the _prose_ differs.                     | One file stays one file. Branches with `if`/`elif`/`else`.                |
| 5   | A `native/<target>/` overlay        | There is genuinely no portable surface.       | Verbatim copy: no placeholders, no conditionals, not conformance-checked. |

Reach down this list, not up. Most `AB310` and `AB302` findings are remedy 1; most "I need a
slash command" questions are remedy 2 — set `invocationPolicy: explicit` on a skill, because
there is no `commands` component kind. An overlay is a last resort precisely because anything
inside it stops being portable and stops being checked.

## Ship the project profile

Two failures look like "my content vanished" and are neither a bug nor an approximation:

- **Rules render project-profile only** on most targets (`AB350`).
- **Policies render project-profile only**, and only two targets have any surface at all
  (`AB360`, `AB361`).

Conversely **hooks render plugin-profile only**. A bundle carrying both rules and hooks needs
`--profile both`, which is the default — the failure comes from narrowing it.

## Do not mistake a policy for a boundary

`AB361` says the target has no native command-policy format. The remedy is _not_ to approximate
it with a prompt rule: prompt text is advice to a model, not enforcement. Either ship the
policy on the targets that have a real surface, or drop it.

## Drift is a different failure

A bundle that renders cleanly can still have a committed tree that no longer matches it. That
produces `AB402`, `AB403`, and `AB424` — not `AB3xx` — and none of the five remedies apply.

```bash
cairn agent doctor <bundle> --target <t> --profile <p> --output <dir>   # locally
cairn agent verify                                                       # in CI
```

If the hand edits in the tree are worth keeping, fold them back into the bundle with
`/agent-migrate` rather than re-applying them after every render.

## More

Every code, the remedy it points at, and the exact frontmatter and overlay syntax:
[`reference/diagnostics.md`](reference/diagnostics.md). What each host supports in the first
place is `target-portability`.
