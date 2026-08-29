# Agent bundle format

The portable source format `agent convert` compiles. One bundle renders into Claude Code,
Codex, and Cursor artifacts without being written three times.

A bundle is a directory containing `agent-bundle.yaml` and component directories. Everything
in it is plain files: YAML, Markdown with frontmatter, JSON, and whatever assets the components
need.

## Schema versions

`schemaVersion` is a **hand-owned** version of the source format authors write. It is unrelated
to the package version, to `CONTRACT_VERSION`, and to `PROFILE_SCHEMA_VERSION`.

| Value | Meaning                                                           |
| ----- | ----------------------------------------------------------------- |
| `1`   | The base format.                                                  |
| `1.0` | Accepted as an alias of `1`.                                      |
| `2`   | Current. Adds `marketplace:` and `native:`; changes nothing else. |

Schema 2 is a **strict superset** of schema 1. A v1 bundle renders byte-identically under
either version, which is what lets `agent upgrade` verify the rendering before and after a
migration and refuse (`AB224`) if that ever stops holding.

`agent init` scaffolds schema 2. An unsupported value raises `AB112`.

A directory holding `.claude-plugin/plugin.json` but **no** `agent-bundle.yaml` is read as a
**legacy** Claude Code plugin — `layer: 0` — which is how `agent convert` migrates one
in place. It emits notice `AB001`.

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
  rules: rules
  policies: policies
  mcp: mcp/mcp.yaml
  assets: assets
```

### Required fields

`schemaVersion`, `name`, `version`, and `description`. A missing or empty one raises `AB103`.

| Field         | Rules                                                                |
| ------------- | -------------------------------------------------------------------- |
| `name`        | lowercase kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$` — otherwise `AB100` |
| `version`     | semantic version, `1.0.0` or `1.0.0-beta.1` — otherwise `AB113`      |
| `description` | a string — otherwise `AB111`                                         |

### Component paths

Seven component kinds, each with a default location:

| Key        | Default    | Contains                                  |
| ---------- | ---------- | ----------------------------------------- |
| `skills`   | `skills`   | `<name>/SKILL.md` directories             |
| `agents`   | `agents`   | `*.agent.md` (or `*.md`)                  |
| `rules`    | `rules`    | `*.md` with an `activation`               |
| `hooks`    | `hooks`    | a hooks document plus any handler scripts |
| `policies` | `policies` | YAML or JSON policy documents             |
| `mcp`      | `mcp`      | an MCP server document                    |
| `assets`   | `assets`   | anything, copied verbatim                 |

Replace any default with a string path or `{ path: … }`, either at the top level or under
`components:`. On schema 2 a top-level component path still works but is deprecated and reports
`AB126`; `components:` is the current spelling.

**Paths must stay inside the bundle root**, including after resolving symlinks. A path that
escapes, or a symlink whose target escapes, is refused rather than followed.

### Target overrides

```yaml
targets:
  codex:
    hooks: hooks/codex-hooks.yaml
```

`targets` must be an object (`AB114`), each key must be a known target (`AB115`), and each
value must be an object (`AB118`).

### Listing metadata — schema 2 only

`marketplace:` is read by [`agent package`](../commands/agent/package.md) and **ignored by
`agent convert`**. Its structure is validated by the parser; whether it is _complete enough to
publish_ is the packager's question, so a bundle with a half-filled block still validates and
converts.

```yaml
marketplace:
  displayName: Release Helper
  summary: One line.
  description: Longer prose.
  categories: [ci, release]
  keywords: [release, changelog]
  publisher:
    name: Example
    url: https://example.com
    email: maintainers@example.com
  homepage: https://example.com/release-helper
  repository: https://github.com/example/release-helper
  license: MIT
  icon: assets/icon.png
  screenshots: [assets/shot.png]
  starterPrompts:
    - title: Cut a release
      prompt: Prepare the next release.
  legal:
    privacyPolicy: https://example.com/privacy
    termsOfService: https://example.com/terms
```

`publisher.name` may be empty: `agent init` scaffolds `name: ""` because it cannot know the
publisher, and a bundle must validate before it is ready to publish. A structural violation
raises `AB119` or `AB122`.

Each target reshapes this block differently into its own catalog — see the marketplace section
of each [provider's agent-bundle page](../providers.md).

### Native overlays — schema 2 only

```yaml
native:
  claude-code: native/claude-code
  codex: { root: overlays/codex }
```

Both the string shorthand and the object form are accepted; the shorthand is what `agent init`
writes. Every target gets a declaration whether or not `native:` names it, defaulting to
`native/<target>`.

An unknown target key raises `AB184`; a malformed value raises `AB185`.

Using `marketplace:` or `native:` on a schema 1 bundle raises `AB127`, because reading them
there would silently change that bundle's output.

## Skills

Open `skills/<name>/SKILL.md` layout. Everything in the skill's directory travels with it.

```markdown
---
name: prepare-release
description: Prepare and verify a release.
---

# prepare-release

Describe when this skill applies and what it should do.
```

`name` and `description` are required (`AB102`, `AB116`), both must be strings (`AB107`,
`AB108`), and the name must be kebab-case (`AB101`). A duplicate name raises `AB105`.

The name defaults to the containing directory when frontmatter omits it — but on a non-legacy
bundle an omitted `name` is still reported.

## Agents

`agents/*.agent.md`, or plain `*.md`.

```markdown
---
name: reviewer
description: Reviews changes before release.
model: balanced
tools: [read, shell]
skills: [prepare-release]
---
```

| Field         | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `name`        | required, kebab-case                                        |
| `description` | required                                                    |
| `model`       | semantic class: `fast`, `balanced`, `capable`, or `inherit` |
| `reasoning`   | optional                                                    |
| `tools`       | capabilities: `read`, `write`, `shell`, `web`               |
| `skills`      | preloaded skill names — each must exist, or `AB150`         |

Model and tool mapping quality varies by target: exact on Claude Code, approximate on Cursor,
unsupported on Codex. A dependency cycle among `skills` references raises `AB160`.

## Rules

Markdown with an activation mode.

```markdown
---
name: no-console
description: Do not commit console logging.
activation: files
globs: ["src/**/*.ts"]
---
```

| Activation | Meaning                             |
| ---------- | ----------------------------------- |
| `always`   | always in force (the default)       |
| `files`    | in force for files matching `globs` |
| `model`    | the model decides                   |
| `manual`   | invoked explicitly                  |

Anything else raises `AB130`. Which activations render faithfully is per-target: `always` and
`files` are exact on Claude Code and Cursor; Codex aggregates every rule into `AGENTS.md`, so
`files` is approximate there.

## Hooks

A single YAML or JSON document, plus any handler scripts beside it. The parser accepts
`hooks.yaml`, `hooks.yml`, or `hooks.json` when the configured path is a directory.

```yaml
hooks:
  pre-tool-use:
    - type: command
      matcher: Bash
      command: "${BUNDLE_ROOT}/hooks/guard.sh"
      timeout: 30
```

Portable events are `session-start`, `pre-tool-use`, `post-tool-use`, and `stop`. An event no
target can express raises `AB320` unless a `targets.<platform>` override supplies one.

Handler fields:

| Field                                           | Notes                                                   |
| ----------------------------------------------- | ------------------------------------------------------- |
| `type: command`                                 | the portable handler kind                               |
| `matcher`                                       | preserved on nested-shape targets, dropped on flat ones |
| `command`                                       | placeholders are rewritten per target                   |
| `windowsCommand`                                | needs a target override, or `AB321`                     |
| `protocol` / `inputProtocol` / `outputProtocol` | `json` or `stdio-json`; anything else raises `AB322`    |

The top level may be `hooks:`, `events:`, or the events directly; `targets.<platform>` supplies
per-target overrides that are merged over the base.

Each target reshapes this into its own document — event name casing, envelope, and handler
nesting all differ. See the hooks section of each
[provider's agent-bundle page](../providers.md).

## Command policies

YAML or JSON with a `rules` (or `policies`) array. Each rule is an argument-prefix pattern with
an action and worked examples.

```yaml
rules:
  - pattern: "git push"
    action: prompt
    justification: Review pushes before they run.
    positiveExamples:
      - "git push --force-with-lease"
    negativeExamples:
      - "echo not-a-match"
```

| Field                                | Rules                                            |
| ------------------------------------ | ------------------------------------------------ |
| `action` (or `decision`)             | `allow`, `prompt`, or `deny` — otherwise `AB140` |
| `pattern` (or `prefix`, `command`)   | a string, or an array joined with spaces         |
| `positiveExamples` (or `matches`)    | each **must** match the prefix, or `AB142`       |
| `negativeExamples` (or `nonMatches`) | each **must not** match the prefix, or `AB143`   |

Omitting either example list is not fatal but reports `AB141`. The examples are checked against
the pattern at parse time, so a policy that does not do what its author thought fails before it
is ever rendered.

Policy support is approximate on Claude Code and Codex, and **unsupported on Cursor**, which
has no permission model.

## MCP

A YAML or JSON document naming servers, accepted at `mcp.yaml`, `mcp.yml`, or `mcp.json`.

```yaml
mcpServers:
  example:
    command: npx
    args: ["example-mcp@1.2.3"]
```

`agent package` and `agent audit` both check for **unpinned** `npx` specifiers (`AB506`): a
bare package name resolves to whatever is newest at install time.

## Assets

Everything under the assets root is copied verbatim into every rendered profile.

## Component frontmatter shared by all kinds

| Field       | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| `include`   | array of target ids this component is emitted for      |
| `exclude`   | array of target ids it is not                          |
| `targets`   | object of per-target overrides                         |
| `resources` | files the component needs; each must exist, or `AB151` |
| `scripts`   | same                                                   |

`include`/`exclude` must be arrays (`AB110`) of known targets (`AB106`). `targets` must be an
object (`AB109`) whose values are objects (`AB117`) keyed by known targets (`AB104`). A
`resources` or `scripts` path that escapes its component root raises `AB152`.

## Conditional blocks

Any Markdown in the bundle may carry target-conditional regions. The legacy `platform:`
spelling is still accepted.

```markdown
<!-- target:cursor -->

Cursor-specific instructions.

<!-- /target:cursor -->
```

An unknown target raises `AB120`; an unmatched, misnested, or unclosed block raises `AB121`.
Blocks are validated in **every** `.md` file in the bundle, not only in recognized components.

## Placeholders

Three canonical placeholders are translated to native substitutions where available, or to
explanatory prose where they are not:

| Canonical        | Legacy forms also recognized              |
| ---------------- | ----------------------------------------- |
| `${ARGUMENTS}`   | `$ARGUMENTS`, `{{arguments}}`             |
| `${BUNDLE_ROOT}` | `${CLAUDE_PLUGIN_ROOT}`, `{{bundleRoot}}` |
| `${SKILL_DIR}`   | `${CLAUDE_SKILL_DIR}`, `{{skillDir}}`     |

Argument handling has three modes, declared per target: `native` (the host substitutes),
`advisory` (the token stays, with a hint appended), and `prose` (the token is replaced
outright). See the placeholders section of each
[provider's agent-bundle page](../providers.md).

## Contract tests

A bundle may carry `tests/**/*.test.yaml` asserting what it renders. Discovery is by
convention, with **no manifest key** — adding one would end schema 2's "schema 1 plus
`marketplace:` and `native:`, nothing else" property, and would lock the feature out of v1 and
legacy bundles that can carry tests today. See
[Bundle contract tests](agent-tests.md).

## Related

- [`agent convert`](../commands/agent/convert.md), [`agent validate`](../commands/agent/validate.md),
  [`agent init`](../commands/agent/init.md), [`agent add`](../commands/agent/add.md),
  [`agent upgrade`](../commands/agent/upgrade.md)
- [Conversion output](conversion-output.md) — what a render produces
- [Target profile format](target-profile.md) — how each target's behavior is declared
- [Diagnostics](diagnostics.md) — the `AB###` codes referenced throughout
