# `agent verify`

## Synopsis

```text
cairn agent verify [options]
```

Checks that the agent-facing files committed in a repository — `.claude/skills/`,
`.claude/agents/`, `.mcp.json`, `AGENTS.md`, and the rest — are still what the bundles they
were generated from render, and that the toolchain doing the checking is the one the
repository pinned.

What to check is declared in a configuration document rather than in flags, so a CI pipeline
runs `cairn agent verify` with no arguments and the pins travel with the repository. Each
declared bundle is rendered in memory through the same planner [`agent install`](install.md)
uses, so a verification is always derived from the bundle and never from a tree that may
itself have drifted.

This is the CI-facing sibling of [`agent doctor --output`](doctor.md), which compares a
single `agent convert` output root given on the command line.

## Options

| Option            | Default    | Description                                                           |
| ----------------- | ---------- | --------------------------------------------------------------------- |
| `--config <file>` | Discovered | Configuration document declaring the `agent.verify` block.            |
| `--name <name>`   | All        | Verify only this entry. Repeatable. An unknown name is a usage error. |
| `--strict`        | Off        | Treat warnings as blocking findings.                                  |
| `--format <fmt>`  | `llm`      | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.        |
| `--envelope`      | Off        | Wrap `--format json` output in the versioned result envelope.         |
| `-h`, `--help`    | —          | Show help.                                                            |

Without `--config`, discovery walks from the working directory upward and stops at the
nearest `.cairn.yml` (or the legacy `.claude-cli.yml`) that declares an `agent.verify` block.
Unlike the [`scripts`](../scripts/run.md) chain walk, a farther ancestor never contributes:
entries describe one repository, and merging two lists would verify trees the nearer document
never mentioned.

## Configuration

The block is documented in full under
[project configuration](../../configuration.md#agent-verification).

```yaml
version: 1
agent:
  verify:
    pins:
      cli: { min: "2.0.0" }
      profileSchemaVersion: "2"
      targets:
        claude-code: { min: "2026-08-02" }
    defaults: { unmanaged: orphaned, scope: project }
    entries:
      - bundle: plugins/cairn-markdown
        target: claude-code
        profile: project
        destination: .
```

## Pins are asserted against the running build

A pin bounds **the cairn doing the verifying**, not a version string read out of the tree.
The argument is three steps:

1. the running CLI satisfies `pins.cli`;
2. its `PROFILE_SCHEMA_VERSION` and each target's `documentationRevision` satisfy their pins;
3. the committed tree is byte-identical to what this CLI renders.

Together those prove the tree was produced by a conforming cairn, **without requiring any
provenance document to exist**. That matters because an
[install manifest](../../formats/install-manifest.md) records a generator version but neither
a profile schema version nor a documentation revision — so provenance alone could never carry
the second pin.

Provenance found at a destination is therefore read as corroboration and reported under
`entries[].provenance`, never as the verdict. A generator version differing from the one
verifying is `AB425`, a notice.

A bound is `exact`, or `min` and `max` — never a range expression. `compareSemver` is
deliberately an ordering rather than a range grammar, and the target profiles record single
bounds for the same reason.

## What counts as drift

Three tiers, selected per entry by `unmanaged`. Only the third reads anything outside the
expected file set.

| Tier | `unmanaged` | Finds                                                             | Cost                   |
| ---- | ----------- | ----------------------------------------------------------------- | ---------------------- |
| 1    | always      | Expected files that are absent, or differ in bytes or mode.       | One read per artifact. |
| 2    | `orphaned`  | Files a prior install recorded that the bundle no longer renders. | No directory walk.     |
| 3    | `strict`    | Files hand-added inside generated territory.                      | A bounded walk.        |

`off` disables tiers 2 and 3. `orphaned` is the default, and is what CI usually wants: it
reads the recorded inventory rather than the filesystem, so a checkout full of
`node_modules` costs nothing.

### The walk is bounded by the target profile

Tier 3's territory is derived from the target's own declared output patterns, so it can never
claim a surface the renderer does not describe. Each pattern contributes its longest leading
run of wildcard-free segments, and only when that prefix is shorter than the whole pattern,
is non-empty, and the render actually placed a file under it.

| Declared pattern           | Territory        | Treatment                                 |
| -------------------------- | ---------------- | ----------------------------------------- |
| `.claude/skills/{name}/**` | `.claude/skills` | Walked.                                   |
| `.claude/agents/{name}.md` | `.claude/agents` | Walked.                                   |
| `.claude/settings.json`    | —                | Leaf file: compared, not walked.          |
| `.mcp.json`                | —                | Leaf file: compared, not walked.          |
| `assets/**`                | `assets`         | Walked only if the bundle renders assets. |

No shipped profile declares a pattern whose literal prefix is empty, so **the destination
root is never itself walked**. Pointing an entry at a repository root cannot enumerate the
repository: `node_modules/`, `src/`, `.git/` and every unrelated file are never opened. A
symlinked directory inside the territory is reported as an unmanaged entry and never followed.

### Leaf files are compared byte for byte

A wholly-literal declared path is a whole document the renderer serializes, so any hand edit
is drift. `AGENTS.md` is the one that catches people out: it is Codex's and OpenCode's rules
surface at project scope. **A repository that hand-maintains its own `AGENTS.md` must not
declare an entry whose target claims it.**

### The install manifest is bookkeeping

`.cairn-install.json` is never compared by bytes — it embeds the generator version, so doing
so would report every tree as drifted after any CLI upgrade — and never reported missing. A
repository may legitimately commit the generated tree while ignoring the manifest; the only
cost is orphan detection, reported once as `AB426`.

## Diagnostics

Four codes are re-emitted rather than duplicated, so one condition keeps one ID whichever
command surfaces it.

| Code    | Severity | Meaning                                                                |
| ------- | -------- | ---------------------------------------------------------------------- |
| `AB402` | error    | An expected file is missing, or differs from the bundle.               |
| `AB403` | warning  | A file inside generated territory is not accounted for.                |
| `AB404` | warning  | The tree predates the current target profile revision.                 |
| `AB420` | error    | The running CLI is outside the declared `pins.cli` range.              |
| `AB421` | error    | `PROFILE_SCHEMA_VERSION` does not match the pin.                       |
| `AB422` | error    | A target's documentation revision is outside its pin.                  |
| `AB423` | error    | An entry's destination does not exist, or is not a directory.          |
| `AB424` | error    | A recorded file is no longer rendered by the bundle.                   |
| `AB425` | notice   | The tree records a different generator version than the one verifying. |
| `AB426` | notice   | No install manifest, so orphaned files cannot be detected.             |
| `AB806` | error    | The destination's install manifest is malformed.                       |

## Examples

```bash
# What CI runs: the repository says what to check.
cairn agent verify

# This repository, which deliberately has no .cairn.yml.
cairn agent verify --config cairn-verify.yml

# One entry, while iterating on a single bundle.
cairn agent verify --name cairn-markdown

# Everything, including hand-added files inside generated directories.
cairn agent verify --strict -fj
```

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | Every declared entry matches, and every pin is satisfied.   |
| `1`  | Invocation, configuration, or I/O error.                    |
| `2`  | An error-severity finding, or any warning under `--strict`. |

Approximate render diagnostics alone do **not** fail verify, unlike
[`agent convert`](convert.md) and [`agent validate`](validate.md). Every Codex bundle carries
them by design, and they say nothing about whether the committed tree drifted.

## Related surfaces

- [`agent doctor`](doctor.md) checks a bundle and one `agent convert` output root given on the command line.
- [`agent install`](install.md) writes the trees this command verifies, and records the inventory it reads.
- [Install manifest](../../formats/install-manifest.md) is the document `orphaned` detection reads.
- [Project configuration](../../configuration.md#agent-verification) documents the `agent.verify` block.
- [Diagnostic codes](../../formats/diagnostic-codes.md) lists every code with its meaning.
