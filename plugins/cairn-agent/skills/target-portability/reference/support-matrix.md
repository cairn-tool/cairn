# Component support at a glance

A **summary**, refreshed by hand, for when you cannot reach the published documentation.
`cairn agent specs --format json` is generated from the profiles the renderer reads and cannot
go stale — prefer it whenever the answer matters.

## Support by component and target

| Component      | claude-code      | codex            | cursor         | antigravity      | opencode         |
| -------------- | ---------------- | ---------------- | -------------- | ---------------- | ---------------- |
| `skills`       | exact            | exact            | approx         | exact            | exact            |
| `agents`       | exact            | approx (project) | approx         | —                | approx           |
| `rules`        | exact (project)  | approx (project) | exact          | approx (project) | approx (project) |
| `hooks`        | exact (plugin)   | exact (plugin)   | exact (plugin) | approx (plugin)  | —                |
| `policies`     | approx (project) | approx (project) | —              | —                | —                |
| `mcp`          | exact            | approx           | exact          | exact            | approx           |
| `assets`       | exact            | exact            | exact          | exact            | exact            |
| `placeholders` | exact            | approx           | approx         | approx           | approx           |
| `native`       | native           | native           | native         | native           | native           |

`approx` means the mapping renders and reports what it gave up. `—` means there is no native
surface and nothing is emitted. A profile in parentheses is the **only** profile that emits
that component for that target.

## What the parenthesised profiles mean in practice

- **Rules are project-only on three targets, and hooks are plugin-only on four.** A bundle that
  ships one profile silently drops one of them. Render `--profile both` unless you have decided
  otherwise.
- **Antigravity emits no subagents, and OpenCode emits no hooks.** Not approximated — nothing is
  written at all.
- **Only Claude Code and Codex have any command-policy surface**, and both approximate it.
  A policy is never a security boundary.

## Where a component goes

Regenerate with `cairn agent specs --target all --format json`, reading `outputs`.

| Target        | Plugin profile                                                                                                            | Project profile                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `.claude-plugin/plugin.json`, `skills/{name}/**`, `agents/{name}.md`, `hooks/**`, `.mcp.json`                             | `.claude/skills/{name}/**`, `.claude/agents/{name}.md`, `.claude/rules/{name}.md`, `.claude/settings.json`, `.mcp.json`      |
| `codex`       | `.codex-plugin/plugin.json`, `skills/{name}/**`, `hooks/**`, `.mcp.json`                                                  | `.agents/skills/{name}/**`, `.codex/agents/{name}.toml`, `AGENTS.md`, `.codex/rules/bundle.rules`, `.codex/config.toml`      |
| `cursor`      | `.cursor-plugin/plugin.json`, `skills/{name}/**`, `agents/{name}.md`, `.cursor/rules/{name}.mdc`, `hooks/**`, `.mcp.json` | `.cursor/skills/{name}/**`, `.cursor/agents/{name}.md`, `.cursor/rules/{name}.mdc`, `.cursor/hooks.json`, `.cursor/mcp.json` |
| `antigravity` | `plugin.json`, `skills/{name}/**`, `hooks.json`, `hooks/**`, `mcp_config.json`                                            | `.agents/skills/{name}/**`, `.agents/rules/{name}.md`, `.agents/mcp_config.json`                                             |
| `opencode`    | `.opencode-plugin/plugin.json`, `skills/{name}/**`, `agent/{name}.md`, `.mcp.json`                                        | `.opencode/skills/{name}/**`, `.opencode/agent/{name}.md`, `AGENTS.md`, `opencode.json`                                      |

`assets/**` is emitted by every target in both profiles, which is why it never helps identify a
layout.

## Three shapes that are not what you expect

- **Codex subagents are TOML**, at `.codex/agents/{name}.toml`, and project-scope only.
- **Cursor inlines a skill into its agents** rather than emitting a separate skills document.
- **Antigravity's plugin manifest sits at the plugin root** (`plugin.json`, no manifest
  directory) and its hook document sits _beside_ the script root (`hooks.json` next to
  `hooks/`).

Those three are the deliberate exceptions to "target behaviour is data": everything else the
renderer decides by reading the profile.

## Placeholders

| Canonical        | Translated where the host has an equivalent                    |
| ---------------- | -------------------------------------------------------------- |
| `${BUNDLE_ROOT}` | The host's plugin-root variable, or its project-root variable. |
| `${ARGUMENTS}`   | The host's own substitution, natively where one exists.        |
| `${SKILL_DIR}`   | The host's skill-directory variable.                           |

Only Claude Code is `exact` for placeholders. Everywhere else at least one has no equivalent and
is replaced with explanatory prose (`AB302`) rather than left as a literal that would never
expand.
