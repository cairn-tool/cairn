# What lives where

Read this at step 1, to name what a repository already has.

Every path below is one a target profile declares, so this table is the exact inverse of what
`agent convert` emits — and it is what `agent import` scores a tree against. The **Decides**
column is the one that matters: a path only narrows the layout when exactly one target/profile
cell declares it. `assets/**` is declared by all ten cells and settles nothing.

## Claude Code

`--from claude-code`. Profiles: plugin, project.

| Path                         | Profile | Holds    | Decides       |
| ---------------------------- | ------- | -------- | ------------- |
| `.claude-plugin/plugin.json` | plugin  | manifest | yes           |
| `skills/{name}/**`           | plugin  | skills   | no (5 cells)  |
| `agents/{name}.md`           | plugin  | agents   | no (2 cells)  |
| `hooks/**`                   | plugin  | hooks    | no (4 cells)  |
| `.mcp.json`                  | plugin  | mcp      | no (5 cells)  |
| `assets/**`                  | plugin  | assets   | no (10 cells) |
| `.claude/skills/{name}/**`   | project | skills   | yes           |
| `.claude/agents/{name}.md`   | project | agents   | yes           |
| `.claude/rules/{name}.md`    | project | rules    | yes           |
| `.claude/settings.json`      | project | policies | yes           |
| `.mcp.json`                  | project | mcp      | no (5 cells)  |
| `assets/**`                  | project | assets   | no (10 cells) |

## Codex

`--from codex`. Profiles: plugin, project.

| Path                        | Profile | Holds    | Decides       |
| --------------------------- | ------- | -------- | ------------- |
| `.codex-plugin/plugin.json` | plugin  | manifest | yes           |
| `skills/{name}/**`          | plugin  | skills   | no (5 cells)  |
| `hooks/**`                  | plugin  | hooks    | no (4 cells)  |
| `.mcp.json`                 | plugin  | mcp      | no (5 cells)  |
| `assets/**`                 | plugin  | assets   | no (10 cells) |
| `.agents/skills/{name}/**`  | project | skills   | no (2 cells)  |
| `.codex/agents/{name}.toml` | project | agents   | yes           |
| `AGENTS.md`                 | project | rules    | no (2 cells)  |
| `.codex/rules/bundle.rules` | project | policies | yes           |
| `.codex/config.toml`        | project | mcp      | yes           |
| `assets/**`                 | project | assets   | no (10 cells) |

## Cursor

`--from cursor`. Profiles: plugin, project.

| Path                         | Profile | Holds    | Decides       |
| ---------------------------- | ------- | -------- | ------------- |
| `.cursor-plugin/plugin.json` | plugin  | manifest | yes           |
| `skills/{name}/**`           | plugin  | skills   | no (5 cells)  |
| `agents/{name}.md`           | plugin  | agents   | no (2 cells)  |
| `.cursor/rules/{name}.mdc`   | plugin  | rules    | no (2 cells)  |
| `hooks/**`                   | plugin  | hooks    | no (4 cells)  |
| `.mcp.json`                  | plugin  | mcp      | no (5 cells)  |
| `assets/**`                  | plugin  | assets   | no (10 cells) |
| `.cursor/skills/{name}/**`   | project | skills   | yes           |
| `.cursor/agents/{name}.md`   | project | agents   | yes           |
| `.cursor/rules/{name}.mdc`   | project | rules    | no (2 cells)  |
| `.cursor/hooks.json`         | project | policies | yes           |
| `.cursor/mcp.json`           | project | mcp      | yes           |
| `assets/**`                  | project | assets   | no (10 cells) |

## Antigravity

`--from antigravity`. Profiles: plugin, project.

| Path                       | Profile | Holds    | Decides       |
| -------------------------- | ------- | -------- | ------------- |
| `plugin.json`              | plugin  | manifest | yes           |
| `skills/{name}/**`         | plugin  | skills   | no (5 cells)  |
| `hooks.json`               | plugin  | hooks    | yes           |
| `hooks/**`                 | plugin  | hooks    | no (4 cells)  |
| `mcp_config.json`          | plugin  | mcp      | yes           |
| `assets/**`                | plugin  | assets   | no (10 cells) |
| `.agents/skills/{name}/**` | project | skills   | no (2 cells)  |
| `.agents/rules/{name}.md`  | project | rules    | yes           |
| `.agents/mcp_config.json`  | project | mcp      | yes           |
| `assets/**`                | project | assets   | no (10 cells) |

## OpenCode

`--from opencode`. Profiles: plugin, project.

| Path                           | Profile | Holds    | Decides       |
| ------------------------------ | ------- | -------- | ------------- |
| `.opencode-plugin/plugin.json` | plugin  | manifest | yes           |
| `skills/{name}/**`             | plugin  | skills   | no (5 cells)  |
| `agent/{name}.md`              | plugin  | agents   | yes           |
| `.mcp.json`                    | plugin  | mcp      | no (5 cells)  |
| `assets/**`                    | plugin  | assets   | no (10 cells) |
| `.opencode/skills/{name}/**`   | project | skills   | yes           |
| `.opencode/agent/{name}.md`    | project | agents   | yes           |
| `AGENTS.md`                    | project | rules    | no (2 cells)  |
| `opencode.json`                | project | mcp      | yes           |
| `assets/**`                    | project | assets   | no (10 cells) |

## The ambiguity you will actually hit

A project tree holding **only** `.agents/skills/<name>/` scores equally for Antigravity and
Codex: both declare that exact path, so nothing decides. `agent import` throws naming both
candidates rather than guessing, which is the designed behaviour.

Settle it with `--from`, using what else is in the tree as evidence:

| Also present                                              | It is       |
| --------------------------------------------------------- | ----------- |
| `.agents/rules/<name>.md`, `.agents/mcp_config.json`      | Antigravity |
| `.codex/` anything, `AGENTS.md` with `.codex/config.toml` | Codex       |

## Shapes that are not Markdown

Three surfaces are not a Markdown document with frontmatter, so a hand-written one will not
look like the others:

- **Codex subagents are TOML** (`.codex/agents/<name>.toml`), and are project-scope only —
  Codex declares no plugin-scope agents root at all.
- **Cursor inlines a skill into its agents** rather than keeping them separate.
- **Antigravity's hook document sits beside its script root** (`hooks.json` next to `hooks/`),
  not inside it, and its plugin manifest sits at the plugin root rather than in a manifest
  directory.

## Two paths that are probably somebody else's

`AGENTS.md` at a repository root is Codex's and OpenCode's rules surface — and it is also, very
often, a hand-written file the repository maintains for its own sake. Importing it turns prose
into a rule component, and regenerating then overwrites the original. Decide deliberately. If it
is hand-maintained, keep it out of the bundle **and** out of any later `agent verify` entry,
because a declared path is compared byte for byte.

`.mcp.json` is frequently machine-local rather than checked in. Check `.gitignore` before
importing one.

## Regenerating this table

```bash
cairn agent specs --target all --format json
```

The profiles are the source of truth; this page is a convenience copy of `outputs`.
