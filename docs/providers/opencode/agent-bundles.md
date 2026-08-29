# OpenCode: agent bundles

OpenCode is a conversion target. The profile is `src/agent/targets/opencode.ts`, published by
[`agent specs`](../../commands/agent/specs.md), and was written against the
`customize-opencode` skill the 1.18.23 binary embeds — the host's own configuration reference —
and verified against that version.

## The negative fact that shapes everything

**Unknown top-level keys in `opencode.json` are rejected with `ConfigInvalidError`, and the host
refuses to start.** So Cairn never writes a bundle manifest there. The plugin manifest goes in
`.opencode-plugin/`, a directory OpenCode does not read, following the same convention
`.codex-plugin/` and `.cursor-plugin/` already use.

## Layout

```text
opencode/plugin/                     opencode/project/
  .opencode-plugin/plugin.json         .opencode/skills/<name>/SKILL.md
  skills/<name>/SKILL.md               .opencode/agent/<name>.md
  agent/<name>.md                      AGENTS.md
  .mcp.json                            opencode.json
  assets/**                            assets/**
```

The host accepts both spellings of several directories — `skill`/`skills`, `agent`/`agents`,
`command`/`commands`. Cairn writes `.opencode/skills` (the spelling the host's own `skills.paths`
example uses) and `.opencode/agent` (the one its documentation lists first).

## Output patterns

| Profile   | Feature  | Pattern                        |
| --------- | -------- | ------------------------------ |
| `plugin`  | manifest | `.opencode-plugin/plugin.json` |
| `plugin`  | skills   | `skills/{name}/**`             |
| `plugin`  | agents   | `agent/{name}.md`              |
| `plugin`  | mcp      | `.mcp.json`                    |
| `plugin`  | assets   | `assets/**`                    |
| `project` | skills   | `.opencode/skills/{name}/**`   |
| `project` | agents   | `.opencode/agent/{name}.md`    |
| `project` | rules    | `AGENTS.md`                    |
| `project` | mcp      | `opencode.json`                |
| `project` | assets   | `assets/**`                    |

## There are no hooks

OpenCode 1.18.23 has **no lifecycle hook file at all**. Every portable event maps to `null`, and
because `features.hooks.profiles` is empty the renderer skips hook emission entirely rather than
writing an inert `hooks/hooks.json` — the "looks right, does nothing" failure this project cares
most about. A bundle with hooks reports `AB320` per event.

The plugin API is TypeScript callbacks in `.opencode/plugin/*.ts` — `tool.execute.before`,
`tool.execute.after`, `permission.ask`, `chat.params` and the rest. A portable JSON hook
declaration cannot express a callback, so the honest answer is `unsupported`. Use a
[native overlay](../../formats/target-profile.md) at `native/opencode/` to ship one.

## Command policies are not written, deliberately

OpenCode _does_ have a native command policy: `permission.bash` in `opencode.json`, with
`allow`/`ask`/`deny` and last-match-wins. `policies.form` is nonetheless `null`, and a policy is
reported with `AB361`.

The reason is a collision rather than a missing feature. `paths.project.mcp` is already
`opencode.json`, and both the MCP writer and `renderPolicies` serialize a whole document — two
writers to one path is a duplicate-path diagnostic and a clobber. Shipping a permission file that
silently erases the user's MCP block is worse than shipping none. `PolicyForm` reserves
`opencode-permission` so that adding it later, once the two share a merge-aware writer for a
single config file, is a data edit rather than a redesign.

## Agents

`.opencode/agent/<name>.md`, Markdown with frontmatter, in both profiles. The frontmatter keys
the host accepts are `name`, `model`, `variant`, `description`, `mode`, `hidden`, `color`,
`steps`, `options`, `permission`, `disable`, `temperature` and `top_p`, and the body becomes the
prompt.

Two mappings are declared inexact:

- **Models** are `unsupported`. Every OpenCode model id is `provider/model-id`, so mapping a
  semantic class such as `balanced` would hardcode one vendor into a neutral profile.
- **Tools** are `approximate` and emit `AB332`. An exact map is knowable, but OpenCode's `tools`
  frontmatter is a boolean map while the renderer produces an array — a correctly-named key of
  the wrong shape is worse than declaring the restriction inexpressible.

## Rules and MCP

Rules aggregate into `AGENTS.md`, the same form Codex uses. `instructions` accepts globs but not
per-rule activation, so a `files` activation is reported as `AB351`.

MCP is `mcp` inside `opencode.json` for the project profile and `.mcp.json` in a plugin. It is
declared `approximate` rather than `exact` because of the strict key validation above: a bundle's
MCP document has to already be OpenCode config shape, since anything else stops the host.

## Install

`install.user` is `null`. Global scope drops the `.opencode/` prefix — skills live at
`~/.config/opencode/skills/`, not `~/.config/opencode/.opencode/skills/` — and an
`InstallLocation` cannot rewrite a path, so declaring a merge there would install to a directory
OpenCode never scans. That is the same reasoning Codex's `install.user: null` records.

The project scope merges into the repository root.

## There is no marketplace

`opencode plugin <module>` installs an npm package; there is no catalog format.
[`agent package`](../../commands/agent/package.md) skips this target rather than inventing one.

## Unverified rows

- that skills do not substitute `$ARGUMENTS` — it is documented for **commands**, and unstated
  for skills, so `arguments` is `advisory`, which is safe under either reading
- which of `skill`/`skills` and `agent`/`agents` is canonical; the host accepts both

## Related

- [Target profile format](../../formats/target-profile.md)
- [`agent convert`](../../commands/agent/convert.md)
