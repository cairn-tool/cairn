# Cursor: agent bundles

Target id `cursor`, declared in `src/agent/targets/cursor.ts`. `cairn agent specs --format json`
is the authoritative machine-readable form.

Cursor sits between Claude Code and Codex. It has a real rules surface — the best of the three
— and a real plugin format, but no permission model, no tool-capability restriction, and a
model vocabulary of exactly two values.

## Output profiles

Both `plugin` and `project`.

```text
<output>/cursor/plugin/
  .cursor-plugin/plugin.json
  skills/<bundle>-<name>/SKILL.md      # namespaced
  agents/<name>.md
  .cursor/rules/<name>.mdc
  hooks/hooks.json
  .mcp.json
  assets/…

<output>/cursor/project/
  .cursor/skills/<name>/SKILL.md
  .cursor/agents/<name>.md
  .cursor/rules/<name>.mdc
  .cursor/hooks.json
  .cursor/mcp.json
  assets/…
```

Declared output patterns:

| Profile   | Feature    | Pattern                      |
| --------- | ---------- | ---------------------------- |
| `plugin`  | `manifest` | `.cursor-plugin/plugin.json` |
| `plugin`  | `skills`   | `skills/{name}/**`           |
| `plugin`  | `agents`   | `agents/{name}.md`           |
| `plugin`  | `rules`    | `.cursor/rules/{name}.mdc`   |
| `plugin`  | `hooks`    | `hooks/**`                   |
| `plugin`  | `mcp`      | `.mcp.json`                  |
| `plugin`  | `assets`   | `assets/**`                  |
| `project` | `skills`   | `.cursor/skills/{name}/**`   |
| `project` | `agents`   | `.cursor/agents/{name}.md`   |
| `project` | `rules`    | `.cursor/rules/{name}.mdc`   |
| `project` | `policies` | `.cursor/hooks.json`         |
| `project` | `mcp`      | `.cursor/mcp.json`           |
| `project` | `assets`   | `assets/**`                  |

Cursor is the only target with a `rules` pattern in the **plugin** profile. Claude Code and
Codex both render rules at project scope only.

## Feature support

| Feature        | Support       | Profiles        | Native surface                    | Diagnostics               |
| -------------- | ------------- | --------------- | --------------------------------- | ------------------------- |
| `skills`       | `approximate` | plugin, project | `skills/<bundle>-<name>/SKILL.md` | `AB310`                   |
| `agents`       | `approximate` | plugin, project | `agents/<bundle>-<name>.md`       | `AB330`, `AB332`          |
| `rules`        | `exact`       | plugin, project | `.cursor/rules/<name>.mdc`        | `AB351`                   |
| `hooks`        | `exact`       | plugin          | `hooks/hooks.json`                | `AB320`–`AB322`           |
| `policies`     | `unsupported` | project         | `.cursor/hooks.json`              | `AB360`, `AB361`          |
| `mcp`          | `exact`       | plugin, project | `.cursor/mcp.json`                | —                         |
| `assets`       | `exact`       | plugin, project | `assets/`                         | —                         |
| `placeholders` | `approximate` | plugin, project | —                                 | —                         |
| `native`       | `native`      | plugin, project | `native/cursor/`                  | `AB181`, `AB182`, `AB187` |

## Component namespacing

Cursor is the only target that namespaces plugin components by bundle name — `naming.namespace`
lists both `skills` and `agents` under the `plugin` profile, joined with `-`. A skill named
`prepare-release` and an agent named `scout`, in a bundle named `release-helper`, render as:

```text
skills/release-helper-prepare-release/SKILL.md
agents/release-helper-scout.md
```

The prefix goes on the **frontmatter `name` as well as the path**. That is a fix, not a
refinement: the directory used to be namespaced while `name:` was left bare, so
`skills/release-helper-prepare-release/SKILL.md` shipped saying `name: prepare-release` — one
skill with two identities, which is a host's problem the moment it validates or derives one from
the other.

Project-scope components are **not** namespaced; they render as `.cursor/skills/<name>/` and
`.cursor/agents/<name>.md`. Every bundle installed at plugin scope shares one flat namespace,
which is what the prefix is for.

This is why the `skills` and `agents` features are `approximate` rather than `exact`: the
identity on disk is not the identity the bundle declared. Write a cross-component instruction as
an [inline reference](../../formats/agent-bundle.md#inline-component-references) rather than a
literal name, and it resolves to `<bundle>-<name>` here and to whatever each other host uses.
The renderer reads all of this from the profile rather than branching on the target.

The body `# <heading>` is left alone — it is prose, not identity, and no host derives one from
it. A document that wants the resolved name in its heading asks for it:
`# <!-- ref:skill:prepare-release -->`.

## The plugin manifest

Directory `.cursor-plugin/`, file `plugin.json`. The same seven fields as Claude Code's:

| Field         | Required | Support |
| ------------- | -------- | ------- |
| `name`        | yes      | `exact` |
| `version`     | yes      | `exact` |
| `description` | yes      | `exact` |
| `skills`      | no       | `exact` |
| `agents`      | no       | `exact` |
| `hooks`       | no       | `exact` |
| `mcpServers`  | no       | `exact` |

Cursor declares **no implied fields**, so unlike Claude Code the renderer may name `agents` and
`hooks` here.

## Paths

| Root     | `plugin`    | `project`            |
| -------- | ----------- | -------------------- |
| skills   | `skills`    | `.cursor/skills`     |
| agents   | `agents`    | `.cursor/agents`     |
| rules    | —           | `.cursor/rules`      |
| policies | —           | `.cursor/hooks.json` |
| hooks    | `hooks`     | —                    |
| mcp      | `.mcp.json` | `.cursor/mcp.json`   |
| assets   | `assets`    | `assets`             |

## Placeholders

| Placeholder      | Rendered as                                   |
| ---------------- | --------------------------------------------- |
| `${BUNDLE_ROOT}` | `.` in both profiles                          |
| `${ARGUMENTS}`   | kept, with an advisory line appended          |
| `${SKILL_DIR}`   | resolved away relative to the skill directory |

Argument handling is `advisory`, the middle mode. Cursor does not substitute `$ARGUMENTS`, but
unlike Codex the token is left in place and a hint is appended beside it:

```markdown
> If the above shows literal `$ARGUMENTS`, extract the argument from the user's message.
```

Cursor declares **no root variables** at all — `rootVariables` is empty — which is why
`${BUNDLE_ROOT}` becomes a plain `.` rather than a host variable.

## Hooks

Cursor's hook document is the one that differs structurally from the other two:

| Portable event  | Cursor name    |
| --------------- | -------------- |
| `session-start` | `sessionStart` |
| `pre-tool-use`  | `preToolUse`   |
| `post-tool-use` | `postToolUse`  |
| `stop`          | `stop`         |

- **camelCase**, not PascalCase.
- Envelope `versioned`: the document is `{ "version": 1, "hooks": { … } }`.
- Handler shape `flat`: handlers are emitted as-is, with `type`, `windowsCommand`, `protocol`,
  `inputProtocol`, and `outputProtocol` stripped — there is no `{ matcher, hooks: [...] }`
  nesting.

Protocols `json` and `stdio-json` are supported, the same as the other targets.

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "command": "./hooks/guard.sh" }]
  }
}
```

All three of those differences are read from the profile — `hooks.events`, `hooks.envelope`,
`hooks.handlerShape` — rather than branched on in the renderer.

## Models and tools

| Class      | Cursor    |
| ---------- | --------- |
| `fast`     | `fast`    |
| `balanced` | `inherit` |
| `capable`  | `inherit` |
| `inherit`  | `inherit` |

Support is `approximate`, and the table shows why: Cursor distinguishes only "fast" from
"whatever the session is using", so `balanced` and `capable` both collapse to `inherit`. A
bundle that meaningfully distinguishes them loses that distinction here, and `AB332` reports
it.

Tool capability restriction is `approximate` with `capabilities: null` — not expressible
natively.

## Rules

Form `mdc`, and this is Cursor's strongest feature: `always` and `files` activation are both
**exact**, rendered as `.cursor/rules/<name>.mdc` with native glob scoping. `model` and
`manual` remain unsupported.

Rules render in both profiles, which no other target offers.

## Command policies

`unsupported`. Cursor has no permission model, so a portable policy has nowhere faithful to go.
It converts only through an explicit hook override into `.cursor/hooks.json`; without one it is
reported (`AB360`, `AB361`) and dropped rather than silently approximated into something that
does not enforce anything.

## MCP

`exact`, at `.cursor/mcp.json` for the project profile and `.mcp.json` for the plugin profile.

## Marketplace catalog

`.cursor-plugin/marketplace.json`, entries key `plugins`, for both `repo` and `local` modes. No
document-level fields.

| Catalog key   | Required | Source                    | Transform                                         |
| ------------- | -------- | ------------------------- | ------------------------------------------------- |
| `name`        | yes      | manifest `name`           | identity                                          |
| `version`     | yes      | manifest `version`        | identity                                          |
| `description` | yes      | manifest `description`    | identity                                          |
| `source`      | yes      | computed                  | —                                                 |
| `displayName` | yes      | `marketplace.displayName` | identity                                          |
| `author`      | no       | `marketplace.publisher`   | `name` — a bare name, unlike Claude Code's object |
| `categories`  | no       | `marketplace.categories`  | identity — the whole list                         |
| `icon`        | no       | `marketplace.icon`        | identity                                          |

The underlying `marketplace.publisher` lands as Claude Code's `owner`/`author` **object** and
Cursor's optional `author` **string**. The reshape is named in each profile as a `transform`
rather than being a field-name check inside the packager.

Assets: `icon` and `screenshot` both optional. Archive name
`{name}-{version}-{target}-{profile}.tar.gz`.

## Install locations

| Scope     | Root                      | Layout       | Profile   | Activation                      |
| --------- | ------------------------- | ------------ | --------- | ------------------------------- |
| `user`    | `~/.cursor/plugins/local` | `plugin-dir` | `plugin`  | none — the root is auto-scanned |
| `project` | the working tree          | `merge`      | `project` | none                            |

Cursor's user scope is the simplest of the three: a plain plugin directory that the host scans
on its own, so `--register` is neither needed nor accepted.

## Native overlays

Overlay root `native/cursor/`. Same rules as every target: verbatim copy, no placeholder
rewriting, no target-block processing, cannot escape the target root, `"origin": "native"` in
JSON output, reported under `doctor.overlays`.

## Related

- [`agent convert`](../../commands/agent/convert.md) and [`agent specs`](../../commands/agent/specs.md)
- [Agent bundle format](../../formats/agent-bundle.md)
- [Target profile format](../../formats/target-profile.md)
