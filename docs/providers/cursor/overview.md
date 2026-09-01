# Cursor

An editor rather than a CLI, and the only provider whose files live in two unrelated trees:
a small configuration directory at `~/.cursor`, and the Electron user-data directory holding
the conversation store.

| Role              | Supported | Identifier | Declared in                     |
| ----------------- | --------- | ---------- | ------------------------------- |
| Conversion target | yes       | `cursor`   | `src/agent/targets/cursor.ts`   |
| Usage log source  | yes       | `cursor`   | `src/usage/providers/cursor.ts` |
| Archive source    | yes       | `cursor`   | `src/archive/sets.ts`           |

## Where things live

Cairn **writes** to two Cursor surfaces:

```text
~/.cursor/plugins/local/<bundle>/      user-scope plugin install

<project>/
  .cursor/skills/<name>/SKILL.md
  .cursor/agents/<name>.md
  .cursor/rules/<name>.mdc
  .cursor/hooks.json
  .cursor/mcp.json
```

A plugin-profile render also emits `.cursor/rules/<name>.mdc` **inside the plugin tree**, which
is the one place a rule reaches a Cursor plugin at all.

And **reads** from two trees, which is what makes this provider unusual:

```text
<user data>/                       ~/Library/Application Support/Cursor on macOS,
                                   %APPDATA%/Cursor on Windows, ~/.config/Cursor on Linux
  User/globalStorage/state.vscdb   conversations, turns, tokens, models  (usage + archive)
  User/workspaceStorage/*/state.vscdb  legacy inline-edit prompt history (archive)

~/.cursor/
  plans/*.plan.md                             plan documents            (archive)
  projects/<slug>/agent-transcripts/**/*.jsonl agent transcripts        (archive)
  projects/<slug>/{canvases,uploads,assets}/  files a session produced  (archive)
  ai-tracking/ai-code-tracking.db             per-model line attribution (archive)
```

The token counters are in the first tree and the session output is in the second, and on macOS
the two share only `$HOME`. That is why the archive profile is the only one with a second root.

## Host profile

| Field                   | Value              |
| ----------------------- | ------------------ |
| `displayName`           | `Cursor`           |
| `documentationRevision` | `2026-08-02`       |
| `minimumVersion`        | not recorded       |
| `verifiedThrough`       | not recorded       |
| `versionCommand`        | `cursor --version` |
| `nativeValidator`       | none declared      |

## Pages

- [Agent bundles](agent-bundles.md) — the conversion target profile in full
- [Usage logs](usage-logs.md) — the editor store, and the token cutoff
- [Archiving](archiving.md) — the artifact sets, across both trees

## Caveats worth knowing up front

- **Plugin skill directories are namespaced** as `skills/<bundle>-<skill>/`. Cursor is the only
  target that does this, and it is why its `skills` feature is `approximate` rather than
  `exact` despite otherwise rendering identically.
- **The hook document has a different shape** from Claude Code's and Codex's: camelCase event
  names, a `{ version: 1, hooks }` envelope, and flat handlers with no `{ matcher, hooks: [] }`
  nesting.
- **Command policies are unsupported.** Cursor has no permission surface; a policy converts
  only through an explicit hook override, and is otherwise reported and dropped.
- **Cursor stopped writing token counters.** The figures it did write are real per-request
  input and output, but every nonzero one on a real corpus predates 2025-12-23; newer
  conversations settle usage server-side. A window after that reports sessions and tools with no
  tokens, which is correct — see [Usage logs](usage-logs.md).
- **The conversation index is incomplete, so it is not what discovery uses.** `composerHeaders`
  was never backfilled, and on a real store 161 of the 229 token-bearing conversations appear in
  neither it nor the legacy index it replaced.
- **The two trees are why the archive profile needs a second root.** It is the only one that
  does; see [Archiving](archiving.md).
