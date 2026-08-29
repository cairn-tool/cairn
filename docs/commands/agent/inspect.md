# `agent inspect`

## Synopsis

```text
cairn agent inspect <source> [options]
```

Loads a bundle and displays its normalized representation, component references, target
overrides, and dependency graph. This is a read-only diagnostic command and does not render
target artifacts.

## Arguments

| Argument | Required | Description                    |
| -------- | -------- | ------------------------------ |
| `source` | Yes      | Root of the bundle to inspect. |

## Options

| Option                | Default | Description                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------- |
| `--target <target>`   | None    | Repeatable: `claude-code`, `codex`, `cursor`, `antigravity`, or `all`. |
| `--profile <profile>` | None    | `plugin`, `project`, or `both`. Requires `--target`.                   |
| `--format <fmt>`      | `llm`   | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.         |
| `-h`, `--help`        | —       | Show help.                                                             |

## Filtering

A large normalized bundle is hard to read whole. `--target` narrows it to the components that
actually reach the selected targets, and `--profile` drops the sections a profile never emits.

```bash
cairn agent inspect ./bundle --target codex
cairn agent inspect ./bundle --target claude-code --profile plugin
```

- **Components** (`skills`, `agents`, `rules`) are kept when they reach **any** selected target.
  The predicate is the renderer's own — the same one that honors `include`, `exclude`, and
  `targets.<name>.enabled` — so `inspect --target codex` and `convert --target codex` can never
  disagree about which components exist.
- **Sections** are kept when some selected target emits that feature into some selected profile,
  read from the target conformance profiles rather than branched on the target name. On
  `claude-code` that means `--profile plugin` drops `rules` and `policies`, and
  `--profile project` drops `hooks`. Run [`agent specs`](specs.md) to see the table.
- **`policies`, `assets`, and `hookFiles`** carry no per-target metadata, so a target filter
  cannot narrow them beyond the section check.
- The **graph** is pruned to the surviving components, rather than left pointing at names that
  are no longer in the document.

`--profile` requires `--target`: profile support is a property of a target, so a profile filter
with no target has no defined meaning, and refusing beats guessing.

Nothing is dropped silently. When a filter is given the payload gains a `filter` block naming
what it removed:

```jsonc
"filter": { "targets": ["codex"], "profiles": ["plugin", "project"],
            "excluded": { "skills": ["claude-only"], "agents": [], "rules": [] },
            "unsupported": [] }
```

`unsupported` lists the sections that were dropped because no selected target and profile emits
them at all. Without any filter flag the output is unchanged and `targets` stays empty, so
existing consumers are unaffected.

`--format json` is the form to depend on; the `llm` and `human` renderings print the same
document and are not a published contract.

## Exit codes

Exit `0` means inspection completed. Invalid bundles, missing paths, an unknown target or
profile, and I/O failures exit `1`; validation findings use exit `2` through the shared agent
command boundary.
