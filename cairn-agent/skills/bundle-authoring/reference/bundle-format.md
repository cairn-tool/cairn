# Bundle format and authoring commands in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats, exit codes, and config
discovery.

## Commands

| Command                            | Purpose                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `agent init <name>`                | Scaffold a bundle at `schemaVersion: "2"`                  |
| `agent add <kind> <name> [bundle]` | Add one component                                          |
| `agent validate <source>`          | Validate without generating artifacts (**no `--profile`**) |
| `agent inspect <source>`           | The normalized bundle, references, overrides, graph        |
| `agent compat [source]`            | Compatibility matrix, or one bundle against targets        |
| `agent convert <source>`           | Render target-native artifacts                             |
| `agent import <source>`            | Turn a native plugin or project into a bundle              |
| `agent upgrade <source>`           | Migrate between schema versions                            |
| `agent specs`                      | Print the versioned target conformance profiles            |

`agent add` kinds: `skill`, `agent`, `rule`, `hook`, `policy`, `mcp`, `overlay`.

Targets: `claude-code`, `codex`, `cursor`, `antigravity`, `opencode`, or `all`.
Profiles: `plugin`, `project`, or `both`.

## The manifest

```yaml
schemaVersion: "2"
name: release-helper
version: 1.0.0
description: Prepare and verify releases.

components:
  skills: skills
  agents: agents
  hooks: hooks/hooks.yaml
  mcp: mcp/mcp.yaml
  assets: assets

targets:
  codex:
    hooks: hooks/codex-hooks.yaml

marketplace:
  displayName: Release Helper
  categories: [ci, release]
  publisher: { name: Example, url: https://example.com }
  license: MIT
  icon: assets/icon.png

native:
  claude-code: native/claude-code
```

Required: `schemaVersion`, `name` (kebab-case), `version` (semver), `description`.

**Component paths must stay inside the bundle root**, including after resolving symlinks. A path
that escapes is refused rather than followed — which is why a shared file cannot be symlinked in
from a sibling bundle.

Schema `2` adds `marketplace:` and `native:` and nothing else; a v1 bundle renders
byte-identically under either. Using either block on a v1 bundle is an error.

## Component frontmatter

Shared by every kind:

| Field       | Meaning                                    |
| ----------- | ------------------------------------------ |
| `include`   | Target ids this component is emitted for   |
| `exclude`   | Target ids it is not                       |
| `targets`   | Per-target overrides                       |
| `resources` | Files the component needs; each must exist |
| `scripts`   | Same, but always component-local           |

A `resources` entry may also name a file outside the component — elsewhere in the
bundle, or under a `resourceRoots:` entry the manifest declares — and it is copied
into the component at render time, so one reference document can serve several
skills or several bundles:

```yaml
resources:
  - path: ../../../../shared/acceptance-criteria-standards.md
    as: reference/acceptance-criteria-standards.md
```

`as` defaults to the basename and may not escape the component. Uncovered escape is
`AB153`, a landing collision `AB154`, a bad root `AB155`.

Skills additionally:

| Field              | Values                       | Meaning                         |
| ------------------ | ---------------------------- | ------------------------------- |
| `invocationPolicy` | `auto` (default), `explicit` | Whether the model may invoke it |
| `argumentHint`     | string or array              | Autocomplete hint               |

Agents:

| Field       | Values                                   |
| ----------- | ---------------------------------------- |
| `model`     | `fast`, `balanced`, `capable`, `inherit` |
| `tools`     | `read`, `write`, `shell`, `web`          |
| `skills`    | Preloaded skill names; each must exist   |
| `reasoning` | Optional                                 |

On Claude Code the model classes map to `haiku`/`sonnet`/`opus`/`inherit` and the capabilities
expand to concrete tool names. Other targets record no capabilities and approximate.

Rules take an `activation` of `always` (default), `files` with `globs`, `model`, or `manual`.
`always` and `files` are exact on Claude Code and Cursor; Codex aggregates every rule into
`AGENTS.md`, so `files` is approximate there.

## Hooks

```yaml
hooks:
  post-tool-use:
    - type: command
      matcher: Write|Edit
      command: "${PLUGIN_ROOT}/hooks/guard.sh"
      timeout: 30
```

Portable events: `session-start`, `pre-tool-use`, `post-tool-use`, `stop`. An event no target can
express is an error unless a `targets.<platform>` override supplies one.

`matcher` is preserved on nested-shape targets and dropped on flat ones. `windowsCommand` needs a
target override. Protocols are `json` or `stdio-json`.

## Command policies

```yaml
rules:
  - pattern: "git push"
    action: prompt
    justification: Review pushes before they run.
    positiveExamples: ["git push --force-with-lease"]
    negativeExamples: ["echo not-a-match"]
```

Examples are checked against the pattern **at parse time**, so a policy that does not do what its
author thought fails before it is ever rendered. Omitting either list is reported but not fatal.

Approximate on Claude Code and Codex; **unsupported on Cursor**, which has no permission model.

## Conditional blocks

The legacy form carries one literal target; the `platform:` spelling is still accepted, and
the closer repeats the opener's keyword and name.

```markdown
<!-- target:cursor -->

Cursor-specific instructions.

<!-- /target:cursor -->
```

The conditional form carries OR, negation, and branching.

```markdown
<!-- if target:claude-code -->

!`git status --short`
<!-- elif target:codex, cursor -->

Run `git status --short` and read the output before continuing.
<!-- else -->

Check the working tree before continuing.
<!-- endif -->
```

A comma list is an OR; `not` negates the whole list; blocks nest and take exactly one branch.
Markers inside a fenced code block are inert, so an example like the ones above is safe to
write in a skill.

Validated in **every** textual file, not only recognized components. An unknown target is
`AB120`, an unbalanced block `AB121`, and a marker that looks conditional but does not parse
(`<!-- target: cursor -->`, with a space) is `AB123` rather than being silently ignored.

## Cross-component references

A component's identity differs per host — Cursor namespaces a plugin's skills and agents as
`<bundle>-<name>`, Claude Code addresses them as `<bundle>:<name>` — so never write a sibling's
name literally. Write a reference and let it resolve:

```markdown
The formats live in the `<!-- ref:skill:review-record -->` skill.
Spawn `<!-- ref:agent:diff-reviewer -->`, one per batch.
Run `<!-- ref:command:review -->` to start.
```

| Kind      | Names                           | For a bundle `cr`, on claude-code / cursor |
| --------- | ------------------------------- | ------------------------------------------ |
| `skill`   | a skill, to locate and read     | `cr:review` / `cr-review`                  |
| `agent`   | a subagent, to spawn            | `cr:diff-reviewer` / `cr-diff-reviewer`    |
| `command` | a skill, as a person invokes it | `/cr:review` / `cr-review`                 |

`command` names a skill — there is no `commands` component kind — and the skill must declare
`invocationPolicy: explicit`, or `AB161`. On Cursor a `skill` and a `command` reference resolve
to the **same string**, so put one or the other in a clause, never both.

Where they work:

- Bodies, Markdown resources, rules, textual assets, and the frontmatter `description` and
  `argumentHint`.
- Inside an inline code span — that is the point, and unlike a conditional marker a reference
  there is live.
- **Not** inside a fenced block, which is why the examples above are safe to write. A Mermaid
  diagram is a fenced block, so a node label cannot carry one.
- **Never** in `name:` (circular) or `skills:` (the portable list `AB150` validates — keep those
  bare). Anywhere else the renderer copies verbatim, such as a hook script, is `AB157`.

An unknown component is `AB156`; a comment that looks like a reference but does not parse is
`AB124`. A host with no such surface emits the bare name and reports `AB303`.

## Diagnostics

| Range   | Concerns                       |
| ------- | ------------------------------ |
| `AB0xx` | Invocation and legacy notices  |
| `AB1xx` | Manifest and component parsing |
| `AB18x` | Native overlays                |
| `AB2xx` | Scaffolding and upgrade        |
| `AB3xx` | Rendering, by feature          |
| `AB4xx` | Import and doctor              |
| `AB5xx` | Packaging                      |
| `AB6xx` | Audit                          |
| `AB7xx` | Contract tests                 |
| `AB8xx` | Install and uninstall          |
| `AB9xx` | Marketplace collection spec    |
