---
name: target-portability
description: Understand what each assistant host actually supports when a portable agent bundle is rendered — which component kinds map exactly, which are approximated, and which have no native surface at all. Use when deciding whether a skill, subagent, hook, rule, policy, or MCP server will work on more than one host, or when a feature must be dropped, approximated, or restricted to one target.
---

# What each host actually supports

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`${BUNDLE_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## Ask the tool; do not recall the matrix

Support is **data**, held in the target conformance profiles the renderer itself reads. Three
commands report it, and one of them is always a better answer than memory:

| Question                                      | Command                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| What does every host support, in general?     | `cairn agent compat`                                           |
| What would _this bundle_ cost on these hosts? | `cairn agent compat <bundle> --target codex --target cursor`   |
| What exactly does the profile declare?        | `cairn agent specs --target all --format json`                 |
| What actually reaches this target?            | `cairn agent inspect <bundle> --target codex --profile plugin` |

**This skill does not restate what those print.** It tells you which one to run and how to read
the answer. A recited matrix goes stale the moment a profile changes; `agent compat` cannot.

## The four fidelity levels

`agent compat` classifies every component kind per target. What each one means for a promise you
are about to make to a user:

| Level         | Means                                                                  | Say to the user                            |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `exact`       | The mapping is faithful.                                               | It works.                                  |
| `approximate` | It renders, and something is lost. The loss is _reported_, not silent. | It works, with a caveat — name the caveat. |
| `unsupported` | There is no native surface. Nothing is emitted.                        | It does not work here.                     |
| `native`      | Content you supplied verbatim for one host.                            | It works there and nowhere else.           |

`approximate` is the level that gets misread. It does not mean "probably fine" — it means the
renderer emitted the closest thing and told you what it gave up. Read the diagnostic before
deciding it is acceptable.

## The differences that are structural

These bite regardless of which host you are on, and are the ones worth knowing without looking
up:

| Fact                                                                           | Consequence                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| A slash command is a **skill** with `invocationPolicy: explicit`.              | There is no `commands` component kind to reach for.        |
| Rules render in the **project** profile only.                                  | A bundle whose rules matter must ship the project profile. |
| Hooks render in the **plugin** profile only.                                   | A project-only install silently has no hooks.              |
| Policies have no portable surface on several targets.                          | Never treat a policy as a security boundary.               |
| Subagents are project-only on one target, and TOML rather than Markdown there. | A plugin-profile subagent can be refused outright.         |
| Assets are copied verbatim everywhere.                                         | The one thing that never approximates.                     |

## Profiles decide as much as targets

Every question about support is really _(target, profile)_, not target. `--profile both` is the
default for that reason, and the two facts above — rules are project-only, hooks are
plugin-only — mean a bundle that ships one profile is a bundle that silently dropped something.

When in doubt, render both and look:

```bash
cairn agent convert <bundle> --target all --output ./dist --profile both
```

## Where each host's own answer lives

Per-target detail is published documentation, not something to reproduce here:

| Host        | Page                                          |
| ----------- | --------------------------------------------- |
| Claude Code | `docs/providers/claude-code/agent-bundles.md` |
| Codex       | `docs/providers/codex/agent-bundles.md`       |
| Cursor      | `docs/providers/cursor/agent-bundles.md`      |
| Antigravity | `docs/providers/antigravity/agent-bundles.md` |
| OpenCode    | `docs/providers/opencode/agent-bundles.md`    |

Each carries that host's feature-support table, its declared output patterns, and the
diagnostics it can raise, at <https://github.com/cairn-tool/cairn/tree/main/docs/providers>.

## When the bundle is fine and the tree is not

A bundle that renders cleanly can still have a _committed_ tree that no longer matches it,
because someone edited the output. That is drift, not a portability problem:
`cairn agent doctor <bundle> --output <dir>` locally, `cairn agent verify` in CI. If the hand
edits are worth keeping, fold them back into the bundle with `/agent-migrate`.

## More

A coarse component-by-target summary, for when you cannot reach the docs:
[`reference/support-matrix.md`](reference/support-matrix.md). What to _do_ about an
approximation is `portability-triage`.
