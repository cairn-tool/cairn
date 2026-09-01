# Cursor: archiving

Declared in `src/archive/sets.ts` as the `cursor` profile.

Cursor is the only provider whose sets span **two trees**, and the only one that needs an
`altRoot`. Everywhere else the usage provider's log root already contains everything worth
archiving; here it does not.

## Why two trees

An `ArchiveProfile` names a `UsageProvider`, and that provider's `root()` is what every set is
relative to. Cursor's [usage provider](usage-logs.md) roots at the Electron user-data directory,
because that is where the conversation store is — but Cursor writes its plans, its agent
transcripts and its per-session output under `~/.cursor` instead.

On macOS those two share only `$HOME`, and rooting a set at `$HOME` is precisely the
home-directory sweep the archive design forbids. So the profile declares the second tree
explicitly and each set says which one it belongs to:

```ts
altRoot?(context: ProviderEnvironment): string | null;   // on ArchiveProfile
tree?: "alt";                                            // on ArtifactSet
```

Both fields are optional and absent everywhere else, so the other five profiles are unchanged. A
set marked `tree: "alt"` contributes **nothing** when the second tree is absent, rather than
falling back to the primary root and walking the wrong one. `--logs` deliberately does not
redirect the alternate tree: it names the log root, and one directory cannot be both.

## Sets

| Set               | Class      | Tree        | What it takes                                          |
| ----------------- | ---------- | ----------- | ------------------------------------------------------ |
| `plans`           | plan       | `~/.cursor` | `plans/*.plan.md`                                      |
| `project-assets`  | artifact   | `~/.cursor` | `projects/**` under `canvases/`, `uploads/`, `assets/` |
| `transcripts`     | transcript | `~/.cursor` | `projects/**/agent-transcripts/**/*.jsonl`             |
| `ai-tracking`     | log        | `~/.cursor` | `ai-tracking/ai-code-tracking.db`                      |
| `hooks`           | log        | `~/.cursor` | `hooks.json`                                           |
| `conversations`   | log        | user data   | `User/globalStorage/state.vscdb`                       |
| `workspace-state` | log        | user data   | `User/workspaceStorage/*/state.vscdb`                  |

The agent transcripts are archived even though `usage` cannot read them: they carry no tokens, no
timestamps and no model, but they are the only human-readable record of what was said, and the
store that does carry the structure is opaque.

`ai-code-tracking.db` is the one live source of per-model attribution Cursor still writes — code
hashes tagged with `model` and `conversationId`, and per-commit AI percentages. It is line-based
rather than token-based, so it answers a different question than `usage` does, but it is the
question Cursor can still answer.

`workspace-state` is depth-checked so that only the store directly under a workspace directory
matches. Those hold the legacy inline-edit prompt history (`aiService.generations`,
`aiService.prompts`), which is this host's equivalent of another provider's `history.jsonl`.

## Live databases

All three `.db`/`.vscdb` sets are marked `snapshot: "sqlite"`. The editor store runs in WAL mode
with live `-wal` and `-shm` sidecars, so copying the main file alone can capture a page image torn
mid-write, and a `.vscdb` without its `-wal` may be missing recent writes entirely. The
[online backup API](../../commands/archive/common.md#live-databases) produces one consistent file
and folds the sidecars into it; they are never archived beside it.

`conversations` matches by **exact equality**, which is load-bearing three times over. It keeps
out the two sidecars, and it keeps out `state.vscdb.backup` — on a real machine a stale 3.4 GB
copy months out of date, which a suffix match would have doubled the archive to store.

## What is deliberately excluded

The allowlist matters more here than for any other provider, because this is an editor and most
of both trees is not conversation data:

| Excluded                                                                            | Why                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.cursor/extensions/`                                                             | 3.8 GB of re-downloadable third-party code                                                                                                             |
| `CachedData/`, `Partitions/`, `WebStorage/`, `Cache/`, `GPUCache/`, `blob_storage/` | ~600 MB of derived browser state                                                                                                                       |
| `User/History/`                                                                     | VS Code's local file history: it mirrors the working tree rather than recording a session, the same category as Claude Code's excluded `file-history/` |
| `~/.cursor/projects/**/terminals/`                                                  | Captured terminal buffers, unbounded                                                                                                                   |
| `~/.cursor/worktrees/`, `browser-logs/`                                             | Working copies and browser noise                                                                                                                       |
| `~/.config/cursor/cli-config.json`                                                  | Holds `authInfo` — a credential, kept out of reach exactly as `gemini-cli` keeps `oauth_creds.json`                                                    |

Every matcher names a directory segment or a filename, so none of that is reachable.

## Size, and why the store is opt-in

The editor store is 5.65 GB on its own — larger than every other provider's entire corpus put
together. It is class `log`, so it never lands in a default `archive run`; a default run here
takes the plans and the produced files, roughly 6 MB.

> **The store contains credentials.** `ItemTable` holds `cursorAuth/accessToken` and
> `cursorAuth/refreshToken`. Codex and Antigravity already archive whole databases, and this set
> is opt-in, but Cursor's is a _known_ credential store rather than an incidental one — so
> `archive run --include logs` for this provider puts live tokens into the archive. Treat an
> archive containing it as a secret.

## Related

- [Shared archive command behavior](../../commands/archive/common.md)
- [Archive store format](../../formats/archive-store.md)
- [Usage logs](usage-logs.md) — the provider whose root this profile hangs off
