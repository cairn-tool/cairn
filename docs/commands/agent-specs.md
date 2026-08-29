# `agent specs`

## Synopsis

```text
cairn agent specs [options]
```

Prints the versioned target conformance profiles — the data that drives conversion,
compatibility reporting, and [`agent doctor`](agent-doctor.md). These profiles are the source
of truth for target behavior: the renderer reads the same objects this command prints, so the
description cannot drift from what is actually generated.

Use `--format json` for the complete structure. The text output is an abridged digest.

## Options

| Option              | Default                | Description                                                    |
| ------------------- | ---------------------- | -------------------------------------------------------------- |
| `--target <target>` | All applicable targets | Repeatable target: `claude-code`, `codex`, `cursor`, or `all`. |
| `--format <fmt>`    | `llm`                  | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `-h`, `--help`      | —                      | Show help.                                                     |

## What a profile contains

| Field          | Description                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `host`         | Display name, documentation revision, recorded version bounds, and the version and validator commands you can run yourself. |
| `profiles`     | Which output profiles the target supports.                                                                                  |
| `manifest`     | Plugin manifest directory, file, and fields.                                                                                |
| `paths`        | Plugin and project roots per component type, and skill namespacing.                                                         |
| `placeholders` | Root variable substitution per profile and how `$ARGUMENTS` survives.                                                       |
| `hooks`        | Portable-to-native event names, envelope shape, and handler shape.                                                          |
| `models`       | Semantic model class to native model id.                                                                                    |
| `tools`        | Capability to native tool names, or `null` when not expressible.                                                            |
| `rules`        | Exact and approximate activations, and the native rule form.                                                                |
| `outputs`      | The declared native layout per profile, as path patterns.                                                                   |
| `features`     | Per-component mapping quality, supported profiles, native surface, and the diagnostic codes the target may emit.            |

`schemaVersion` versions the profile structure itself. It is hand-owned and unrelated to the
package version.

Version bounds ship unrecorded (`null`) until a target has been verified against a specific
host release. `agent doctor` reports this honestly rather than assuming a range.

## Examples

```bash
# The full machine-readable profiles.
cairn agent specs --format json

# What does Cursor support, and how well?
cairn agent specs --target cursor

# The declared native layout for Codex projects.
cairn agent specs --target codex -fj | jq '.specs.targets.codex.outputs.project'
```

## Exit codes

| Code | Meaning                     |
| ---- | --------------------------- |
| `0`  | Profiles written to stdout. |
| `1`  | Invocation error.           |
