# `agent import`

## Synopsis

```text
cairn agent import <source> --output <dir> [options]
```

Turns an existing native plugin or project into a portable bundle — the inverse of
[`agent convert`](agent-convert.md), and the missing half of the native → neutral → native
loop. The output is a version-controlled source bundle that can then generate **all** targets,
not a one-off migration of one host's files.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description                    |
| -------- | -------- | ------------------------------ |
| `source` | Yes      | Native plugin or project root. |

## Options

| Option                 | Default               | Description                                                    |
| ---------------------- | --------------------- | -------------------------------------------------------------- |
| `--output <dir>`       | Required              | Bundle root to create. Must not be inside the source.          |
| `--from <spec>`        | `auto`                | `auto`, a target id, or `<target>-<profile>`.                  |
| `--scope <scope>`      | `auto`                | `auto`, `plugin`, or `project`.                                |
| `--merge <strategy>`   | `refuse`              | `refuse`, `skip-existing`, `overwrite`, or `native-only`.      |
| `--bundle-name <name>` | Source directory name | Name recorded in the generated manifest.                       |
| `--native-only`        | Off                   | Skip normalization; preserve everything as an overlay.         |
| `--strict`             | Off                   | Treat approximations as blocking findings.                     |
| `--dry-run`            | Off                   | Report the import without writing.                             |
| `--check`              | Off                   | Compare against an existing bundle without writing.            |
| `--format <fmt>`       | `llm`                 | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `--envelope`           | Off                   | Wrap `--format json` output in the versioned result envelope.  |
| `-h`, `--help`         | —                     | Show help.                                                     |

`--check` and `--dry-run` cannot be combined.

## Detection

`--from auto` scores the source against every layout the target conformance profiles declare —
three targets by two scopes. Because the scoring reads the same `outputs` patterns the renderer
emits, detection cannot drift from what `agent convert` produces.

- A plugin manifest at the profile's declared location settles the layout outright.
- Otherwise, patterns unique to exactly one `(target, profile)` cell decide. That set is derived
  from the profile matrix, so `.mcp.json` — declared by four different cells — never decides
  anything, while `.cursor/rules/{name}.mdc` or `.codex/agents/{name}.toml` decide immediately.
- Scoring counts distinct **features** matched, not files, so a plugin with forty skills does not
  outrank one with skills, hooks, rules, and MCP.

Detection never guesses silently: a tree that matches nothing, or two layouts that tie, is an
error naming the candidates so you can pass `--from`.

## What is portable and what is not

| Native input                                 | Portable output                                                                 | Fidelity                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Manifest name/version/description            | `agent-bundle.yaml`                                                             | exact                                                |
| Manifest listing metadata                    | `marketplace:`                                                                  | exact where present                                  |
| Manifest fields the profile does not declare | `native/<target>/manifest.json`                                                 | preserved                                            |
| Skills                                       | `skills/<name>/` — Cursor's `<bundle>-` namespacing undone                      | exact                                                |
| Markdown agents                              | `agents/<name>.agent.md`                                                        | exact                                                |
| Codex TOML agents                            | overlay                                                                         | approximate; not losslessly invertible               |
| `.mdc` rules                                 | `rules/<name>.md`, `alwaysApply`/`globs` → `activation`/`globs`                 | exact                                                |
| Aggregated `AGENTS.md`                       | one `rules/imported.md`                                                         | approximate; an aggregate cannot be split faithfully |
| Hooks                                        | `hooks/hooks.yaml`, native events mapped back via the profile's own alias table | exact for portable events                            |
| MCP                                          | `mcp/mcp.json`, or `targets.<target>.configToml` for Codex TOML                 | exact                                                |
| Assets                                       | `assets/`, bytes and modes preserved                                            | exact                                                |
| **Anything unclaimed**                       | `native/<target>/<profile>/…` verbatim                                          | preserved                                            |

Native **model ids and tool names are translated back** to semantic classes and portable
capabilities using the profile's own tables. Leaving them in place would produce a bundle that
only renders correctly for the target it came from — the opposite of what importing is for. A
tool name with no portable capability is kept under `targets.<target>.tools` rather than dropped.

### Placeholders are only reversed when that is safe

A bundle root that renders to a variable (`${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`) is reversed
to `${BUNDLE_ROOT}`. Cursor and Codex-project render it to a literal `.`, and rewriting every `.`
back would corrupt relative paths and every sentence-ending period in the document — so those are
deliberately left alone.

## The migration report

`import-report.json` is written at the bundle root and mirrored in `result.import`. Every input
file appears in `files` exactly **once**; anything an importer did not claim is recorded with
`layer: "dropped"` rather than vanishing.

| Field    | Description                                                                              |
| -------- | ---------------------------------------------------------------------------------------- |
| `from`   | Detected target, profile, what was requested, and the confidence.                        |
| `merge`  | The strategy in effect.                                                                  |
| `files`  | One provenance row per input file: `source`, `destination`, `layer`, `fidelity`, `note`. |
| `counts` | Totals per layer.                                                                        |

The report carries **no timestamp**, so importing an unchanged source twice produces a
byte-identical bundle. It does embed the generator version, so `--check` compares it by existence
only — the same rule `agent convert --check` applies to `conversion-report.json`.

## Merge strategies

A nonempty destination is refused by default, because "what happens to my existing `skills/`" has
three different reasonable answers and guessing is not one of them.

| Strategy        | Behavior                                                         |
| --------------- | ---------------------------------------------------------------- |
| `refuse`        | Error on a nonempty destination.                                 |
| `skip-existing` | Write only files that do not already exist.                      |
| `overwrite`     | Replace colliding files, reporting each as `AB237`.              |
| `native-only`   | Write only `native/<target>/**`; never touch the portable layer. |

## Diagnostics

| Code    | Severity | Meaning                                                                   |
| ------- | -------- | ------------------------------------------------------------------------- |
| `AB230` | warning  | The native manifest could not be parsed.                                  |
| `AB231` | notice   | Undeclared manifest fields were preserved as an overlay fragment.         |
| `AB232` | warning  | TOML agents are not losslessly portable; preserved as an overlay.         |
| `AB233` | warning  | Aggregated rules were imported as a single rule.                          |
| `AB234` | warning  | A structured file could not be parsed.                                    |
| `AB235` | warning  | A hook event has no portable equivalent.                                  |
| `AB236` | error    | The destination is nonempty and no merge strategy was named.              |
| `AB237` | warning  | An existing file was replaced under `--merge overwrite`.                  |
| `AB238` | warning  | A native model id maps to several classes; imported as `inherit`.         |
| `AB239` | warning  | Tool names with no portable capability were kept under a target override. |

Approximate mappings alone do **not** fail `agent import`, unlike `convert` and `validate`.
Approximation is the expected outcome of returning from a native format; only errors, and
warnings under `--strict`, fail. Pass `--strict` in CI when you want lossless imports only.

## Examples

```bash
# Detect the layout and import.
cairn agent import ./existing-plugin --output ./portable

# Pin the layout explicitly.
cairn agent import . --from cursor-project --output ./portable --dry-run

# Re-import only the native overlay after upstream added a platform-only feature.
cairn agent import ./existing-plugin --output ./portable --merge native-only

# What was lost?
cairn agent import ./existing-plugin --output ./portable -fj \
  | jq '.import.files[] | select(.fidelity != "exact")'
```

## Exit codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| `0`  | Imported, or dry run completed.             |
| `1`  | Invocation, path, or I/O error.             |
| `2`  | Blocking finding, or `--check` found drift. |
