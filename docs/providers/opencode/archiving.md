# OpenCode: archiving

Declared by the `opencode` entry in `src/archive/sets.ts`. The log root comes from the usage
provider, so the archive covers `$XDG_DATA_HOME/opencode`.

## Artifact sets

| Set             | Class      | Matches                              |
| --------------- | ---------- | ------------------------------------ |
| `session-diffs` | `artifact` | `storage/**/*.json`                  |
| `logs`          | `log`      | `log/*.log`                          |
| `snapshots`     | `log`      | `snapshot/**`                        |
| `database`      | `log`      | `opencode.db`, via a SQLite snapshot |

## There is no plan class

OpenCode writes no plan document to the data directory: plan-mode output lives in the message
stream. That is the same answer Codex gives, and it is a fact about the host rather than a gap.

## The transcripts are inside a `log`-class database

This is the first provider whose entire transcript corpus lives in a single file, because the
conversations are rows in `opencode.db`. There is no per-session transcript to select, so
archiving the database archives them all — which is exactly why that set is `log` and therefore
opt-in, like every other transcript source.

## `snapshot/` is a log, not an artifact

Each entry is a **bare git repository** holding pre-edit file state, not loose session output. It
is the same category as Claude Code's `file-history/`, which is excluded outright. Keeping it as
an opt-in `log` is the compromise: unlike `file-history/` it is the only record of what a file
looked like before an edit, but it must never land in a default run.

`repos/` is not archived at all: its contents are clones, and a clone is re-fetchable.

## SQLite snapshotting

`opencode.db` carries live `-wal` and `-shm` sidecars, so copying the main file alone can capture
a torn page image. The set declares `snapshot: "sqlite"`, which routes it through the online
backup API and folds the sidecars in. The matcher is an exact equality test, so the sidecars are
never picked up on their own.

## Prompt history is out of reach

`$XDG_STATE_HOME/opencode/prompt-history.jsonl` holds the typed prompt history, and it is **not**
archived. An `ArchiveProfile`'s sets are all relative to the one log root the usage provider
resolves, and that file is under a different XDG base directory. Widening the root to reach it
would bring the rest of the state directory with it.

## Related

- [Shared archive command behavior](../../commands/archive/common.md)
- [Usage logs](usage-logs.md) — the same database, read for its contents
