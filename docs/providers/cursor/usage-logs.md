# Cursor: usage logs

**There is no Cursor usage provider, and the omission is deliberate.**

`cairn usage --provider cursor` reports an unknown provider and exits `1`. `--provider all`
covers `claude-code`, `codex`, and `antigravity`, and does not silently skip a fourth.

## Why not

A usage provider is a parser for somebody else's undocumented format. The only way to write one
that is not a guess is to write it against a real corpus and verify each figure against
something independent — which is exactly what the other three providers did, and what produced
findings like Claude Code's response fan-out and Codex's cumulative token totals.

There is no such corpus for Cursor here. `~/.cursor` on a machine without Cursor holds only
third-party hook configuration: no transcripts, no token counters, nothing to write a parser
against and nothing to check one with.

Shipping a provider written from a format description alone would produce numbers with no
evidence behind them, in a tool whose entire value on this surface is that its numbers are
defensible. An absent provider is an honest answer; a plausible wrong one is not.

## What registering one would take

The shape is fixed and small — a `UsageProvider` module under `src/usage/providers/` plus a
line in its `index.ts`. Nothing in `src/commands/usage.ts` would change, because no report
branches on a provider name; what a provider can answer is read from its declared
`ProviderCapabilities`.

The work is not the interface. It is establishing, against real files:

- where the log root is, and how to tell "absent" from "empty"
- which record identifies a session, and whether that identifier is unique or repeated
- whether the token figure is per-request, cumulative, or a context size — and which
  distortion has to be undone, as each of the other three providers has a different one
- whether cache reads sit inside or beside the input figure
- whether a subagent is identifiable from the path or only from inside the file
- which of tools, skills, hooks, MCP, and slash commands leave a countable record, so
  `ProviderCapabilities` can say `no` where there is genuinely nothing rather than reporting a
  zero that reads as "you never did this"

## Consequences elsewhere

Because there is no usage provider, there is also **no archive profile** — `archive run`
resolves a provider's log root through the usage registry. See [Archiving](archiving.md).

Cursor's [conversion target](agent-bundles.md) is entirely unaffected: it is a fully supported
target, and the two roles share nothing but a name.

## Related

- [Shared usage command behavior](../../commands/usage/common.md)
- [`usage providers`](../../commands/usage/providers.md) — the sources present on this machine
- [Providers overview](../../providers.md)
