# Providers

Cairn touches five assistants, in three different roles.
This directory records what is currently known about each one: where it keeps its files, what
those files contain, which parts Cairn reads or writes, and the caveats that were expensive
enough to discover that they are worth writing down.

Every page here describes **observed behavior against a real corpus**, not a vendor
specification. None of these formats is published by its vendor as a stable contract, and
several are reverse-engineered. Where a fact was established by measurement — a field that is
cumulative, a count that double-reports, a guard that has to hold — the page says so and says
how it was established.

## The three roles

| Role                  | What Cairn does                                                                   | Where the data lives                                                               |
| --------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Conversion target** | Renders a portable agent bundle into that host's native plugin or project files   | `src/agent/targets/<id>.ts`, published by [`agent specs`](commands/agent/specs.md) |
| **Usage log source**  | Parses that host's session logs into the usage store and reports on them          | `src/usage/providers/<id>.ts`                                                      |
| **Archive source**    | Copies that host's plans, artifacts, transcripts, and logs into long-term storage | `src/archive/sets.ts`                                                              |

A provider is present in a role or it is not; there is no partial registration. When a role is
missing, the provider's page says why, because "unsupported" and "not yet attempted" are
different answers and only one of them is a bug. Antigravity is currently the only assistant in
all three.

| Provider                                         | Conversion target | Usage log source | Archive source |
| ------------------------------------------------ | ----------------- | ---------------- | -------------- |
| [Claude Code](providers/claude-code/overview.md) | yes               | yes              | yes            |
| [Codex](providers/codex/overview.md)             | yes               | yes              | yes            |
| [Cursor](providers/cursor/overview.md)           | yes               | no               | no             |
| [Antigravity](providers/antigravity/overview.md) | yes               | yes              | yes            |
| [Gemini CLI](providers/gemini-cli/overview.md)   | no                | yes              | yes            |

## Pages

Each provider directory holds the same four pages, so a fact is always in the same place:

- `overview.md` — what the host is, where it keeps things, and which roles it fills
- `agent-bundles.md` — the conversion target profile, or why there is none
- `usage-logs.md` — the transcript format and how it is counted, or why it is not read
- `archiving.md` — the artifact sets `archive run` collects, or why there are none

### Claude Code

- [Overview](providers/claude-code/overview.md)
- [Agent bundles](providers/claude-code/agent-bundles.md)
- [Usage logs](providers/claude-code/usage-logs.md)
- [Archiving](providers/claude-code/archiving.md)

### Codex

- [Overview](providers/codex/overview.md)
- [Agent bundles](providers/codex/agent-bundles.md)
- [Usage logs](providers/codex/usage-logs.md)
- [Archiving](providers/codex/archiving.md)

### Cursor

- [Overview](providers/cursor/overview.md)
- [Agent bundles](providers/cursor/agent-bundles.md)
- [Usage logs](providers/cursor/usage-logs.md)
- [Archiving](providers/cursor/archiving.md)

### Antigravity

- [Overview](providers/antigravity/overview.md)
- [Agent bundles](providers/antigravity/agent-bundles.md)
- [Usage logs](providers/antigravity/usage-logs.md)
- [Archiving](providers/antigravity/archiving.md)

### Gemini CLI

- [Overview](providers/gemini-cli/overview.md)
- [Agent bundles](providers/gemini-cli/agent-bundles.md)
- [Usage logs](providers/gemini-cli/usage-logs.md)
- [Archiving](providers/gemini-cli/archiving.md)

## Where a provider's behavior is declared

Nothing in this project branches on a provider's name. Each of the three roles reads a data
declaration, and the code that consumes it is written once:

| Role              | Declaration                                      | Consumer                  |
| ----------------- | ------------------------------------------------ | ------------------------- |
| Conversion target | `TargetProfile` in `src/agent/targets/`          | `src/agent/render.ts`     |
| Usage log source  | `ProviderCapabilities` in `src/usage/providers/` | `src/commands/usage.ts`   |
| Archive source    | `ArchiveProfile` in `src/archive/sets.ts`        | `src/commands/archive.ts` |

That rule is what makes these pages maintainable: a table here corresponds to a table in one
module, not to a condition scattered across a renderer. It is also enforced — the conformance
fixtures fail the build if the renderer emits a path the profile does not declare.

Adding a sixth assistant is therefore a new module plus a registry line in each role it fills,
and a directory here.

## Related documentation

- [File formats and schemas](formats.md) — the formats Cairn itself owns
- [Shared usage command behavior](commands/usage/common.md) — options, the store, and counting
- [Shared archive command behavior](commands/archive/common.md) — sets, segments, and verification
- [`agent specs`](commands/agent/specs.md) — the machine-readable form of every target profile
- [`usage providers`](commands/usage/providers.md) — the log sources present on this machine
