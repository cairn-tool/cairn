# `agent init`

## Synopsis

```text
cairn agent init <name> [options]
```

Scaffolds a new portable agent bundle at `schemaVersion: '2'`. The differentiator from each
platform's own scaffold is that this starts portable: one source tree that
[`agent convert`](agent-convert.md) renders for Claude Code, Codex, and Cursor.

The scaffold is deliberately minimal — a manifest and one skill by default, not a demo you
have to delete. It is also fully noninteractive: there are no prompts, and no option is
required beyond the name, so an agent can run it blind.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description                          |
| -------- | -------- | ------------------------------------ |
| `name`   | Yes      | Bundle name in lowercase kebab-case. |

## Options

| Option                      | Default               | Description                                                               |
| --------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `--output <dir>`            | `./<name>`            | Destination root.                                                         |
| `--description <text>`      | `<name> agent bundle` | Bundle description.                                                       |
| `--bundle-version <semver>` | `0.1.0`               | Initial bundle version. Not `--version`, which prints the CLI version.    |
| `--license <spdx>`          | `MIT`                 | Recorded in `marketplace.license`. No LICENSE file is written.            |
| `--component <kind>`        | `skill`               | Repeatable: `skill`, `agent`, `rule`, `hook`, `policy`, `mcp`, or `none`. |
| `--target <target>`         | all                   | Repeatable. Selects which overlay roots `--overlays` creates.             |
| `--profile <profile>`       | `both`                | Accepted for symmetry; a scaffold has no per-profile content.             |
| `--overlays`                | Off                   | Create a `native/<target>/` overlay root per selected target.             |
| `--force`                   | Off                   | Scaffold into a nonempty destination, replacing it.                       |
| `--dry-run`                 | Off                   | Report the plan without writing.                                          |
| `--check`                   | Off                   | Report whether the scaffold is already present and current.               |
| `--format <fmt>`            | `llm`                 | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.            |
| `--envelope`                | Off                   | Wrap `--format json` output in the versioned result envelope.             |
| `-h`, `--help`              | —                     | Show help.                                                                |

`--check` and `--dry-run` cannot be combined.

## Publish-readiness is not init's job

The scaffolded manifest carries a `marketplace:` block with an empty `publisher.name` and no
categories. That is **valid**: `agent validate` stays clean, and only
[`agent package`](agent-package.md) requires real values. Keeping the two questions separate is what lets `agent init` run without human input.

## The plan

Every operation is reported under `plan.operations`, so a caller never has to parse prose:

| Field    | Description                                                    |
| -------- | -------------------------------------------------------------- |
| `action` | `create`, `update`, or `skip`.                                 |
| `path`   | POSIX path relative to `plan.root`.                            |
| `kind`   | `manifest`, `skill`, `agent`, `rule`, `hook`, `policy`, `mcp`. |
| `bytes`  | Size of the planned content.                                   |
| `mode`   | Octal file mode; scaffolded hook scripts are `0755`.           |
| `reason` | Why an operation is a `skip`.                                  |

## Diagnostics

| Code    | Severity | Meaning                                                  |
| ------- | -------- | -------------------------------------------------------- |
| `AB200` | error    | The destination is nonempty and `--force` was not given. |

## Examples

```bash
# The smallest useful bundle.
cairn agent init release-helper

# Every component type, with overlay roots for two targets.
cairn agent init release-helper --output ./rh \
  --component skill --component agent --component hook \
  --overlays --target claude-code --target codex

# Machine-readable plan without touching the filesystem.
cairn agent init demo --output ./demo --dry-run -fj
```

## Exit codes

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | Bundle scaffolded, or dry run completed.                                          |
| `1`  | Invocation, path, or I/O error.                                                   |
| `2`  | `--check` found a missing or differing scaffold, or the destination was nonempty. |
