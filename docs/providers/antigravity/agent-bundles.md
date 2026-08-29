# Antigravity: agent bundles

**Antigravity is not a conversion target.** `TARGETS` in `src/agent/types.ts` is
`claude-code`, `codex`, `cursor`, and there is no `src/agent/targets/antigravity.ts`.

Consequences, all of them uniform because every one of them reads the same `TARGETS` list:

- `agent convert --target antigravity` is rejected as an unknown target
- `agent specs` publishes three profiles, not four
- `agent compat` has three columns
- `native: { antigravity: … }` in a bundle manifest raises `AB184`, unknown overlay target
- `<!-- target:antigravity -->` in component Markdown raises `AB120`, unknown target block
- `include:`/`exclude:` and `targets.<platform>` frontmatter naming it raise `AB106` and `AB104`

## Why not

Registering a target is not a matter of picking directory names. A `TargetProfile` has to
declare, correctly, for each output profile: the manifest directory and its exact field set
including any **implied** fields the host derives itself, path roots for all six component
kinds, placeholder substitution semantics, the native name and document shape for each of the
four portable hook events, a model-class mapping, a tool-capability mapping, rule form and
which activations are exact versus approximate, the complete set of output path patterns, a
marketplace catalog spec, and install locations with any activation edit they need.

Every one of those is a claim that a rendered tree will actually load in the host. Getting one
wrong produces output that looks right and silently does nothing — the failure mode the
[implied manifest fields](../claude-code/agent-bundles.md#implied-manifest-fields) note
describes, where declaring `hooks` in a Claude Code plugin manifest drops the plugin's hooks
with no error from the host's own validator.

Those claims have not been established for Antigravity here. The profile is data, so adding one
later is a data edit rather than a redesign — but it is a data edit whose every row needs
evidence.

## What registering one would take

A `TargetProfile` module under `src/agent/targets/`, a line in its `index.ts`, and an entry in
`TARGETS`. The renderer needs no changes: it reads paths, hook events, model and tool maps,
rule activations, manifest fields, and output patterns from the profile rather than branching on
the target, and the conformance fixtures assert that every emitted path is one the profile
declares.

Beyond the profile itself:

- an overlay root `native/antigravity/`, which follows automatically from `TARGETS`
- a marketplace spec, or `marketplace: undefined` if the host has no catalog — `agent package`
  skips a target with no spec rather than inventing one
- an install spec, or `install: undefined` — both fields are optional so that adding them
  stayed additive
- conformance fixtures, which fail the build on any undeclared rendered path

Note that the two roles are independent. Antigravity's [usage](usage-logs.md) and
[archive](archiving.md) support are complete and unaffected by this; a provider being one thing
says nothing about whether it is the other.

## Related

- [Target profile format](../../formats/target-profile.md) — everything a profile must declare
- [`agent specs`](../../commands/agent/specs.md)
- [Providers overview](../../providers.md)
