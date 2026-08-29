# Claude Code: agent bundles

Target id `claude-code`, declared in `src/agent/targets/claude-code.ts`. This page is the prose
form of that profile; `cairn agent specs --format json` is the authoritative machine-readable
one, and the renderer reads the same data, so the two cannot disagree.

Claude Code is the reference target: it is the only host that supports every portable feature
at `exact` quality except command policies, and the only one whose plugin format carries hooks,
agents, skills, and MCP together.

## Output profiles

Both `plugin` and `project` are supported.

```text
<output>/claude-code/plugin/
  .claude-plugin/plugin.json
  skills/<name>/SKILL.md
  agents/<name>.md
  hooks/hooks.json
  hooks/<script>
  .mcp.json
  assets/…

<output>/claude-code/project/
  .claude/skills/<name>/SKILL.md
  .claude/agents/<name>.md
  .claude/rules/<name>.md
  .claude/settings.json
  .mcp.json
  assets/…
```

Those are the profile's **declared output patterns**, and they are enforced: `agent doctor`
reports any rendered path that no pattern describes, and the conformance fixtures fail the
build on one. A hardcoded path in the renderer therefore cannot ship.

| Profile   | Feature    | Pattern                      |
| --------- | ---------- | ---------------------------- |
| `plugin`  | `manifest` | `.claude-plugin/plugin.json` |
| `plugin`  | `skills`   | `skills/{name}/**`           |
| `plugin`  | `agents`   | `agents/{name}.md`           |
| `plugin`  | `hooks`    | `hooks/**`                   |
| `plugin`  | `mcp`      | `.mcp.json`                  |
| `plugin`  | `assets`   | `assets/**`                  |
| `project` | `skills`   | `.claude/skills/{name}/**`   |
| `project` | `agents`   | `.claude/agents/{name}.md`   |
| `project` | `rules`    | `.claude/rules/{name}.md`    |
| `project` | `policies` | `.claude/settings.json`      |
| `project` | `mcp`      | `.mcp.json`                  |
| `project` | `assets`   | `assets/**`                  |

In a pattern, `{name}` matches exactly one path segment, `*` matches part of a segment, and a
trailing `**` matches any remaining suffix including nothing.

## Feature support

| Feature        | Support       | Profiles        | Native surface            | Diagnostics               |
| -------------- | ------------- | --------------- | ------------------------- | ------------------------- |
| `skills`       | `exact`       | plugin, project | `skills/<name>/SKILL.md`  | —                         |
| `agents`       | `exact`       | plugin, project | `agents/<name>.md`        | `AB330`, `AB331`          |
| `rules`        | `exact`       | project         | `.claude/rules/<name>.md` | `AB350`, `AB351`          |
| `hooks`        | `exact`       | plugin          | `hooks/hooks.json`        | `AB320`–`AB322`           |
| `policies`     | `approximate` | project         | `.claude/settings.json`   | `AB360`                   |
| `mcp`          | `exact`       | plugin, project | `.mcp.json`               | —                         |
| `assets`       | `exact`       | plugin, project | `assets/`                 | —                         |
| `placeholders` | `exact`       | plugin, project | `${CLAUDE_PLUGIN_ROOT}`   | —                         |
| `native`       | `native`      | plugin, project | `native/claude-code/`     | `AB181`, `AB182`, `AB187` |

`support` is the **best** quality the feature reaches on this target. An individual component
can still render worse — a malformed input or an unsupported profile is reported per
diagnostic — but never better. That is what the conformance suite asserts.

Rules are `exact` but **project-only**: a Claude Code plugin has no rules surface, so a bundle
whose rules matter must ship the project profile.

## The plugin manifest

Directory `.claude-plugin/`, file `plugin.json`.

| Field         | Required | Support |
| ------------- | -------- | ------- |
| `name`        | yes      | `exact` |
| `version`     | yes      | `exact` |
| `description` | yes      | `exact` |
| `skills`      | no       | `exact` |
| `agents`      | no       | `exact` |
| `hooks`       | no       | `exact` |
| `mcpServers`  | no       | `exact` |

### Implied manifest fields

`agents` and `hooks` are declared in the profile as **implied fields**, which means the
renderer deliberately leaves them out of the generated manifest. Declaring either is not merely
redundant, it is an error, and neither kind is caught by `claude plugin validate`:

- `agents` accepts a list of _files_, and rejects the component _directory_ the renderer would
  name. The whole manifest fails.
- `hooks` is for _additional_ hook files. Naming the standard `hooks/hooks.json` that the host
  has already loaded is a duplicate, and the plugin's hooks are dropped.

Omitting them is what makes `agents/` and `hooks/hooks.json` load at all.

## Paths

| Root     | `plugin`    | `project`               |
| -------- | ----------- | ----------------------- |
| skills   | `skills`    | `.claude/skills`        |
| agents   | `agents`    | `.claude/agents`        |
| rules    | —           | `.claude/rules`         |
| policies | —           | `.claude/settings.json` |
| hooks    | `hooks`     | —                       |
| mcp      | `.mcp.json` | `.mcp.json`             |
| assets   | `assets`    | `assets`                |

Plugin skill directories are **not** namespaced — `skills/<name>/`, not
`skills/<bundle>-<name>/`. Cursor is the target that namespaces them.

## Placeholders

| Placeholder      | Rendered as                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `${BUNDLE_ROOT}` | `${CLAUDE_PLUGIN_ROOT}` (plugin), `${CLAUDE_PROJECT_DIR}` (project) |
| `${ARGUMENTS}`   | `$ARGUMENTS` — substituted natively by the host                     |
| `${SKILL_DIR}`   | `${CLAUDE_SKILL_DIR}`                                               |

Argument substitution is `native`: the host performs it, so no advisory prose is emitted and
nothing is approximated. The root variables the host understands are `${CLAUDE_PLUGIN_ROOT}`,
`${CLAUDE_PROJECT_DIR}`, and `${CLAUDE_SKILL_DIR}`.

## Hooks

Portable events map to PascalCase native names, and all four are expressible:

| Portable event  | Claude Code name |
| --------------- | ---------------- |
| `session-start` | `SessionStart`   |
| `pre-tool-use`  | `PreToolUse`     |
| `post-tool-use` | `PostToolUse`    |
| `stop`          | `Stop`           |

The envelope is `hooks` — the document is `{ "hooks": { … } }` with no version wrapper — and
the handler shape is `claude-nested`, meaning each handler is emitted as
`{ matcher, hooks: [{ type: "command", … }] }`. Supported protocols are `json` and
`stdio-json`; anything else raises `AB322`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" }]
      }
    ]
  }
}
```

## Models and tools

Semantic model classes map to native ids exactly:

| Class      | Claude Code |
| ---------- | ----------- |
| `fast`     | `haiku`     |
| `balanced` | `sonnet`    |
| `capable`  | `opus`      |
| `inherit`  | `inherit`   |

Tool capability restriction is also `exact`, and expands to concrete tool names:

| Capability | Tools                   |
| ---------- | ----------------------- |
| `read`     | `Read`, `Glob`, `Grep`  |
| `write`    | `Write`, `Edit`         |
| `shell`    | `Bash`                  |
| `web`      | `WebFetch`, `WebSearch` |

Claude Code is the only target that expresses tool capabilities natively; the other two record
`capabilities: null` and approximate.

## Rules

Form `markdown`. `always` and `files` activation are exact; `model` and `manual` are
unsupported and reported. Rules render only in the project profile, at
`.claude/rules/<name>.md`.

## Command policies

`approximate`, into `.claude/settings.json` project permissions. A portable policy carries an
argument-prefix pattern with `allow`/`prompt`/`deny` and worked examples; Claude Code's
permission model is close but not identical, so the mapping is reported as approximate rather
than claimed as faithful. Diagnostic `AB360`.

## Marketplace catalog

`agent package` writes `.claude-plugin/marketplace.json` for both the `repo` and `local`
distribution modes, with `plugins` as the entries array.

Document-level fields — the marketplace's own identity, beside the entries:

| Catalog key   | Required | Source                  |
| ------------- | -------- | ----------------------- |
| `name`        | yes      | manifest `name`         |
| `description` | no       | manifest `description`  |
| `owner`       | yes      | `marketplace.publisher` |

Claude Code rejects a catalog with no `name`, and enforces that it match the
`extraKnownMarketplaces` key. `agent install --register` derives that key from the bundle name,
so sourcing `name` from the manifest keeps the two in step.

Entry fields:

| Catalog key   | Required | Source                   | Transform                                           |
| ------------- | -------- | ------------------------ | --------------------------------------------------- |
| `name`        | yes      | manifest `name`          | identity                                            |
| `version`     | yes      | manifest `version`       | identity                                            |
| `description` | yes      | manifest `description`   | identity                                            |
| `source`      | yes      | computed                 | —                                                   |
| `author`      | no       | `marketplace.publisher`  | identity — an **object**, unlike Cursor's bare name |
| `category`    | no       | `marketplace.categories` | `first` — **singular**: one category, not the list  |
| `license`     | no       | `marketplace.license`    | identity                                            |

Assets: an optional `icon` (`.png`/`.svg`, ≤ 1 MiB) and optional `screenshot` (`.png`/`.jpg`,
≤ 4 MiB). Archives are named `{name}-{version}-{target}-{profile}.tar.gz`.

## Install locations

| Scope     | Root                             | Layout        | Profile   | Activation                                          |
| --------- | -------------------------------- | ------------- | --------- | --------------------------------------------------- |
| `user`    | `~/.claude/plugins/marketplaces` | `marketplace` | `plugin`  | `~/.claude/settings.json`, `claude-enabled-plugins` |
| `project` | the working tree                 | `merge`       | `project` | none — the root is auto-scanned                     |

Claude Code's user-scope layout is the only one in the project that needs an activation edit,
which is why `--register` exists and why it is the only flag that touches host configuration.
`agent uninstall` removes exactly the inventory `.cairn-install.json` records and reverses the
registration it made.

## Native overlays

Overlay root `native/claude-code/`, mirroring the output tree:

```text
native/claude-code/
  manifest.json                           # merged over the generated plugin.json
  plugin/.claude-plugin/marketplace.json  # -> <output>/claude-code/plugin/…
  project/.claude/statusline.json         # -> <output>/claude-code/project/…
```

Overlay files are copied verbatim: no placeholder rewriting, no target-block processing, no
path rewriting. They are already native, and rewriting them would be exactly the "pretend it is
portable" failure the overlay layer exists to avoid. They cannot escape their target root, and
they carry `"origin": "native"` in JSON output.

Overlay paths are **deliberately not declared** in `outputs`. `TargetProfile.outputs` describes
what the renderer emits; an overlay's whole purpose is a surface the portable profile does not
describe. `agent doctor` reports them under `doctor.overlays` rather than as undeclared
findings.

## Related

- [`agent convert`](../../commands/agent/convert.md) and [`agent specs`](../../commands/agent/specs.md)
- [Agent bundle format](../../formats/agent-bundle.md) — the source side
- [Target profile format](../../formats/target-profile.md) — the structure this page describes
