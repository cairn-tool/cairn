# Codex: archiving

Archive profile `codex`, declared in `src/archive/sets.ts`. The log root is resolved through
the usage provider, so it is `$CODEX_HOME` or `~/.codex`.

## Artifact sets

| Set            | Class        | Root           | Recursive | Matches           | Snapshot |
| -------------- | ------------ | -------------- | --------- | ----------------- | -------- |
| `computer-use` | `artifact`   | `computer-use` | yes       | everything        | —        |
| `transcripts`  | `transcript` | `sessions`     | yes       | `rollout-*.jsonl` | —        |
| `history`      | `log`        | root           | no        | `history.jsonl`   | —        |
| `databases`    | `log`        | root           | no        | `*.sqlite`        | `sqlite` |

## Codex writes no plans

There is no `plan`-class set. Codex has no plan-mode document surface, so an `archive run` with
the default `--include plans,artifacts` collects only the `computer-use` set from Codex.

That is worth stating explicitly, because a default run against a machine that uses Codex
heavily and Claude Code lightly can look as though the archive missed something. It did not;
Codex's durable output is the transcript, which is opt-in.

## SQLite snapshotting

The `databases` set declares `snapshot: "sqlite"`. Every Codex `.sqlite` file carries live
`-wal` and `-shm` sidecars, so copying the main file alone can capture a torn page image —
a file that is byte-complete but not a valid database.

`snapshot: "sqlite"` routes the read through SQLite's online backup API instead, which produces
a consistent snapshot of a database that is being written to and folds the WAL contents into
it. The sidecars themselves are never archived; they are state belonging to the file next to
them, not content.

## Related

- [Shared archive command behavior](../../commands/archive/common.md)
- [Archive store format](../../formats/archive-store.md)
- [`archive run`](../../commands/archive/run.md)
