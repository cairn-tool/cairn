# Antigravity: archiving

Archive profile `antigravity`, declared in `src/archive/sets.ts`. The log root is resolved
through the usage provider, so it is `~/.gemini/antigravity-cli`.

## Artifact sets

| Set             | Class        | Root            | Recursive | Matches                                     | Snapshot |
| --------------- | ------------ | --------------- | --------- | ------------------------------------------- | -------- |
| `plans`         | `plan`       | `brain`         | yes       | `*.md` **not** under `.system_generated`    | —        |
| `outputs`       | `artifact`   | `brain`         | yes       | non-`.md` **not** under `.system_generated` | —        |
| `transcripts`   | `transcript` | `brain`         | yes       | `*/logs/transcript.jsonl`                   | —        |
| `history`       | `log`        | root            | no        | `history.jsonl`                             | —        |
| `logs`          | `log`        | `log`           | no        | `*.log`                                     | —        |
| `conversations` | `log`        | `conversations` | no        | `*.db`                                      | `sqlite` |

## One directory name separates output from machinery

`brain/<id>/` holds `.system_generated/` — the machinery — and, at its top level, whatever the
session actually produced: `implementation_plan.md`, `walkthrough.md`, `task.md`, generated
scripts.

Every `brain` set therefore tests for that one directory name rather than listing filenames.
That is what lets `plans` and `outputs` collect a file the tool has never seen before, which is
the point: a session's output is not a fixed set of names.

The split between the two is just the extension: `.md` is a plan, anything else is an output.
Both are default-included classes, so a default `archive run` captures a conversation's
durable work without touching its transcript.

## `transcript_full.jsonl` is not archived

The `transcripts` set matches `*/logs/transcript.jsonl` only. `transcript_full.jsonl` shares
the same schema and differs only in whether long strings are truncated, so archiving both would
store the same conversation twice for no extra structural fact.

Note that this differs from the deduplication the archive does anyway: the two files have
different bytes, so content-addressing would **not** collapse them. Excluding one is a
selection decision, not a storage one.

## SQLite snapshotting

The `conversations` set declares `snapshot: "sqlite"`. All 501 `.db` files on the reference
corpus carry live `-wal` sidecars, so copying a main file alone can capture a torn page image.
The read goes through SQLite's online backup API instead, producing a consistent snapshot with
the WAL contents folded in.

The `-wal` and `-shm` files are never archived themselves — they are state belonging to the
file next to them, and the snapshot already contains what they held.

## Class placement

`conversations` is classed `log` rather than `transcript`, even though it is where the tokens
live. The reason is size and default behavior: `transcript` and `log` are both opt-in, so the
distinction changes nothing about what a default run collects, and grouping the databases with
the other machinery keeps `--include transcripts` meaning "the conversation text".

To archive everything Antigravity holds, use `--include plans,artifacts,transcripts,logs`.

## Related

- [Shared archive command behavior](../../commands/archive/common.md)
- [Archive store format](../../formats/archive-store.md)
- [Usage logs](usage-logs.md) — the same files, read rather than kept
