# `agent docs`

## Synopsis

```text
cairn agent docs <source> [options]
```

Emits the documentation artifact for an **inline** agent bundle — the one a repository installs
into itself. "Inline" is the `project` output profile: files merged into the repository's own
dot-directories, with no manifest of their own. The bundles a repository publishes for other
people are a different artifact; see [`agent collection-docs`](collection-docs.md).

The artifact describes everything a documentation site needs to render the bundle without reading
it: each skill, subagent and rule with its **full Markdown body**, the reference graph between
them, and the render matrix — which files land where on each host.

The payload conforms to the `inline-agent-bundle` schema, published as
`@cairn-tool/agent-bundle-schema` and printed by `cairn schema inline-agent-bundle`.

## Where the output goes

Two different things, deliberately:

- **stdout** is an agent result, like every other `agent` subcommand, carrying the payload under
  `docs`. This is what a caller pipes.
- **`--out <file>`** additionally writes the standalone artifact: the versioned result envelope
  with the bare payload as its `data`, and `schema` naming the document it conforms to. This is
  what a documentation pipeline publishes.

`agent convert` makes the same split when it writes `conversion-report.json` beside an unchanged
stdout.

## Options

| Option                | Default          | Description                                                                               |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `--target <target>`   | All targets      | Repeatable target: `claude-code`, `codex`, `cursor`, `antigravity`, `opencode`, or `all`. |
| `--profile <profile>` | `project`        | `plugin`, `project`, or `both`. The default is what "inline" means.                       |
| `--out <file>`        | —                | Also write the standalone documentation artifact here.                                    |
| `--id <id>`           | The bundle name  | The slug the artifact publishes under.                                                    |
| `--title <title>`     | Its display name | Human label for navigation.                                                               |
| `--strict`            | Off              | Treat warnings as findings.                                                               |
| `--format <fmt>`      | `llm`            | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.                            |
| `--envelope`          | Off              | Wrap `--format json` stdout in the versioned result envelope.                             |
| `-h`, `--help`        | —                | Show help.                                                                                |

## What the payload contains

| Field                   | Description                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `kind`, `schemaVersion` | `inline-agent-bundle`, and the semantic version of the payload format.                       |
| `id`, `title`           | How the artifact is addressed and labelled.                                                  |
| `generatedAt`           | RFC 3339, UTC. The only field that differs between two builds of the same bundle.            |
| `generator`             | The tool that produced it.                                                                   |
| `bundle.components`     | Skills, subagents and rules with their bodies; hooks, policies, MCP config and assets.       |
| `bundle.graph`          | Which components reference which skills, pruned to the components actually documented.       |
| `bundle.targets`        | The render matrix: per host and profile, the files that land there with their size and mode. |
| `bundle.diagnostics`    | Findings from parsing and rendering.                                                         |

Paths are bundle-relative and POSIX-separated, so the artifact is identical on every machine that
builds it. A component kind that no selected target emits into a selected profile is omitted rather
than shown empty — which is why an inline artifact has no `hooks`: hooks are plugin-profile only
on every target.

## Findings

Unlike the rest of the `agent` toolset, an **approximate mapping is not a finding here**.
Recording that a component reaches a host in a changed form is what this artifact is for, and
every Codex bundle carries one — the usual rule would make documenting a bundle an error. Only an
error severity, or a warning under `--strict`, exits 2.

## Examples

```bash
# Read the artifact without writing anything.
cairn agent docs ./plugins/cairn-markdown -fj | jq '.docs.bundle.components.skills[].name'

# Publish it.
cairn agent docs ./plugins/cairn-markdown --out docs/inline-bundle/artifact.json

# What does an installation actually look like on Cursor?
cairn agent docs ./plugins/cairn-markdown --target cursor -fj \
  | jq '.docs.bundle.targets[].artifacts[].path'

# Both forms of the same bundle, side by side.
cairn agent docs ./plugins/cairn-markdown --profile both -fj \
  | jq '.docs.bundle.targets | group_by(.profile) | map({profile: .[0].profile, hosts: length})'
```

## Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | Artifact emitted.                             |
| `1`  | Invocation error.                             |
| `2`  | Bundle errors, or a warning under `--strict`. |

## See also

- [`agent collection-docs`](collection-docs.md) — every bundle a repository publishes.
- [`agent inspect`](inspect.md) — the same bundle read for a caller rather than a reader.
- [`agent convert`](convert.md) — actually writing the tree this artifact describes.
