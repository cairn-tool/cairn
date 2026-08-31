# Diagnostic codes

Every `AB###` an `agent` command can emit, with its severity, what emits it, and what it means.
This page is a reference; [diagnostics](diagnostics.md) explains the two finding _shapes_ and
what a severity implies for an exit code.

**Markdown commands emit no codes.** An `Issue` carries no severity and no identifier — every
finding a `md` checker reports is of equal weight, and whether it blocks is decided by the
command's exit rule rather than per finding. There is nothing per-code to list for them; see
[diagnostics](diagnostics.md#issue).

## How to read this

- **Severity** decides whether a finding blocks. Broadly: `error` always blocks, `warning`
  blocks only under `--strict`, and `notice` never blocks. Each command page states its own
  rule, and several deliberately differ — [`agent audit`](../commands/agent/audit.md) blocks on
  its own warnings but not on forwarded ones, and [`agent doctor`](../commands/agent/doctor.md)
  and [`agent verify`](../commands/agent/verify.md) do not fail on an approximate mapping at all.
- **`varies`** means the severity is derived from the mapping quality the target profile
  declares, so the same code is a warning on a target that approximates a feature and a notice
  on one that does not. `agent specs --format json` publishes what each target declares.
- **A code that appears under more than one command is deliberate.** One condition keeps one
  identifier whichever command surfaces it, so a consumer's suppression list keeps working.
  `AB504`, `AB505`, and `AB506` are the packager's checks re-emitted by `agent audit`;
  `AB402`, `AB403`, `AB404`, and `AB806` are re-emitted by `agent verify`.

Codes are grouped by the ranges [diagnostics](diagnostics.md#code-ranges) records. A range with
gaps has them on purpose: a retired code is never reused, because a consumer may still be
suppressing it.

## Invocation

The failure form every `agent` command shares, and the one notice the parser emits about its input.

| Code    | Severity | Emitted by            | Meaning                                                                                |
| ------- | -------- | --------------------- | -------------------------------------------------------------------------------------- |
| `AB000` | error    | every `agent` command | An invocation, path, or filesystem error, reported as a payload under `--format json`. |
| `AB001` | notice   | bundle parser         | A legacy Claude Code plugin was accepted as bundle input.                              |

## Source validation

Emitted by the bundle and manifest parsers, so every command that loads a bundle can report them.

| Code    | Severity | Emitted by      | Meaning                                                                                                              |
| ------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AB100` | error    | bundle parser   | The bundle name is not lowercase kebab-case.                                                                         |
| `AB101` | error    | bundle parser   | A component name is not lowercase kebab-case.                                                                        |
| `AB102` | error    | bundle parser   | A skill or subagent has no `description`.                                                                            |
| `AB103` | error    | bundle parser   | A required manifest field is missing or empty.                                                                       |
| `AB104` | error    | bundle parser   | A component declares an override for an unknown target.                                                              |
| `AB105` | error    | bundle parser   | Two components of the same kind share a name.                                                                        |
| `AB106` | error    | bundle parser   | An `include` or `exclude` list names an unknown target.                                                              |
| `AB107` | error    | bundle parser   | A component's `name` is not a string.                                                                                |
| `AB108` | error    | bundle parser   | A component's `description` is not a string.                                                                         |
| `AB109` | error    | bundle parser   | A component's `targets` is not a mapping.                                                                            |
| `AB110` | error    | bundle parser   | A component's `include` or `exclude` is not a list.                                                                  |
| `AB111` | error    | bundle parser   | A manifest field that must be a string is not one.                                                                   |
| `AB112` | error    | manifest parser | The manifest declares an unsupported `schemaVersion`.                                                                |
| `AB113` | error    | bundle parser   | The bundle version is not a semantic version.                                                                        |
| `AB114` | error    | bundle parser   | The manifest's `targets` is not a mapping.                                                                           |
| `AB115` | error    | bundle parser   | The manifest declares an override for an unknown target.                                                             |
| `AB116` | error    | bundle parser   | Component frontmatter has no `name`.                                                                                 |
| `AB117` | error    | bundle parser   | A component's target override is not a mapping.                                                                      |
| `AB118` | error    | bundle parser   | A manifest target override is not a mapping.                                                                         |
| `AB119` | error    | manifest parser | The `marketplace` block is not a mapping.                                                                            |
| `AB120` | error    | bundle parser   | A conditional block names an unknown target.                                                                         |
| `AB121` | error    | bundle parser   | A conditional block is unmatched, misnested, or unclosed.                                                            |
| `AB122` | error    | manifest parser | A `marketplace` field has the wrong type.                                                                            |
| `AB123` | error    | bundle parser   | A conditional marker looks like one but does not parse.                                                              |
| `AB126` | notice   | manifest parser | A component path sits at the manifest's top level, which `schemaVersion: '2'` deprecates in favour of `components.`. |
| `AB127` | error    | manifest parser | A manifest field requires `schemaVersion: '2'`.                                                                      |
| `AB130` | error    | bundle parser   | A rule declares an unknown `activation`.                                                                             |
| `AB140` | error    | bundle parser   | A policy action is not `allow`, `prompt`, or `deny`.                                                                 |
| `AB141` | warning  | bundle parser   | A policy declares no positive and negative match examples.                                                           |
| `AB142` | error    | bundle parser   | A positive example does not match the policy's own pattern.                                                          |
| `AB143` | error    | bundle parser   | A negative example matches the policy's own pattern.                                                                 |
| `AB150` | error    | bundle parser   | A component references a skill the bundle does not define.                                                           |
| `AB151` | error    | bundle parser   | A referenced resource or script does not exist.                                                                      |
| `AB152` | error    | bundle parser   | A reference could not be resolved.                                                                                   |
| `AB160` | error    | bundle parser   | Components form a dependency cycle.                                                                                  |

## Native overlays

Overlay declaration and loading, plus the one renderer code that is not feature-scoped.

| Code    | Severity | Emitted by                      | Meaning                                                                                               |
| ------- | -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `AB170` | error    | renderer                        | Two components render to the same output path.                                                        |
| `AB180` | error    | manifest parser                 | The manifest's `native` block is not a mapping.                                                       |
| `AB181` | varies   | overlay loader; target profiles | A native overlay collides with, or replaces, a portable artifact.                                     |
| `AB182` | varies   | overlay loader; target profiles | An invalid overlay manifest fragment, no manifest to merge into, or an override of a generated field. |
| `AB183` | error    | overlay loader                  | An overlay root or path escapes the bundle or the target root.                                        |
| `AB184` | error    | manifest parser                 | The `native` block names an unknown target.                                                           |
| `AB185` | error    | manifest parser                 | An overlay declaration is neither a string path nor a mapping.                                        |
| `AB186` | error    | overlay loader                  | An overlay entry is not an output-profile directory.                                                  |
| `AB187` | warning  | overlay loader; target profiles | An overlay declares a profile the target does not support.                                            |

## Scaffolding

`agent init` and `agent add`.

| Code    | Severity | Emitted by                | Meaning                                                   |
| ------- | -------- | ------------------------- | --------------------------------------------------------- |
| `AB200` | error    | `agent init`, `agent add` | The destination is nonempty and `--force` was not given.  |
| `AB201` | error    | `agent init`, `agent add` | The component already exists and `--force` was not given. |
| `AB202` | error    | `agent init`, `agent add` | The hook name is not a portable event.                    |
| `AB203` | notice   | `agent init`, `agent add` | The manifest edit will normalize incidental whitespace.   |

## Schema migration

`agent upgrade`.

| Code    | Severity | Emitted by      | Meaning                                                                                  |
| ------- | -------- | --------------- | ---------------------------------------------------------------------------------------- |
| `AB220` | notice   | `agent upgrade` | The bundle is already at the requested schema; nothing was written.                      |
| `AB221` | notice   | `agent upgrade` | Marketplace metadata cannot be derived and needs human judgment.                         |
| `AB222` | error    | `agent upgrade` | The requested target schema is not supported.                                            |
| `AB223` | error    | `agent upgrade` | A legacy Claude plugin has no neutral manifest to upgrade.                               |
| `AB224` | error    | `agent upgrade` | The migration would change generated output. This is a `cairn` defect; please report it. |

## Import

Detection, normalization, and provenance.

| Code    | Severity | Emitted by     | Meaning                                                                   |
| ------- | -------- | -------------- | ------------------------------------------------------------------------- |
| `AB230` | warning  | `agent import` | The native manifest could not be parsed.                                  |
| `AB231` | notice   | `agent import` | Undeclared manifest fields were preserved as an overlay fragment.         |
| `AB232` | warning  | `agent import` | TOML agents are not losslessly portable; preserved as an overlay.         |
| `AB233` | warning  | `agent import` | Aggregated rules were imported as a single rule.                          |
| `AB234` | warning  | `agent import` | A structured file could not be parsed.                                    |
| `AB235` | warning  | `agent import` | A hook event has no portable equivalent.                                  |
| `AB236` | error    | `agent import` | The destination is nonempty and no merge strategy was named.              |
| `AB237` | warning  | `agent import` | An existing file was replaced under `--merge overwrite`.                  |
| `AB238` | warning  | `agent import` | A native model id maps to several classes; imported as `inherit`.         |
| `AB239` | warning  | `agent import` | Tool names with no portable capability were kept under a target override. |

## Rendering

Per-feature mapping losses. Severity depends on what the target profile declares, which is why these read as _varies_.

| Code    | Severity | Emitted by                | Meaning                                                                                      |
| ------- | -------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `AB302` | varies   | renderer; target profiles | The target has no portable `${ARGUMENTS}` substitution; explanatory text is emitted instead. |
| `AB310` | varies   | renderer; target profiles | The target's skill invocation policy is advisory rather than enforced.                       |
| `AB320` | varies   | renderer; target profiles | A hook event is not portable to the target.                                                  |
| `AB321` | varies   | renderer; target profiles | A Windows-specific hook command requires a target override.                                  |
| `AB322` | varies   | renderer; target profiles | A hook protocol is not portable.                                                             |
| `AB330` | varies   | renderer; target profiles | The model is not a stable semantic class, so the target inherits.                            |
| `AB331` | varies   | renderer; target profiles | Tool capabilities cannot be restricted exactly.                                              |
| `AB332` | varies   | renderer; target profiles | Capability-based tool restrictions require a target override.                                |
| `AB340` | varies   | renderer; target profiles | The target emits no custom agents for the profile being rendered.                            |
| `AB350` | varies   | renderer; target profiles | The target's instruction rules are project-only.                                             |
| `AB351` | varies   | renderer; target profiles | A rule activation is not exact on the target.                                                |
| `AB360` | varies   | renderer; target profiles | Command policies are emitted only in project profiles.                                       |
| `AB361` | varies   | renderer; target profiles | The target has no native command-policy format.                                              |
| `AB370` | varies   | renderer; target profiles | Codex project MCP requires TOML and cannot be translated losslessly.                         |

## Conformance and drift

`agent doctor` and `agent verify`.

| Code    | Severity | Emitted by                     | Meaning                                                                 |
| ------- | -------- | ------------------------------ | ----------------------------------------------------------------------- |
| `AB400` | error    | `agent doctor`                 | A target profile failed its own consistency check.                      |
| `AB401` | error    | `agent doctor`                 | A rendered path is not described by the target profile.                 |
| `AB402` | error    | `agent doctor`; `agent verify` | The generated tree is missing a file or differs from the bundle.        |
| `AB403` | warning  | `agent doctor`; `agent verify` | A file in the generated tree is not owned by any artifact.              |
| `AB404` | warning  | `agent doctor`                 | The generated tree predates the current target profile revision.        |
| `AB405` | notice   | `agent doctor`                 | No readable `conversion-report.json` at the output root.                |
| `AB410` | error    | `agent doctor`                 | The installed host is below the profile's recorded minimum.             |
| `AB411` | notice   | `agent doctor`                 | The installed host is within the profile's verified range.              |
| `AB412` | warning  | `agent doctor`                 | The installed host is newer than the profile's verified ceiling.        |
| `AB414` | notice   | `agent doctor`                 | No host version was supplied, or the profile records no range.          |
| `AB420` | error    | `agent verify`                 | The running CLI is outside the declared `pins.cli` range.               |
| `AB421` | error    | `agent verify`                 | `PROFILE_SCHEMA_VERSION` does not match the pin.                        |
| `AB422` | error    | `agent verify`                 | A target's documentation revision is outside its pin.                   |
| `AB423` | error    | `agent verify`                 | An entry's destination does not exist, or is not a directory.           |
| `AB424` | error    | `agent verify`                 | A recorded file is no longer rendered by the bundle.                    |
| `AB425` | notice   | `agent verify`                 | The tree records a different generator version than the one verifying.  |
| `AB426` | notice   | `agent verify`                 | No install of this bundle recorded here, so orphans cannot be detected. |

## Packaging

`agent package`.

| Code    | Severity | Emitted by                           | Meaning                                                             |
| ------- | -------- | ------------------------------------ | ------------------------------------------------------------------- |
| `AB500` | error    | `agent package`                      | A required catalog field is missing or empty.                       |
| `AB501` | error    | `agent package`                      | The catalog version disagrees with the bundle version.              |
| `AB502` | error    | `agent package`                      | A required marketplace asset is missing from the package.           |
| `AB503` | warning  | `agent package`                      | An asset has the wrong extension, is not an image, or is oversized. |
| `AB504` | warning  | `agent audit`; `agent package`       | An executable file sits outside `hooks/`, `scripts/`, or `bin/`.    |
| `AB505` | error    | `agent audit`; `agent package`       | Two paths collide on a case-insensitive filesystem.                 |
| `AB506` | notice   | `agent audit`; `agent package`       | An MCP server invokes an unpinned package.                          |
| `AB507` | warning  | `agent marketplace`; `agent package` | The target has no catalog for the selected marketplace mode.        |
| `AB508` | error    | `agent package`                      | The `--from-dist` tree is not what this bundle produces.            |
| `AB509` | error    | `agent marketplace`; `agent package` | A path does not fit a ustar header.                                 |

## Review

`agent audit`.

| Code    | Severity | Emitted by    | Meaning                                                                        |
| ------- | -------- | ------------- | ------------------------------------------------------------------------------ |
| `AB600` | warning  | `agent audit` | A command runs an inline script through an interpreter.                        |
| `AB601` | warning  | `agent audit` | A command uses shell interpolation, chaining, or redirection.                  |
| `AB602` | notice   | `agent audit` | A command reads a variable from the host environment.                          |
| `AB603` | warning  | `agent audit` | A command uses an absolute path.                                               |
| `AB604` | error    | `agent audit` | A `${BUNDLE_ROOT}` reference names a file the bundle does not contain.         |
| `AB605` | notice   | `agent audit` | A referenced script has a shebang but no execute bit.                          |
| `AB606` | warning  | `agent audit` | A command downloads and executes code.                                         |
| `AB607` | notice   | `agent audit` | A component is granted network tools.                                          |
| `AB610` | notice   | `agent audit` | An MCP server is remote or uses a non-stdio transport.                         |
| `AB611` | warning  | `agent audit` | An MCP server embeds a literal credential, or one that matches a known prefix. |
| `AB612` | notice   | `agent audit` | An MCP server env value is a high-entropy literal.                             |
| `AB613` | warning  | `agent audit` | An MCP server inherits broad environment state.                                |
| `AB614` | notice   | `agent audit` | An MCP server runs a package fetched at launch.                                |
| `AB620` | warning  | `agent audit` | An `allow` rule has no negative examples.                                      |
| `AB621` | warning  | `agent audit` | An `allow` rule grants an interpreter, escalator, or wildcard.                 |
| `AB622` | warning  | `agent audit` | An `allow` rule permits every subcommand of a bare command.                    |
| `AB623` | notice   | `agent audit` | A component is granted shell access.                                           |
| `AB624` | warning  | `agent audit` | A rendered or declared permission grants unrestricted shell.                   |
| `AB630` | notice   | `agent audit` | A symlink inside the bundle; packaging stores a copy, not a link.              |
| `AB631` | warning  | `agent audit` | A compiled executable is bundled.                                              |
| `AB632` | notice   | `agent audit` | Unexpected binary content outside the assets root.                             |
| `AB633` | notice   | `agent audit` | A file exceeds 1 MiB.                                                          |
| `AB634` | notice   | `agent audit` | The bundle exceeds 10 MiB.                                                     |
| `AB640` | notice   | `agent audit` | The manifest declares a component root that holds nothing.                     |
| `AB641` | warning  | `agent audit` | A component declares a tool that is neither a capability nor a native name.    |
| `AB642` | notice   | `agent audit` | A rendered manifest claims a path with no files under it.                      |
| `AB650` | warning  | `agent audit` | Executable content changed since the baseline.                                 |
| `AB651` | warning  | `agent audit` | An executable's mode changed since the baseline.                               |
| `AB652` | warning  | `agent audit` | A new executable appeared since the baseline.                                  |
| `AB653` | notice   | `agent audit` | An executable was removed since the baseline.                                  |
| `AB654` | warning  | `agent audit` | `--baseline` is not an inventory document; drift checks were skipped.          |

## Contract tests

`agent test`.

| Code    | Severity | Emitted by   | Meaning                                                      |
| ------- | -------- | ------------ | ------------------------------------------------------------ |
| `AB700` | error    | `agent test` | A test file or one of its cases is structurally invalid.     |
| `AB701` | warning  | `agent test` | No test cases were found.                                    |
| `AB710` | error    | `agent test` | No rendered path matched a `paths.present` pattern.          |
| `AB711` | error    | `agent test` | A rendered path matched a `paths.absent` pattern.            |
| `AB712` | error    | `agent test` | A rendered file failed a mode, text, or pattern expectation. |
| `AB713` | error    | `agent test` | A rendered JSON document did not contain the expected value. |
| `AB714` | error    | `agent test` | The diagnostic codes or severity ceiling were not met.       |
| `AB715` | error    | `agent test` | A golden digest did not match.                               |
| `AB720` | notice   | `agent test` | A case was skipped by a filter or an empty selection.        |

## Install

`agent install` and `agent uninstall`.

| Code    | Severity | Emitted by                                         | Meaning                                                                                         |
| ------- | -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AB800` | error    | `agent install`, `agent uninstall`                 | No recorded install location for this target and scope.                                         |
| `AB801` | error    | `agent install`, `agent uninstall`                 | Destination occupied by something that is not a prior install of this bundle.                   |
| `AB802` | notice   | `agent install`, `agent uninstall`; `agent verify` | Replacing an existing install of this bundle (reports the version delta).                       |
| `AB803` | warning  | `agent install`, `agent uninstall`                 | A bundle feature does not render in the installed profile (for example hooks at project scope). |
| `AB804` | error    | `agent install`, `agent uninstall`                 | A destination path escapes the resolved scope root.                                             |
| `AB805` | warning  | `agent install`, `agent uninstall`                 | Host activation edit required but `--register` was not given.                                   |
| `AB806` | error    | `agent install`, `agent uninstall`; `agent verify` | Install manifest missing or malformed, or nothing to uninstall.                                 |
| `AB807` | notice   | `agent install`, `agent uninstall`                 | `--link` in use; edits are live and the host may not follow symlinks.                           |
| `AB808` | error    | `agent install`, `agent marketplace`               | A path is claimed by two installs at one destination.                                           |
| `AB809` | error    | `agent install`, `agent marketplace`               | A `--link` install cannot share a destination with another install.                             |

## Collections

`agent marketplace`.

| Code    | Severity | Emitted by          | Meaning                                                       |
| ------- | -------- | ------------------- | ------------------------------------------------------------- |
| `AB900` | error    | `agent marketplace` | Unsupported spec `schemaVersion`.                             |
| `AB901` | error    | `agent marketplace` | A required spec field is missing or empty.                    |
| `AB902` | error    | `agent marketplace` | A spec field is malformed, or names an unknown target or key. |
| `AB903` | error    | `agent marketplace` | A bundle declares both `include` and `exclude`.               |
| `AB904` | error    | `agent marketplace` | A bundle path is missing, is not a directory, or escapes.     |
| `AB905` | error    | `agent marketplace` | Two bundles resolve to the same directory or the same name.   |
| `AB906` | warning  | `agent marketplace` | A selected target has no bundles left after include/exclude.  |
| `AB907` | notice   | `agent marketplace` | A bundle was skipped for a target by its own include/exclude. |

## Keeping this page honest

`tests/unit/diagnostic-codes.test.ts` extracts every `AB###` literal from `src/` and every code
from the tables above and asserts the two sets are equal. A code that ships undocumented fails
the build, and so does a documented code that no longer exists — the same discipline
`tests/e2e/contract.test.ts` applies to the command registry in both directions.

## Related surfaces

- [Diagnostics](diagnostics.md) — the two finding shapes, the code ranges, and the streaming formats.
- [Target profile](target-profile.md) — where a feature's declared diagnostics come from.
- [`agent specs`](../commands/agent/specs.md) — the machine-readable profiles, including each feature's diagnostics.
