# Codex: agent bundles

Target id `codex`, declared in `src/agent/targets/codex.ts`. `cairn agent specs --format json`
is the authoritative machine-readable form.

Codex is the target with the most approximations, and each one is declared rather than
discovered at render time. The three that shape everything else: there is no plugin-scope
agents root, there is no model field, and there is no native `$ARGUMENTS` substitution.

## Output profiles

Both `plugin` and `project`.

```text
<output>/codex/plugin/
  .codex-plugin/plugin.json
  skills/<name>/SKILL.md
  hooks/hooks.json
  .mcp.json
  assets/…

<output>/codex/project/
  .agents/skills/<name>/SKILL.md
  .codex/agents/<name>.toml
  .codex/rules/bundle.rules
  .codex/config.toml
  AGENTS.md
  assets/…
```

Declared output patterns:

| Profile   | Feature    | Pattern                     |
| --------- | ---------- | --------------------------- |
| `plugin`  | `manifest` | `.codex-plugin/plugin.json` |
| `plugin`  | `skills`   | `skills/{name}/**`          |
| `plugin`  | `hooks`    | `hooks/**`                  |
| `plugin`  | `mcp`      | `.mcp.json`                 |
| `plugin`  | `assets`   | `assets/**`                 |
| `project` | `skills`   | `.agents/skills/{name}/**`  |
| `project` | `agents`   | `.codex/agents/{name}.toml` |
| `project` | `rules`    | `AGENTS.md`                 |
| `project` | `policies` | `.codex/rules/bundle.rules` |
| `project` | `mcp`      | `.codex/config.toml`        |
| `project` | `assets`   | `assets/**`                 |

Note there is **no `agents` pattern in the plugin profile**. That is not an omission; see
below.

## Feature support

| Feature        | Support       | Profiles        | Native surface              | Diagnostics               |
| -------------- | ------------- | --------------- | --------------------------- | ------------------------- |
| `skills`       | `exact`       | plugin, project | `skills/<name>/SKILL.md`    | `AB310`                   |
| `agents`       | `approximate` | project only    | `.codex/agents/<name>.toml` | `AB330`, `AB332`, `AB340` |
| `rules`        | `approximate` | project         | `AGENTS.md`                 | `AB350`, `AB351`          |
| `hooks`        | `exact`       | plugin          | `hooks/hooks.json`          | `AB320`–`AB322`           |
| `policies`     | `approximate` | project         | `.codex/rules/bundle.rules` | `AB360`                   |
| `mcp`          | `approximate` | plugin, project | `.mcp.json`                 | `AB370`                   |
| `assets`       | `exact`       | plugin, project | `assets/`                   | —                         |
| `placeholders` | `approximate` | plugin, project | `${PLUGIN_ROOT}`            | `AB302`                   |
| `native`       | `native`      | plugin, project | `native/codex/`             | `AB181`, `AB182`, `AB187` |

## Agents are project-only

Codex custom agents exist only at project scope. The plugin path profile therefore records
`agents: null`, and rendering an agent into a Codex plugin is refused with `AB340` rather than
being written somewhere the host will never look.

A bundle whose agents matter must ship the project profile, where they render as
`.codex/agents/<name>.toml` — TOML, not Markdown, which is the other target-shape difference to
watch for.

## The plugin manifest

Directory `.codex-plugin/`, file `plugin.json`.

| Field         | Required | Support |
| ------------- | -------- | ------- |
| `name`        | yes      | `exact` |
| `version`     | yes      | `exact` |
| `description` | yes      | `exact` |
| `skills`      | no       | `exact` |
| `hooks`       | no       | `exact` |
| `mcpServers`  | no       | `exact` |

There is no `agents` field, matching the missing plugin agents root. Codex declares no implied
fields — unlike Claude Code, naming `hooks` here is not harmful.

## Paths

| Root     | `plugin`    | `project`            |
| -------- | ----------- | -------------------- |
| skills   | `skills`    | `.agents/skills`     |
| agents   | — (none)    | `.codex/agents`      |
| rules    | —           | `AGENTS.md`          |
| policies | —           | `.codex/rules`       |
| hooks    | `hooks`     | —                    |
| mcp      | `.mcp.json` | `.codex/config.toml` |
| assets   | `assets`    | `assets`             |

Plugin skill directories are not namespaced.

## Placeholders

| Placeholder      | Rendered as                                   |
| ---------------- | --------------------------------------------- |
| `${BUNDLE_ROOT}` | `${PLUGIN_ROOT}` (plugin), `.` (project)      |
| `${ARGUMENTS}`   | replaced by explanatory prose                 |
| `${SKILL_DIR}`   | resolved away relative to the skill directory |

Argument handling is `prose`, the weakest of the three modes. Codex performs no `$ARGUMENTS`
substitution, so leaving the token in place would ship a literal `$ARGUMENTS` into the
rendered instruction. Instead the renderer replaces it with a sentence telling the model to
extract the argument from the user's message, and reports `AB302`.

Compare: Claude Code substitutes natively, and Cursor keeps the token but appends an advisory
line beside it.

The only root variable Codex understands is `${PLUGIN_ROOT}`.

## Hooks

All four portable events map, and to the same PascalCase names Claude Code uses:

| Portable event  | Codex name     |
| --------------- | -------------- |
| `session-start` | `SessionStart` |
| `pre-tool-use`  | `PreToolUse`   |
| `post-tool-use` | `PostToolUse`  |
| `stop`          | `Stop`         |

Envelope `hooks`, handler shape `claude-nested`, protocols `json` and `stdio-json` — identical
to Claude Code's hook document. Hooks are plugin-profile only.

Note the asymmetry with the usage side: Codex _runs_ hooks and _accepts_ this document, but
records no execution of one in its rollout files, so [usage reporting](usage-logs.md) declares
`hooks: false`.

## Models and tools

| Aspect | Support       | Detail                                                                    |
| ------ | ------------- | ------------------------------------------------------------------------- |
| models | `unsupported` | every class maps to `null` — Codex has no model field on an agent         |
| tools  | `approximate` | `capabilities: null` — capability restriction is not expressible natively |

A bundle that declares a semantic `model:` on an agent still converts; the field is dropped and
the loss is reported rather than silently ignored.

## Rules

Form `aggregated-agents-md`: every rule is concatenated into the project's single `AGENTS.md`
layer, rather than one file per rule.

`always` activation is exact. `files` activation is **approximate** — `AGENTS.md` has no glob
scoping, so a file-scoped rule becomes an always-on rule with its globs described in prose.
`model` and `manual` are unsupported.

## Command policies

`approximate`, into `.codex/rules/bundle.rules`. Diagnostic `AB360`.

## MCP

`approximate`, and for a specific reason: the plugin profile emits a normal `.mcp.json`, but
Codex's project scope reads MCP servers out of `.codex/config.toml`. TOML is a different
document with different semantics, so a project-scope MCP block renders what it can and reports
`AB370` for what needs target-supplied TOML.

## Marketplace catalog

`.codex-plugin/marketplace.json`, entries key `plugins`, for both `repo` and `local` modes.
Codex declares no document-level fields.

Codex's catalog is the strictest of the three — seven required entry fields against Claude
Code's four:

| Catalog key      | Required | Source                       | Transform                                                               |
| ---------------- | -------- | ---------------------------- | ----------------------------------------------------------------------- |
| `name`           | yes      | manifest `name`              | identity                                                                |
| `version`        | yes      | manifest `version`           | identity                                                                |
| `description`    | yes      | manifest `description`       | identity                                                                |
| `source`         | yes      | computed                     | —                                                                       |
| `displayName`    | yes      | `marketplace.displayName`    | identity                                                                |
| `publisher`      | yes      | `marketplace.publisher`      | `name` — a bare name string, unlike Claude Code's object                |
| `categories`     | yes      | `marketplace.categories`     | identity — the **whole list**, unlike Claude Code's singular `category` |
| `icon`           | yes      | `marketplace.icon`           | identity                                                                |
| `starterPrompts` | no       | `marketplace.starterPrompts` | identity                                                                |
| `homepage`       | no       | `marketplace.homepage`       | identity                                                                |
| `license`        | yes      | `marketplace.license`        | identity                                                                |

Assets: `icon` is **required** (`.png`/`.svg`, ≤ 1 MiB); `screenshot` optional (`.png`/`.jpg`,
≤ 4 MiB). Archive name `{name}-{version}-{target}-{profile}.tar.gz`.

A bundle that packages cleanly for Claude Code may well fail `agent package --target codex`
purely on missing listing metadata. That is the catalog spec talking, not a bug.

## Install locations

| Scope     | Root             | Layout  | Profile   | Activation |
| --------- | ---------------- | ------- | --------- | ---------- |
| `user`    | none             | —       | —         | —          |
| `project` | the working tree | `merge` | `project` | none       |

There is no user scope, deliberately: Codex's project rules root is `AGENTS.md`, and a
user-scope merge would clobber `~/AGENTS.md`.

## Native overlays

Overlay root `native/codex/`, same rules as every other target: verbatim copy, no placeholder
rewriting, no target-block processing, cannot escape the target root, `"origin": "native"` in
JSON output, reported under `doctor.overlays`.

For Codex the overlay layer carries more weight than elsewhere, because it is the only way to
ship a hand-written `.codex/config.toml` MCP block or a plugin-scope agent surface the portable
model does not describe.

## Related

- [`agent convert`](../../commands/agent/convert.md) and [`agent specs`](../../commands/agent/specs.md)
- [Agent bundle format](../../formats/agent-bundle.md)
- [Target profile format](../../formats/target-profile.md)
