# Render diagnostics and their remedies

Every `AB3xx`, what it is telling you, and which of the five remedies applies. Severity is not
listed because it is not fixed: it is derived from the mapping quality the target profile
declares, so the same code is a warning on a target that approximates a feature and a notice on
one that does not.

## Placeholders

| Code    | Condition                                                                                      | Remedy                          |
| ------- | ---------------------------------------------------------------------------------------------- | ------------------------------- |
| `AB302` | The target has no portable `the invocation arguments from the user's message` substitution; explanatory prose was emitted instead. | 1, or 4 if the wording matters. |

Only Claude Code substitutes arguments natively. Everywhere else the renderer writes prose
telling the model to take arguments from the user's message, rather than leaving a literal that
would never expand.

## Skills

| Code    | Condition                                                              | Remedy |
| ------- | ---------------------------------------------------------------------- | ------ |
| `AB310` | The target's skill invocation policy is advisory rather than enforced. | 1.     |

`invocationPolicy: explicit` becomes `disable-model-invocation: true` on Claude Code, an
`agents/openai.yaml` policy document on Codex, and advice everywhere else. The skill still
works; the host may still invoke it implicitly.

## Hooks

| Code    | Condition                                                | Remedy   |
| ------- | -------------------------------------------------------- | -------- |
| `AB320` | The hook event is not portable to this target.           | 3, or 5. |
| `AB321` | A Windows-specific hook command needs a target override. | 5.       |
| `AB322` | The hook protocol is not portable.                       | 5.       |

Hooks render in the **plugin** profile only. OpenCode emits none at all.

## Subagents

| Code    | Condition                                                         | Remedy                                      |
| ------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `AB330` | The model is not a stable semantic class, so the target inherits. | 1, or use a semantic class.                 |
| `AB331` | Tool capabilities cannot be restricted exactly.                   | 1, or 5 if the restriction is load-bearing. |
| `AB332` | Capability-based tool restrictions need a target override.        | 5.                                          |
| `AB340` | This target emits no subagents for the profile being rendered.    | 3, or ship the other profile.               |

Use `fast`, `balanced`, `capable`, or `inherit` for `model:` rather than a native model id: a
native id is unportable by construction, which is what `AB330` reports.

## Rules

| Code    | Condition                                         | Remedy                            |
| ------- | ------------------------------------------------- | --------------------------------- |
| `AB350` | This target's instruction rules are project-only. | Ship the project profile.         |
| `AB351` | The rule activation is not exact on this target.  | 1, or pick a portable activation. |

Activations are `always`, `files`, `model`, and `manual`. `always` is the most portable; the
others approximate on several hosts.

## Policies

| Code    | Condition                                              | Remedy                                     |
| ------- | ------------------------------------------------------ | ------------------------------------------ |
| `AB360` | Command policies are emitted only in project profiles. | Ship the project profile.                  |
| `AB361` | This target has no native command-policy format.       | 3 — restrict to the targets that have one. |

Do not answer `AB361` by writing the policy as a prompt rule. Prompt text is advice to a model,
not enforcement, and treating one as the other is how a policy becomes theatre.

## MCP

| Code    | Condition                                                                                            | Remedy                                           |
| ------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `AB370` | Codex project MCP requires TOML and cannot be translated losslessly from arbitrary structured input. | 1, or 5 for a hand-written `.codex/config.toml`. |

## Overlay codes

| Code    | Condition                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------- |
| `AB181` | The overlay collides with, or replaces, a portable artifact.                                          |
| `AB182` | An invalid overlay manifest fragment, no manifest to merge into, or an override of a generated field. |
| `AB183` | An overlay root or path escapes the bundle or the target root.                                        |
| `AB186` | An overlay entry is not an output-profile directory.                                                  |
| `AB187` | The overlay declares a profile this target does not support.                                          |

`AB181` is the one worth pausing on: an overlay silently replacing a portable artifact means two
sources for one path, and the portable one stops mattering for that target only.

## The syntax for each remedy

### 2 — restructure to a portable surface

A slash command is a skill:

```yaml
---
name: prepare-release
description: Prepare a release.
invocationPolicy: explicit
argumentHint: "[version]"
---
```

### 3 — emit for some targets only

```yaml
---
name: windows-helper
description: Windows-only helper.
include: [claude-code]
---
```

`exclude:` is the complement. Both take target ids, and an unknown one is `AB106`.

### 4 — prose that differs per target

```markdown
<!-- target:cursor -->

Cursor-specific instructions.

<!-- /target:cursor -->
```

A comma list is an OR, `not` negates the whole list, and a block may branch:

```markdown
<!-- if target:codex, cursor -->

Either host.
<!-- else -->

Everywhere else.
<!-- endif -->
```

Blocks are validated in **every** file the renderer processes them in — every textual asset,
not only Markdown. An unknown target is `AB120` and an unmatched, misnested, or unclosed block
is `AB121`. A marker that looks conditional but does not parse is `AB123`: `<!-- target: cursor -->`,
with a space after the colon, used to match nothing and so apply to no target at all, silently.

Markers inside a fenced code block or an inline code span are inert.

### 5 — a native overlay

```text
native/
  codex/
    project/
      .codex/config.toml
```

Declared in the manifest, which requires `schemaVersion: '2'`:

```yaml
native:
  codex: native/codex
```

The path under `native/<target>/` mirrors the output tree, so `project/.codex/config.toml`
lands at `.codex/config.toml`. Files here are copied verbatim: no placeholder rewriting, no
conditional-block processing, and `agent doctor` lists them under `doctor.overlays` rather than
checking them against the profile.

## Full reference

Every `AB###` in the project, with severity and emitter, is at
<https://github.com/cairn-tool/cairn/blob/main/docs/formats/diagnostic-codes.md>.
