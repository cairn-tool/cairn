# Diagnostic codes

Every code an `agent`, `jira`, or `pdf` command can emit, with its severity, what emits it, and
what it means. There are three families: `AB###` for agent bundles, `AD###` for ADF conversion,
and `AP###` for PDF reading. This page is a reference; [diagnostics](diagnostics.md) explains the
finding _shapes_ and what a severity implies for an exit code.

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

## ADF invocation and input

Emitted by `jira adf` while reading its input, before any conversion is attempted. All are
errors: there is no document to convert.

| Code    | Severity | Emitted by               | Meaning                                                        |
| ------- | -------- | ------------------------ | -------------------------------------------------------------- |
| `AD001` | error    | every `jira adf` command | An unexpected failure. The boundary-catch analogue of `AB000`. |
| `AD002` | error    | every `jira adf` command | The input is not an ADF document.                              |
| `AD003` | error    | every `jira adf` command | The input is larger than the two-megabyte cap.                 |
| `AD004` | error    | every `jira adf` command | The input nests deeper than 200 levels.                        |
| `AD005` | error    | every `jira adf` command | The input is not valid JSON, or contains a NUL byte.           |

`AD002` is the one worth knowing. Handing `jira adf to-markdown` a whole Jira issue response is
the likeliest first mistake, so when a document is nested somewhere inside the input, the
remediation names the field and prints the `jq` that extracts it. That message is why there is no
`--pointer` option: the tool converts a bare ADF document and knows nothing about the REST
response shape.

## ADF source validation

| Code    | Severity | Emitted by                                  | Meaning                                                   |
| ------- | -------- | ------------------------------------------- | --------------------------------------------------------- |
| `AD100` | warning  | `jira adf validate`, `jira adf to-markdown` | An unrecognized ADF node type. Not converted, not judged. |
| `AD101` | warning  | `jira adf validate`, `jira adf to-markdown` | An unrecognized ADF mark. Its formatting is dropped.      |
| `AD110` | error    | `jira adf validate`                         | A node appears somewhere the content model forbids.       |
| `AD111` | error    | `jira adf validate`                         | A node has less content than ADF requires.                |
| `AD112` | error    | `jira adf validate`                         | An attribute is missing or outside its permitted values.  |

`AD100` and `AD101` are warnings rather than errors on purpose: an unknown node means this tool
cannot tell, not that the document is wrong. `jira adf validate` blocks on them only under
`--strict`, and they are why it never claims to be Atlassian's validator — see
[`jira adf validate`](../commands/jira/adf/validate.md).

## ADF to Markdown

Every code here describes a lossy mapping, so none is ever an error: a valid ADF document always
converts. They block only under `--strict`.

| Code    | Severity | Emitted by             | Meaning                                                                           |
| ------- | -------- | ---------------------- | --------------------------------------------------------------------------------- |
| `AD200` | warning  | `jira adf to-markdown` | Table structure flattened: cell blocks became inline, or a span was dropped.      |
| `AD201` | warning  | `jira adf to-markdown` | A task list became a GFM task list; `localId` is not represented.                 |
| `AD202` | warning  | `jira adf to-markdown` | A panel became a block quote led by its type.                                     |
| `AD203` | warning  | `jira adf to-markdown` | An expand became a bold title followed by its body.                               |
| `AD204` | warning  | `jira adf to-markdown` | Media became an image or a link.                                                  |
| `AD205` | warning  | `jira adf to-markdown` | An attachment has no URL, so it became a link carrying its media id.              |
| `AD206` | warning  | `jira adf to-markdown` | A decision list became a plain list; decision state is not represented.           |
| `AD207` | warning  | `jira adf to-markdown` | A column layout collapsed into sequential blocks.                                 |
| `AD208` | warning  | `jira adf to-markdown` | A card became a link to its URL.                                                  |
| `AD209` | warning  | `jira adf to-markdown` | An inline construct became text or inline code — mention, emoji, status, or date. |
| `AD210` | warning  | `jira adf to-markdown` | An extension, macro, or placeholder has no Markdown form and was omitted.         |
| `AD211` | warning  | `jira adf to-markdown` | A mark has no Markdown equivalent and its formatting was dropped.                 |

## Markdown to ADF

ADF validates per-node content and Markdown permits nestings it forbids, so most of these report
a degradation rather than a loss. The rule they follow is flatten in place, never lift: promoting
a heading out of a list item would move it past the text that followed it, producing output that
is legal, plausible, and says something the input did not.

| Code    | Severity | Emitted by               | Meaning                                                                       |
| ------- | -------- | ------------------------ | ----------------------------------------------------------------------------- |
| `AD300` | warning  | `jira adf from-markdown` | A heading in a list item or block quote became a paragraph in bold, in place. |
| `AD301` | warning  | `jira adf from-markdown` | A block quote's contents were lifted into its parent in place.                |
| `AD302` | warning  | `jira adf from-markdown` | A table in a list item or block quote became one paragraph per row.           |
| `AD304` | warning  | `jira adf from-markdown` | Content was dropped, or block content was joined into inline content.         |
| `AD305` | warning  | `jira adf from-markdown` | A paragraph was split around an image, or an image became a link.             |
| `AD306` | warning  | `jira adf from-markdown` | Raw HTML was preserved verbatim in a code block, or inline as inline code.    |
| `AD308` | warning  | `jira adf from-markdown` | A footnote marker became superscript text and its body moved to the end.      |
| `AD309` | warning  | `jira adf from-markdown` | YAML frontmatter is metadata and was not converted into the document body.    |
| `AD310` | warning  | `jira adf from-markdown` | Table column alignment was dropped: an ADF cell has no alignment attribute.   |
| `AD311` | warning  | `jira adf from-markdown` | A list was split into runs, or a task list was downgraded to a bulleted list. |

`AD304` and `AD310` carry `quality: "unsupported"`; the rest are `approximate`. Both map to
`warning`, so the severity does not distinguish them — read `quality` for that. `AD305` is worth
reading twice: ADF images are block-level and `mediaInline` cannot carry an external URL, so an
inline Markdown image cannot stay inside its paragraph. Splitting preserves reading order
exactly, which is what separates it from lifting.

## PDF invocation and input

Emitted by the `pdf` input reader and by the single site that opens a document, so every `pdf`
command can report them.

| Code    | Severity | Emitted by                    | Meaning                                                                                   |
| ------- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `AP001` | error    | every `pdf` command           | An invocation, path, or filesystem error, reported as a payload under `--format json`.    |
| `AP002` | error    | `pdf` input reader            | No `%PDF-` signature in the first 1024 bytes. The message names the leading bytes as hex. |
| `AP003` | error    | `pdf` input reader            | The input is larger than `--max-bytes`.                                                   |
| `AP004` | error    | `pdf` input reader            | The input is missing, unopenable, or not a regular file.                                  |
| `AP005` | error    | document loader               | The `--timeout` wall-clock budget expired.                                                |
| `AP006` | error    | `pdf` input reader            | The input is zero bytes.                                                                  |
| `AP007` | notice   | `pdf` input reader            | `%PDF-` was found at a non-zero offset; the leading bytes were ignored, not stripped.     |
| `AP010` | error    | document loader               | The document is encrypted and needs a password. This toolset accepts none.                |
| `AP011` | error    | document loader               | A supplied password was rejected.                                                         |
| `AP012` | error    | document loader               | The page count exceeds `--max-pages`, refused before any page was opened.                 |
| `AP013` | error    | `pdf text`, `pdf to-markdown` | `--pages` is unparseable or names a page outside the document.                            |

`AP002` and `AP100` are deliberately distinct: `AP002` means the bytes never carried a header, decided
before the parser ran, and `AP100` means it looked like a PDF and could not be parsed. That is the
difference between the wrong file and a damaged one.

## PDF pages and text

| Code    | Severity | Emitted by                                | Meaning                                                                 |
| ------- | -------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `AP020` | error    | `pdf inspect`, `pdf validate`             | A page could not be fetched from the page tree, which includes a cycle. |
| `AP021` | error    | `pdf text`, `pdf validate`, `to-markdown` | A page's content stream could not be decoded.                           |
| `AP050` | warning  | `pdf inspect`, `pdf text`, `to-markdown`  | The page carries no text layer, so nothing could be extracted from it.  |

`AP050` is the finding that makes "does this document need OCR" answerable. It is a warning rather
than an error because a scanned page is a fact about the document rather than a defect in it; under
`--strict` it blocks, which is how a caller refuses a scan in CI.

## PDF outline

| Code    | Severity | Emitted by    | Meaning                                                                                |
| ------- | -------- | ------------- | -------------------------------------------------------------------------------------- |
| `AP080` | warning  | `pdf outline` | An outline destination does not resolve to a page. The entry is kept with a null page. |
| `AP081` | warning  | `pdf outline` | The outline nests past the depth cap and was truncated.                                |

## PDF structural integrity

Emitted by `pdf validate`. Several are visible only through the parser's own warnings, so a parser
upgrade that rewords a message degrades that check to `AP120` rather than to silence.

| Code    | Severity | Emitted by                    | Meaning                                                                                  |
| ------- | -------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `AP100` | error    | document loader               | The document could not be parsed even after cross-reference recovery.                    |
| `AP101` | warning  | `pdf validate`                | The cross-reference table was unusable and was rebuilt by scanning every object.         |
| `AP110` | warning  | `pdf validate`                | A font is not embedded or failed to load, and a substitute was used.                     |
| `AP111` | warning  | `pdf validate`                | A stream uses a filter the parser could not decode.                                      |
| `AP112` | warning  | `pdf validate`, `pdf inspect` | The Info dictionary or the XMP packet could not be read.                                 |
| `AP113` | notice   | every `pdf` command           | Encrypted, but opened with no password: the restrictions are advisory only.              |
| `AP114` | warning  | `pdf inspect`, `pdf validate` | `/MarkInfo <</Marked true>>` is declared but no page has a usable structure tree.        |
| `AP115` | notice   | `pdf inspect`, `pdf validate` | A structure tree is present on some pages and not others.                                |
| `AP120` | warning  | `pdf validate`                | The parser recovered from a condition this tool does not classify. Carries the raw text. |

`AP101` does not mean the document is unreadable — a rebuilt table still parses, which is why it is a
warning and `pdf validate` still exits 0 without `--strict`.

## PDF to Markdown

Emitted while converting. `AP200` is always present and names the path each page took.

| Code    | Severity | Emitted by        | Meaning                                                                                     |
| ------- | -------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `AP200` | notice   | `pdf to-markdown` | Which path produced the document: the structure tree, geometry, or a mix, with page counts. |
| `AP201` | warning  | `pdf to-markdown` | The column structure could not be resolved; the page was read top to bottom.                |
| `AP202` | warning  | `pdf to-markdown` | Tabular content was emitted as one paragraph per row rather than as a table.                |
| `AP203` | warning  | `pdf to-markdown` | Text at a non-right angle, or vertical text, was excluded from reading order.               |
| `AP205` | notice   | `pdf to-markdown` | Repeated running headers or footers were detected and dropped.                              |
| `AP206` | notice   | `pdf to-markdown` | A paragraph continuing across a page break was rejoined.                                    |
| `AP208` | notice   | `pdf to-markdown` | `--pages` narrowed the output; document-wide inference still used every page.               |
| `AP210` | notice   | `pdf to-markdown` | A multi-column layout was detected and read column by column.                               |
| `AP211` | warning  | `pdf to-markdown` | More than six distinct heading sizes; the smallest were collapsed to level 6.               |
| `AP213` | notice   | `pdf to-markdown` | An ordered list's original numbering is renumbered on output.                               |
| `AP214` | notice   | `pdf to-markdown` | Words split by a line-end hyphen were rejoined.                                             |
| `AP216` | warning  | `pdf to-markdown` | A figure's text was emitted; the image itself is not represented.                           |
| `AP219` | warning  | `pdf to-markdown` | A structure role this tool does not model; its text was emitted as a paragraph.             |
| `AP220` | warning  | `pdf to-markdown` | A table cell's block content was flattened into inline content.                             |
| `AP224` | warning  | `pdf to-markdown` | A generic `H` element's level was inferred from font size rather than declared.             |
| `AP225` | warning  | `pdf to-markdown` | A list's ordered-ness was inferred from its item labels.                                    |
| `AP230` | warning  | `pdf to-markdown` | Bold and italic are inferred from font names; other inline styling is not represented.      |
| `AP231` | notice   | `pdf to-markdown` | Typographic ligatures were expanded to their component letters.                             |
| `AP232` | notice   | `pdf to-markdown` | Control characters in the text layer were removed.                                          |

`AP200` is a notice rather than an approximation on purpose. Every untagged page is inferred
throughout, so treating "this page was untagged" as itself blocking would make `--strict` refuse
essentially every real PDF and therefore mean nothing. `--strict` blocks on the per-construct losses
above instead.

`AP219` is the `AD100` analogue and the non-negotiable one: an unrecognized structure role reports
and emits its text rather than disappearing. Dropping is the one degradation whose output is
indistinguishable from success.

`AP202` is why a GFM table is only ever built from a structure tree. A geometric reconstruction gets
merged cells, wrapped cell text, and rules drawn as vector paths wrong, and produces a confidently
wrong table a consumer cannot tell from a right one.

## PDF embedded files and forms

Emitted by `pdf attachments` and `pdf forms`. Both read content that is already inside the document;
neither ever rewrites it.

| Code    | Severity | Emitted by        | Meaning                                                                            |
| ------- | -------- | ----------------- | ---------------------------------------------------------------------------------- |
| `AP300` | warning  | `pdf attachments` | An embedded file's stream could not be decoded; it is listed without size or hash. |
| `AP301` | warning  | `pdf attachments` | A stored file name carried a path and was sanitized before being written.          |
| `AP302` | notice   | `pdf attachments` | The name was already taken; the file was written under a resolved name.            |
| `AP303` | error    | `pdf attachments` | A destination escaped `--extract`, or the name was unusable; nothing was written.  |
| `AP304` | warning  | `pdf attachments` | The decode budget was reached; later entries are listed without size or hash.      |
| `AP311` | warning  | `pdf forms`       | An XFA form: field values live in an XML packet that is not read.                  |
| `AP312` | notice   | `pdf forms`       | A field resolves to no page in this document; its `page` is null.                  |

`AP301` reports rather than blocks, and blocks only under `--strict`. A document carrying an unusual
file name is not a failed extraction: the traversal was contained and the file was written safely.
`--strict` is what turns it into a CI signal.

`AP303` is an error and stops the whole extraction, not just its own file. An embedded file's stored
name is attacker-controlled, so extraction is planned in full before anything is written — one
refused destination means no file is written at all, rather than a partially populated directory
whose contents depend on iteration order.

`AP302` exists because the alternative is silent data loss. Two embedded files can sanitize to one
name, and a name can collide with a file that was already in the target directory; overwriting
either would destroy something the user did not ask to lose.

`AP311` is the `AP219` analogue for forms. An XFA document has no AcroForm field objects at all, so
reporting an empty field list without saying why would be indistinguishable from a document that
carries no form. There is deliberately no code for "declares a form with no fields": the parser
reports that identically to "no form", so a separate code would be a claim this cannot support.

## Keeping this page honest

`tests/unit/diagnostic-codes.test.ts` extracts every `AB###`, `AD###`, and `AP###` literal from `src/` and
every code from the tables above and asserts the two sets are equal. A code that ships undocumented fails
the build, and so does a documented code that no longer exists — the same discipline
`tests/e2e/contract.test.ts` applies to the command registry in both directions.

## Related surfaces

- [Diagnostics](diagnostics.md) — the three finding shapes, the code ranges, and the streaming formats.
- [Target profile](target-profile.md) — where a feature's declared diagnostics come from.
- [`agent specs`](../commands/agent/specs.md) — the machine-readable profiles, including each feature's diagnostics.
