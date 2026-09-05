---
name: agent-migrate
description: Convert a repository's inline provider-specific agent content into a portable cairn bundle, then regenerate the native trees from it.
disable-model-invocation: true
argument-hint: "[path] [--from <target>]"
---

# Migrate a repository to a portable bundle

A repository whose `.claude/`, `.codex/`, or `.cursor/` content was written by hand has that
content locked to one host. This converts it into a single portable bundle and regenerates the
native trees from it, so there is one source and the rest is output.

Work through the steps in order and **stop for confirmation at each gate**. Nothing is deleted
until the regenerated tree has been shown to match. Longer conventions:
[`${CLAUDE_PLUGIN_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## 1. Survey, and touch nothing

Find the agent content in `$ARGUMENTS` (or the current directory) and report a table of _path →
host → profile_. Do not run a writing command yet.
[`reference/discovery.md`](reference/discovery.md) maps every native path to the host and
profile that owns it.

Stop and confirm the inventory before continuing.

## 2. Settle the source layout

```bash
cairn agent import <path> --output <bundle> --dry-run -fj
```

Detection scores the tree against the same target profiles the renderer uses, so it cannot
disagree with what `agent convert` would produce. A tie or a no-match is an error naming the
candidates rather than a guess — pass `--from <target>` to settle it. The common one: a tree
holding only `.agents/skills/<name>/` is genuinely ambiguous between Antigravity and Codex,
because both declare that path.

## 3. Import

Re-run without `--dry-run`, then read `import-report.json`. Every input file gets a provenance
row, so report the counts by disposition: `portable`, `native`, `manifest`, `dropped`. A
`dropped` row is the one to investigate — it means nothing claimed the file.

## 4. Triage the overlays

Anything the importer could not translate is preserved under `native/<target>/`, not discarded.
For each file decide: promote it to a portable component, or keep it as a deliberate overlay?
An overlay is copied verbatim, with no placeholder rewriting and no conditional-block
processing, and `agent doctor` reports it separately rather than checking it — so keep one only
when the surface genuinely has no portable equivalent. The `portability-triage` skill decides
these case by case.

## 5. Fill in the manifest

Set `name`, `version`, `description`, and **`marketplace.publisher.name` now**. `agent import`
scaffolds the publisher empty and that **validates cleanly**, so a missing one does not surface
until `agent package` reports `AB500`, long after you would have moved on.

## 6. Make the content portable

Replace host-native substitutions with the canonical `$ARGUMENTS`, `${CLAUDE_PLUGIN_ROOT}`, and
`${CLAUDE_SKILL_DIR}`. Convert any hand-written slash command into a skill with
`invocationPolicy: explicit` — there is no `commands` component kind. Then:

```bash
cairn agent compat <bundle> --target all
```

`target-portability` explains how to read the result before promising a feature works
everywhere.

## 7. Regenerate, and diff against what is committed

```bash
cairn agent convert <bundle> --target all --output <dist> --profile both
cairn agent doctor  <bundle> --target <t> --profile <p> --output <dist>
```

Compare the regenerated tree against the **original committed content** and report every
difference. Expect some: rendering normalizes frontmatter key order and drops keys the parser
owns. Each difference is either an acceptable normalization or a bug in the bundle — say which,
for each.

**Do not delete anything until this step is clean.**

## 8. Choose the cutover shape, and wire drift detection

Either commit the generated tree, or build it in CI. Either way add `cairn agent verify` to the
pipeline, with the CLI and target-profile versions pinned, so the committed content cannot
silently diverge from the bundle again — which is the failure that made this migration
necessary. [`reference/cutover.md`](reference/cutover.md) has both shapes and the rollback path.

## 9. Verify, then remove the originals

Run `/agent-check` for the full validate → convert → doctor → test → audit sequence rather than
repeating it here. Then delete the hand-written originals **in a commit of their own**, separate
from the import, so the diff is reviewable and revertable.

## More

Discovery table: [`reference/discovery.md`](reference/discovery.md). Cutover and rollback:
[`reference/cutover.md`](reference/cutover.md). Authoring is `bundle-authoring`; per-host
support is `target-portability`; publishing is `bundle-publishing`.
