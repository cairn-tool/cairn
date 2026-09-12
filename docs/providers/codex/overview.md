# Codex

OpenAI's Codex CLI. Like Claude Code, it fills all three roles, but with materially different
formats in each: its plugin surface is thinner, its transcripts report cumulative totals rather
than per-request ones, and it writes no plan documents at all.

| Role              | Supported | Identifier | Declared in                    |
| ----------------- | --------- | ---------- | ------------------------------ |
| Conversion target | yes       | `codex`    | `src/agent/targets/codex.ts`   |
| Usage log source  | yes       | `codex`    | `src/usage/providers/codex.ts` |
| Archive source    | yes       | `codex`    | `src/archive/sets.ts`          |

## Where things live

`$CODEX_HOME` when set, `~/.codex` otherwise.

```text
~/.codex/
  sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl   thread transcript
  computer-use/                                                  screenshots and captures
  history.jsonl                                                  prompt history
  *.sqlite                                                       thread history and log databases
  hooks.json                                                     hook configuration
  config.toml                                                    MCP and settings
  marketplaces/<name>/                                          Cairn-managed local marketplace sources
```

**The `YYYY/MM/DD` directories and the filename stamp are local time; every timestamp inside a
record is UTC.** Days are therefore always taken from the records. The path is used only as a
cache shard key, where it is a naming convention rather than a fact.

Rendered project-scope output:

```text
<project>/
  .agents/skills/<name>/SKILL.md
  .codex/agents/<name>.toml
  .codex/rules/bundle.rules
  .codex/config.toml
  AGENTS.md
```

## Discovery rules

| Consumer                        | Root                                                     | Override       |
| ------------------------------- | -------------------------------------------------------- | -------------- |
| `usage`                         | `$CODEX_HOME`, else `~/.codex`; must contain `sessions/` | `--logs <dir>` |
| `archive`                       | The same root, resolved through the usage provider       | `--logs <dir>` |
| `agent install --scope user`    | `$CODEX_HOME/marketplaces`, else `~/.codex/marketplaces` | `--into`       |
| `agent install --scope project` | the working tree                                         | `--into`       |

User scope installs the plugin marketplace layout and activates it through `codex plugin` when
`--register` is given. Project scope remains a direct merge. The user flow therefore never writes
the project-only `AGENTS.md` surface into the home directory.

## Host profile

| Field                   | Value             |
| ----------------------- | ----------------- |
| `displayName`           | `Codex`           |
| `documentationRevision` | `2026-09-12`      |
| `minimumVersion`        | not recorded      |
| `verifiedThrough`       | `0.154.0`         |
| `versionCommand`        | `codex --version` |
| `nativeValidator`       | none declared     |

## Pages

- [Agent bundles](agent-bundles.md)
- [Usage logs](usage-logs.md)
- [Archiving](archiving.md)

## Caveats worth knowing up front

- **Token usage is a running total per thread**, not a per-request figure. Consecutive readings
  are differenced. The per-request field beside it (`last_token_usage`) is re-emitted unchanged
  on duplicate events, and summing it inflates the total by roughly 4%.
- **`input_tokens` includes `cached_input_tokens`**, unlike Claude Code's. The cached part is
  subtracted out; leaving it merged overstates Codex input roughly eight-fold.
- **Subagent status is recorded inside the file**, not in its path, so `--no-subagents` filters
  after reading rather than before.
- **Hooks are configured but never recorded.** `~/.codex/hooks.json` exists; no execution of a
  hook appears in any rollout file, so the provider declares `hooks: false` rather than
  reporting zero.
- **Codex has no model field for agents**, no native argument substitution, and no plugin-scope
  agents root. Each of those is a declared approximation, not a silent drop.
