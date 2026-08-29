# Claude Code

Anthropic's CLI. It is the one host that fills all three roles: Cairn renders bundles for it,
reads its session logs, and archives what it leaves behind.

| Role              | Supported | Identifier    | Declared in                          |
| ----------------- | --------- | ------------- | ------------------------------------ |
| Conversion target | yes       | `claude-code` | `src/agent/targets/claude-code.ts`   |
| Usage log source  | yes       | `claude-code` | `src/usage/providers/claude-code.ts` |
| Archive source    | yes       | `claude-code` | `src/archive/sets.ts`                |

It is also the **default** for both `usage` and `archive`: a `usage summary` with no
`--provider` reports Claude Code, and `archive run` with no `--provider` walks every registered
provider that is present.

## Where things live

Claude Code keeps everything under one root, `$CLAUDE_CONFIG_DIR` when that is set and
`~/.claude` otherwise. The same root serves all three roles.

```text
~/.claude/
  projects/<slug>/<session-uuid>.jsonl                        session transcript
  projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl    subagent transcript
  projects/<slug>/<session-uuid>/subagents/agent-<id>.meta.json
  projects/<slug>/.../tool-results/                            files tools produced
  projects/<slug>/.../memory/*.md                              per-project memory
  plans/*.md                                                   plan-mode documents
  shell-snapshots/*.sh                                         captured shell environments
  history.jsonl                                                prompt history
  daemon.log
  settings.json                                                user settings, incl. enabled plugins
  plugins/marketplaces/<name>/                                 installed local marketplaces
```

`<slug>` is the session's working directory with the path separators replaced. The replacement
is lossy in both directions — it also substitutes underscores — so **project identity is never
read from the directory name**. It comes from the `cwd` field inside the records.

Rendered project-scope output lands in a workspace rather than the home directory:

```text
<project>/
  .claude/skills/<name>/SKILL.md
  .claude/agents/<name>.md
  .claude/rules/<name>.md
  .claude/settings.json
  .mcp.json
```

## Discovery rules

| Consumer                        | Root                                                             | Override       |
| ------------------------------- | ---------------------------------------------------------------- | -------------- |
| `usage`                         | `$CLAUDE_CONFIG_DIR`, else `~/.claude`; must contain `projects/` | `--logs <dir>` |
| `archive`                       | The same root, resolved through the usage provider               | `--logs <dir>` |
| `agent install --scope user`    | `~/.claude/plugins/marketplaces`                                 | —              |
| `agent install --scope project` | the working tree                                                 | `--output`     |

A root that exists but has no `projects/` directory reports as absent rather than as an error,
so a machine that has never run Claude Code simply has no Claude Code data.

## Host profile

The target profile records what it was written against. These are data fields, and filling
them in later is an edit rather than a code change.

| Field                   | Value              |
| ----------------------- | ------------------ |
| `displayName`           | `Claude Code`      |
| `documentationRevision` | `2026-08-02`       |
| `minimumVersion`        | not recorded       |
| `verifiedThrough`       | not recorded       |
| `versionCommand`        | `claude --version` |
| `nativeValidator`       | none declared      |

`versionCommand` is declared for a **caller** to run. Cairn never executes it: `agent doctor`
must give the same answer on a machine that has Claude Code installed and one that does not.

## Pages

- [Agent bundles](agent-bundles.md) — the conversion target profile in full
- [Usage logs](usage-logs.md) — the transcript format and what is counted
- [Archiving](archiving.md) — which files `archive run` collects

## Caveats worth knowing up front

- **One API response is written as several JSONL lines**, each carrying a complete copy of the
  same `message.usage`. Summing lines over-counts output tokens roughly two and a half fold.
  See [Usage logs](usage-logs.md#the-response-fan-out).
- **`session_id` and `sessionId` both appear, with different values.** The snake-case one is
  stale. Key on `sessionId`.
- **Subagent transcripts outnumber main transcripts about six to one** and hold more bytes.
  They are scanned by default; excluding them makes every headline number a main-thread figure.
- **The plugin manifest must not declare `agents` or `hooks`.** Claude Code derives both from
  the plugin layout, and naming them breaks the manifest or silently drops the hooks. See
  [Agent bundles](agent-bundles.md#implied-manifest-fields).
