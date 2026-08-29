# Antigravity: agent bundles

Antigravity is a conversion target. The profile is `src/agent/targets/antigravity.ts`, published
by [`agent specs`](../../commands/agent/specs.md).

It was written against the host's **own embedded documentation** — the Customization System
Guide, the Lifecycle Hooks guide, the Plugins guide, and the JSON Configurations guide all ship
inside the `agy` binary — and verified against `agy` **1.1.18**. That makes most rows below
first-party rather than reconstructed. The rows that are not are listed at the end, because
"unsupported" and "not established" are different answers and only one of them is a bug.

> Do not confuse this host with [Gemini CLI](../gemini-cli/overview.md). Both keep state under
> `~/.gemini` and share nothing else. Gemini CLI's hooks live in `~/.gemini/settings.json` under
> `BeforeAgent`/`AfterAgent`/`BeforeTool`/`AfterTool`, one nesting level deeper and under
> different names. A profile written from the wrong one renders a tree that loads nothing.

## Layout

```text
antigravity/plugin/                antigravity/project/
  plugin.json                        .agents/skills/<name>/SKILL.md
  skills/<name>/SKILL.md             .agents/rules/<name>.md
  hooks.json                         .agents/mcp_config.json
  hooks/<script>                     assets/**
  mcp_config.json
  assets/**
```

A plugin is a directory under a `plugins/` folder in a customization root — `.agents/plugins/`
in a workspace, or `~/.gemini/config/plugins/` globally. The project profile writes into
`.agents/`, the workspace customization root; the host also accepts `.agent/`, `_agents/` and
`_agent/`, and Cairn writes the first.

## Output patterns

| Profile   | Feature  | Pattern                    |
| --------- | -------- | -------------------------- |
| `plugin`  | manifest | `plugin.json`              |
| `plugin`  | skills   | `skills/{name}/**`         |
| `plugin`  | hooks    | `hooks.json`, `hooks/**`   |
| `plugin`  | mcp      | `mcp_config.json`          |
| `plugin`  | assets   | `assets/**`                |
| `project` | skills   | `.agents/skills/{name}/**` |
| `project` | rules    | `.agents/rules/{name}.md`  |
| `project` | mcp      | `.agents/mcp_config.json`  |
| `project` | assets   | `assets/**`                |

## The manifest sits at the plugin root

`manifest.directory` is `null`. Antigravity's `plugin.json` is at the plugin root rather than in
a `.antigravity-plugin/` directory, and it is a **marker** rather than an index: the host ingests
every skill, rule, hook and MCP server in the plugin's directory structure automatically. So
`skills`, `agents`, `hooks` and `mcpServers` are all declared as `impliedFields` and left out —
naming them would add keys the host does not read.

The documented keys are `name` (optional; the host falls back to the directory name) and
`disabled` (ship a plugin switched off). Cairn always writes `name`, so a rendered tree does not
depend on where it is unpacked.

Antigravity is the first target with a root-level manifest, and `agent import` had to learn it:
detection previously required a manifest _directory_, which made such a layout undetectable by
the one signal that settles a plugin layout outright.

## Hooks

`hooks.json`, at the **plugin root** — not under `hooks/`, which holds only the scripts. Hook
commands run with the working directory set to the directory containing `hooks.json`, so a
handler naming `./hooks/guard.sh` resolves correctly.

The document is a map of hook **name** to that name's events, which is how the host merges
several hook sets and lets any one of them be switched off with `"enabled": false`. Cairn keys
it by the bundle name.

| Portable event  | Native        | Handler shape                        |
| --------------- | ------------- | ------------------------------------ |
| `session-start` | —             | not expressible; reported as `AB320` |
| `pre-tool-use`  | `PreToolUse`  | grouped, with a tool-name `matcher`  |
| `post-tool-use` | `PostToolUse` | grouped, with a tool-name `matcher`  |
| `stop`          | `Stop`        | flat list of handler objects         |

**Antigravity nests only some of its events**, which is why the profile declares
`handlerShape: "nested-for-matcher-events"` with `matcherEvents` naming the two tool events. The
host also has `PreInvocation` and `PostInvocation`, which have no portable equivalent and are
reachable only through a native overlay.

There is no `SessionStart` in `hooks.json`. The binary does carry a `SessionStartHookArgs`
message, but it belongs to built-in and SDK hooks rather than to anything the file format can
declare, so the profile says `null` rather than inventing a name.

## Rules

`.agents/rules/<name>.md`, with a `trigger` frontmatter key: `always_on` for an
unconditionally-loaded rule and `model_decision` for one the model chooses. That is the host's
own progressive-disclosure distinction, and it maps cleanly onto the portable `always` and
`model` activations. `files` and `manual` activations render but are reported as `AB351`.

## Agents are not emitted

`paths.plugin.agents` and `paths.project.agents` are both `null`, and rendering a custom agent is
refused with `AB340` in either profile.

This is the deliberately conservative row. A plugin carries skills, rules, hooks and MCP config
and no agents directory at all, so the plugin half is certain. For the workspace half, the host
does have a subagent surface, but its on-disk layout could not be established from the shipped
documentation — and a wrong agent filename is exactly the failure this project cares most about:
it renders, it validates, and the host loads nothing. Express the behavior as a skill until the
layout is confirmed.

`features.agents.support` is `approximate` rather than `unsupported` because the renderer maps
the model and tool metadata before it reaches the `AB340` gate, so `AB330` and `AB332` can still
be emitted — and a diagnostic may never outrank its feature's declared support.

## Command policies are not supported

`policies.form` is `null` and a policy is reported with `AB361` rather than written. Antigravity
has global allow/deny/ask permissions in `settings.json`, but their shape is not documented and a
prompt rule is not a security boundary. This is the same answer Cursor gives.

## MCP

`mcp_config.json`, in the plugin root or under `.agents/`, in both cases pass-through.

## Placeholders

`arguments: "prose"`, so `$ARGUMENTS` is replaced with explanatory text and `AB302` reports it —
the same treatment Codex gets. Antigravity's slash-command surface was `workflows/`, which the
host has deprecated in favour of skills, and nothing documents argument substitution in a skill.

There are no root variables: `${BUNDLE_ROOT}` becomes `.` in both profiles.

## Install

| Scope   | Root                       | Layout       | Activation |
| ------- | -------------------------- | ------------ | ---------- |
| user    | `~/.gemini/config/plugins` | `plugin-dir` | none       |
| project | `.`                        | `merge`      | none       |

Most discovered plugins are enabled by default, so dropping a plugin directory into the global
customization root needs no activation edit. A user's explicit choice is recorded in
`config.json` under a `plugins` map and always wins, which is the host's business rather than
Cairn's.

## There is no marketplace spec

`agy plugin install <plugin>@<marketplace>` exists, but neither the catalog filename nor its
entry schema could be established. `marketplace` is therefore left undefined and
[`agent package`](../../commands/agent/package.md) skips this target rather than inventing a
catalog format.

## Unverified rows

Everything above comes from the host's own documentation except these, which are declared at the
honest support level and should be confirmed against a live install before being relied on:

- that `.agents/mcp_config.json` loads at workspace scope — the quick-reference table implies it,
  while the MCP guide names only the global and plugin locations
- that rules support glob activation at all; `files` is declared **approximate** on that basis
- that no skill frontmatter key controls implicit activation, so `AB310` is emitted rather than a
  policy written
- that skills do not substitute `$ARGUMENTS`
- that `plugin.json` tolerates the `version` and `description` keys Cairn writes alongside `name`
- the workspace subagent layout, which is why agents are not emitted at all

## Related

- [Target profile format](../../formats/target-profile.md)
- [Gemini CLI: agent bundles](../gemini-cli/agent-bundles.md) — the other host under `~/.gemini`
- [`agent convert`](../../commands/agent/convert.md), [`agent specs`](../../commands/agent/specs.md)
