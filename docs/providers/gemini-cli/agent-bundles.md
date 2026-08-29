# Gemini CLI: agent bundles

**Gemini CLI is not a conversion target.** `TARGETS` in `src/agent/types.ts` does not name it and
there is no `src/agent/targets/gemini-cli.ts`.

Consequences, all of them uniform because every one reads the same `TARGETS` list:

- `agent convert --target gemini-cli` is rejected as an unknown target
- `native: { "gemini-cli": … }` in a bundle manifest raises `AB184`, unknown overlay target
- `<!-- target:gemini-cli -->` in component Markdown raises `AB120`, unknown target block
- `include:`/`exclude:` and `targets.<platform>` frontmatter naming it raise `AB106` and `AB104`

## Why not

Not because it is unsupportable — this is the "not yet attempted" answer rather than the
"unsupported" one, and the two are different.

Gemini CLI has the surfaces a target profile needs. A real corpus shows project skills at
`<project>/.gemini/skills/<name>/`, and `~/.gemini/settings.json` carries a `hooks` block whose
events are `BeforeAgent`, `AfterAgent`, `BeforeTool` and `AfterTool` under a nesting one level
deeper than Antigravity's. **That last point is the trap**: Antigravity uses
`~/.gemini/config/hooks.json` with `PreToolUse`/`PostToolUse`/`PreInvocation`/`PostInvocation`/
`Stop`, in a different file, in a different shape. The two hosts share a home directory and
nothing else, and a profile written from the wrong one would render a tree that loads nothing.

What has not been established here is the rest: the manifest field set including any fields the
host derives itself, path roots for all six component kinds, placeholder substitution semantics,
the model-class and tool-capability mappings, rule form and which activations are exact, the
complete set of output path patterns, and install locations. Each is a claim that a rendered tree
will actually load, and getting one wrong produces output that looks right and silently does
nothing.

## What registering one would take

A `TargetProfile` module under `src/agent/targets/`, a line in its `index.ts`, and an entry in
`TARGETS` — plus the conformance fixtures, which fail the build on any emitted path the profile
does not declare. See [the target profile format](../../formats/target-profile.md) for the full
field list.

The two roles are independent. This provider's [usage](usage-logs.md) and
[archive](archiving.md) support are complete and unaffected.

## Related

- [Antigravity: agent bundles](../antigravity/agent-bundles.md) — the other host under `~/.gemini`
- [Providers overview](../../providers.md)
