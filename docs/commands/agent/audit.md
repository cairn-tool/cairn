# `agent audit`

## Synopsis

```text
cairn agent audit <source> [options]
```

[`agent validate`](validate.md) answers "is this structurally valid?". `agent audit`
answers a different question: **what should a reviewer inspect before trusting or
distributing this bundle?** It reports the surface a bundle can act through — the commands
its hooks and MCP servers would run, the credentials and environment they are handed, how
broad its permission grants are, what executables and binaries it carries, and what changed
since the last release.

**This is explainable static analysis, not a sandbox or a malware detector.** Nothing is
executed and no network request is made. Exit `2` means "there are findings to review", never
"this bundle is malicious" — and a clean run means the listed checks found nothing, not that
the bundle is safe.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description  |
| -------- | -------- | ------------ |
| `source` | Yes      | Bundle root. |

## Options

| Option                | Default | Description                                                                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--target <target>`   | None    | Repeatable target: `claude-code`, `codex`, `cursor`, `antigravity`, `opencode`, or `all`. Enables the rendered checks. |
| `--profile <profile>` | `both`  | `plugin`, `project`, or `both`. Applies to the rendered checks.                                                        |
| `--baseline <file>`   | None    | Compare executables against a previous package `sbom.json`. Requires `--target`.                                       |
| `--strict`            | Off     | Also treat forwarded parse and render warnings as blocking.                                                            |
| `--format <fmt>`      | `llm`   | Output as `llm`, `human`, `json`, or `sarif`. Shorthands: `-fh`, `-fj`.                                                |
| `--envelope`          | Off     | Wrap `--format json` output in the versioned result envelope.                                                          |
| `-h`, `--help`        | —       | Show help.                                                                                                             |

## It audits the bundle, not a dist tree

`agent audit` takes a bundle root. With `--target` it renders in memory and audits the
rendered output too, the same way [`agent package`](package.md) does — a review can
never certify a tree that has drifted from its source.

It deliberately does **not** accept a generated plugin directory. Loading a bundle is what
enforces that no component path escapes the root and no symlink resolves outside it
(`agent validate` reports these as hard errors). A bare directory carries none of those
guarantees, and neither does it carry the manifest, MCP configuration, or policies most of
these checks read. To audit what CI built, audit the bundle it was built from.

## What is already checked elsewhere

Audit does not re-report conditions the parser and renderer already refuse, so one condition
keeps one diagnostic ID:

| Condition                                         | Reported by                       |
| ------------------------------------------------- | --------------------------------- |
| A component path escaping the bundle root         | `loadBundle`, as a hard error     |
| A symlink resolving outside its component root    | `loadBundle`, as a hard error     |
| Duplicate component names, duplicate output paths | `AB105`, `AB170`                  |
| A policy missing its example arrays               | `AB141`, `AB142`, `AB143`         |
| A non-portable hook event or protocol             | `AB320`, `AB322`                  |
| A missing referenced skill, resource, or script   | `AB150`, `AB151`, `AB152`         |
| Marketplace completeness                          | `agent package` (`AB500`–`AB503`) |

Three publish-readiness checks are shared with `agent package` rather than duplicated, and
keep their codes: `AB504` (executable outside `hooks/`, `scripts/`, `bin/`), `AB505`
(case-colliding paths), and `AB506` (unpinned MCP package). Audit runs them over the bundle
source; `agent package` runs them over the rendered payload.

## Checks

| Group              | Requires     | Findings                          |
| ------------------ | ------------ | --------------------------------- |
| Command content    | —            | `AB600`–`AB606`                   |
| Capability grants  | —            | `AB607`, `AB623`, `AB641`         |
| MCP posture        | —            | `AB506`, `AB610`–`AB614`          |
| Permission breadth | —            | `AB620`–`AB622`                   |
| File shape         | —            | `AB504`, `AB505`, `AB630`–`AB634` |
| Manifest claims    | —            | `AB640`                           |
| Rendered output    | `--target`   | `AB624`, `AB642`                  |
| Baseline drift     | `--baseline` | `AB650`–`AB654`                   |

`audit.checks` in the payload lists exactly which codes a run evaluated. Without it a
consumer cannot tell "clean" from "not checked", because the last two groups are opt-in.

Commands are read from the source document and from each `targets.<target>` override, not
from rendered artifacts. The renderer substitutes placeholders but does not change a
command's structure, so auditing both would report one command up to six times.

## `${BUNDLE_ROOT}` is the only path audit resolves

`AB604` is the sole `error` in the set, because a `${BUNDLE_ROOT}`-anchored reference to a
file that is not in the bundle is unambiguously broken. Only that portable spelling is
resolved: `${CLAUDE_PLUGIN_ROOT}` and the other native root variables name the _rendered_
tree, whose layout need not mirror the source, so resolving them against the bundle would
report files that are present under another name.

`AB602` treats every other `${VAR}` as host environment state. The known root variables come
from the target profiles (`agent specs --format json` publishes them), never a hardcoded
list, so a new target's spelling is understood without editing audit.

## `--baseline` compares the executable surface

`--baseline` takes the `sbom.json` [`agent package`](package.md) writes. Scope is
deliberately the executable set — baseline components typed `script` or `executable`, plus
anything currently carrying an execute bit, plus anything the baseline already tracked so a
file that _loses_ its execute bit is reported as the mode change it is rather than as a
removal. That is exactly the question ("what can run, and did it change?"), and it drops
`checksums.sha256`, `sbom.json`, `package-report.json`, and the marketplace catalogs for
free, so a differently-packaged run never reports them as removed.

Paths are compared by exact string equality with no normalization: the renderer emits
`<target>/<profile>/<path>` and `buildSbom` records that verbatim, so both sides are already
in one namespace. This is why `--baseline` requires `--target`.

A missing or unparseable file is an invocation error (exit `1`). A file that parses but is
not a `cairn-inventory` document is `AB654`, and every drift check is skipped — guessing
at another tool's schema would produce a report nobody can trust. A `subject` naming a
different version is recorded in the payload but is not a finding: comparing across releases
is the normal use.

## Diagnostics

| Code    | Severity | Meaning                                                                        |
| ------- | -------- | ------------------------------------------------------------------------------ |
| `AB504` | warning  | An executable file sits outside `hooks/`, `scripts/`, or `bin/`.               |
| `AB505` | error    | Two paths collide on a case-insensitive filesystem.                            |
| `AB506` | notice   | An MCP server invokes an unpinned package.                                     |
| `AB600` | warning  | A command runs an inline script through an interpreter.                        |
| `AB601` | warning  | A command uses shell interpolation, chaining, or redirection.                  |
| `AB602` | notice   | A command reads a variable from the host environment.                          |
| `AB603` | warning  | A command uses an absolute path.                                               |
| `AB604` | error    | A `${BUNDLE_ROOT}` reference names a file the bundle does not contain.         |
| `AB605` | notice   | A referenced script has a shebang but no execute bit.                          |
| `AB606` | warning  | A command downloads and executes code.                                         |
| `AB607` | notice   | A component is granted network tools.                                          |
| `AB610` | notice   | An MCP server is remote or uses a non-stdio transport.                         |
| `AB611` | warning  | An MCP server embeds a literal credential, or one that matches a known prefix. |
| `AB612` | notice   | An MCP server env value is a high-entropy literal.                             |
| `AB613` | warning  | An MCP server inherits broad environment state.                                |
| `AB614` | notice   | An MCP server runs a package fetched at launch.                                |
| `AB620` | warning  | An `allow` rule has no negative examples.                                      |
| `AB621` | warning  | An `allow` rule grants an interpreter, escalator, or wildcard.                 |
| `AB622` | warning  | An `allow` rule permits every subcommand of a bare command.                    |
| `AB623` | notice   | A component is granted shell access.                                           |
| `AB624` | warning  | A rendered or declared permission grants unrestricted shell.                   |
| `AB630` | notice   | A symlink inside the bundle; packaging stores a copy, not a link.              |
| `AB631` | warning  | A compiled executable is bundled.                                              |
| `AB632` | notice   | Unexpected binary content outside the assets root.                             |
| `AB633` | notice   | A file exceeds 1 MiB.                                                          |
| `AB634` | notice   | The bundle exceeds 10 MiB.                                                     |
| `AB640` | notice   | The manifest declares a component root that holds nothing.                     |
| `AB641` | warning  | A component declares a tool that is neither a capability nor a native name.    |
| `AB642` | notice   | A rendered manifest claims a path with no files under it.                      |
| `AB650` | warning  | Executable content changed since the baseline.                                 |
| `AB651` | warning  | An executable's mode changed since the baseline.                               |
| `AB652` | warning  | A new executable appeared since the baseline.                                  |
| `AB653` | notice   | An executable was removed since the baseline.                                  |
| `AB654` | warning  | `--baseline` is not an inventory document; drift checks were skipped.          |

## The exit rule is split by origin

Almost every review finding is a `warning` by design — "look at this", not "this is broken" —
so a rule that only blocked on errors would let a bundle embedding a literal credential exit
`0`, and audit would be useless as a CI gate. But audit also forwards the parse and render
diagnostics, and every Codex bundle carries approximate mapping warnings that say nothing
about trust.

So: **a warning audit itself found is blocking; a warning it forwarded is not**, unless
`--strict` says so. Notices never block. A freshly scaffolded [`agent init`](init.md)
bundle exits `0` for every component combination, including with `--target all`.

## Machine-readable output

`--format sarif` emits SARIF 2.1.0 with a real `level` per finding (`error`, `warning`,
`note`), a rule per diagnostic code, and the diagnostic's `quality`, `target`, `profile`,
`component`, and `remediation` under `properties`. No `region` is emitted: an agent
diagnostic identifies a file and a condition, never a line.

Unlike the `md` diagnostic commands, SARIF goes to **stdout**, matching the rest of the
`agent` contract. `jsonl` is deliberately not offered — its published `diagnostic-record`
schema is the `md` `Issue` shape, which an agent diagnostic does not fit.

> `.cairn.yml`'s `commands.audit` key configures **`md audit`**, not this command. Agent
> commands never read project configuration; `cairn describe agent audit` reports
> `formatConfigurable: false`.

## Examples

```bash
# What would this bundle run?
cairn agent audit ./bundle -fj | jq '.audit.commands'

# Full review, including the rendered output for every target.
cairn agent audit ./bundle --target all

# CI gate feeding a code-scanning upload.
cairn agent audit ./bundle --target all --format sarif > audit.sarif

# Errors only.
cairn agent audit ./bundle -fj | jq '.diagnostics[] | select(.severity == "error")'

# What changed since the last release?
cairn agent package ./bundle --target all --output ./dist
cairn agent audit ./bundle --target all --baseline ./previous/sbom.json
```

## Exit codes

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `0`  | No blocking review findings.                          |
| `1`  | Invocation, path, or I/O error.                       |
| `2`  | Review findings — inspect them, do not assume intent. |
