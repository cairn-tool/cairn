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
| `scripts`   | Same                                       |

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
      command: "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"
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

Validated in **every** file the renderer processes blocks in — every textual asset, not only
recognized components. An unknown target is `AB120`, an unbalanced block `AB121`, and a marker
that looks conditional but does not parse (`<!-- target: cursor -->`, with a space) is `AB123`
rather than being silently ignored.

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
