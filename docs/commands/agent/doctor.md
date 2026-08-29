# `agent doctor`

## Synopsis

```text
cairn agent doctor [source] [options]
```

Checks a bundle, and optionally an already-generated output tree, against the versioned
target conformance profiles. Its main purpose is detecting generated plugins that have
silently gone stale — because the tree was edited by hand, because the bundle moved on, or
because the target profile was revised.

The command is useful with no arguments at all: it still self-checks the profiles and
reports what is known about each target's host versions.

`agent doctor` never runs a host's own tooling. Results therefore depend only on the bundle
and the profiles, not on what happens to be installed. Each profile does publish the host's
version and validator commands through [`agent specs`](specs.md) so you can run them
yourself.

## Arguments

| Argument | Required | Description                                                                    |
| -------- | -------- | ------------------------------------------------------------------------------ |
| `source` | No       | Bundle root to check. Omit it for profile self-checks and host reporting only. |

## Options

| Option                  | Default                | Description                                                                                          |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `--target <target>`     | All applicable targets | Repeatable target: `claude-code`, `codex`, `cursor`, `antigravity`, or `all`.                        |
| `--profile <profile>`   | `both`                 | Output profile: `plugin`, `project`, or `both`.                                                      |
| `--output <dir>`        | —                      | Also compare an existing generated tree. Requires `source`.                                          |
| `--host-version <spec>` | —                      | Repeatable installed host version: `<target>@<version>`, or a bare version with one target selected. |
| `--strict`              | Off                    | Treat warnings as blocking findings.                                                                 |
| `--format <fmt>`        | `llm`                  | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.                                       |
| `-h`, `--help`          | —                      | Show help.                                                                                           |

## Checks

| #   | Check                 | Requires   | Findings                              |
| --- | --------------------- | ---------- | ------------------------------------- |
| 1   | Profile self-check    | —          | `AB400`                               |
| 2   | Host version          | —          | `AB410`, `AB411`, `AB412`, `AB414`    |
| 3   | Bundle and mappings   | `source`   | The usual `AB1xx`/`AB3xx` diagnostics |
| 4   | Declared output paths | `source`   | `AB401`                               |
| 5   | Generated tree        | `--output` | `AB402`, `AB403`, `AB404`, `AB405`    |

Check 4 is skipped for legacy Claude plugins, whose assets are written to the output root
and so cannot be bounded by target-relative patterns. It also skips paths contributed by a
[native overlay](convert.md#native-overlays): emitting a surface the portable profile
does not describe is exactly what an overlay is for, so those paths are listed under
`doctor.overlays` instead of being reported as `AB401` findings.

## Diagnostics

| Code    | Severity | Meaning                                                          |
| ------- | -------- | ---------------------------------------------------------------- |
| `AB400` | error    | A target profile failed its own consistency check.               |
| `AB401` | error    | A rendered path is not described by the target profile.          |
| `AB402` | error    | The generated tree is missing a file or differs from the bundle. |
| `AB403` | warning  | A file in the generated tree is not owned by any artifact.       |
| `AB404` | warning  | The generated tree predates the current target profile revision. |
| `AB405` | notice   | No readable `conversion-report.json` at the output root.         |
| `AB410` | error    | The installed host is below the profile's recorded minimum.      |
| `AB411` | notice   | The installed host is within the profile's verified range.       |
| `AB412` | warning  | The installed host is newer than the profile's verified ceiling. |
| `AB414` | notice   | No host version was supplied, or the profile records no range.   |

`AB400` and `AB401` indicate a defect in `cairn` itself rather than a problem with your
bundle; please report them.

## Host versions

Target profiles ship with no verified host range recorded, so a supplied `--host-version` is
reported back but not evaluated (`AB414`, exit `0`). Recording real bounds later is a data
change in the profile, not a change to this command. A malformed or ambiguous
`--host-version` is a usage error and exits `1` rather than producing a misleading finding.

## Examples

```bash
# What does this build of cairn know about each target?
cairn agent doctor --target all

# Has the generated tree drifted from the bundle?
cairn agent doctor ./bundle --target codex --output ./dist

# Fail CI on anything short of a clean, current tree.
cairn agent doctor ./bundle --target all --output ./dist --strict --format json
```

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | No blocking conformance findings.                           |
| `1`  | Invocation or I/O error.                                    |
| `2`  | An error-severity finding, or any warning under `--strict`. |

Unlike `agent convert` and `agent validate`, an approximate mapping alone does not fail
`agent doctor`: approximation is a property of the target, not a defect in the bundle. Use
`--strict` when you want warnings to block.
