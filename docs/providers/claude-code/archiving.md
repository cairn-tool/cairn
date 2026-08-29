# Claude Code: archiving

Archive profile `claude-code`, declared in `src/archive/sets.ts`. The log root is resolved
through the usage provider, so it is the same `$CLAUDE_CONFIG_DIR` or `~/.claude`.

## Artifact sets

| Set               | Class        | Root              | Recursive | Matches                                |
| ----------------- | ------------ | ----------------- | --------- | -------------------------------------- |
| `plans`           | `plan`       | `plans`           | no        | `*.md`                                 |
| `tool-results`    | `artifact`   | `projects`        | yes       | any path with a `tool-results` segment |
| `memory`          | `artifact`   | `projects`        | yes       | `*.md` under a `memory` segment        |
| `transcripts`     | `transcript` | `projects`        | yes       | `*.jsonl`, plus `agent-*.meta.json`    |
| `history`         | `log`        | root              | no        | `history.jsonl`, `daemon.log`          |
| `shell-snapshots` | `log`        | `shell-snapshots` | no        | `*.sh`                                 |

`plan` and `artifact` are archived by default. `transcript` and `log` are opt-in via
`--include`, because they are three orders of magnitude larger: on a real corpus the first two
are roughly 150 MB and the full set is over 9 GB.

The `tool-results` walk goes seven directories deep on a real corpus — deeper than the usage
provider's own discovery, which descends only into `subagents/`.

## What is deliberately excluded

Selection is an **allowlist of directories**, not a filter over the home directory, and that is
the design. `~/.claude` alone holds:

- `plugins/` — 340 MB of plugin payloads, all re-downloadable
- `downloads/` — a 71 MB binary
- `backups/` and `file-history/` — derived from files that still exist
- `jobs/` — a scratch tree for background work, which on one real machine was 343 MB of Rust
  build output

None of that is conversation data, and a blocklist would eventually fail to exclude something
like it. Walking only what is named above cannot pick them up by accident.

## Snapshotting

No Claude Code set declares `snapshot: "sqlite"`. Every file it archives is a plain file that
is safe to copy directly. Codex and Antigravity both carry live SQLite databases and do need
the online-backup path.

## Interaction with the usage store

`archive run --include transcripts` is what makes the usage store load-bearing rather than a
cache. Once the transcripts are archived and the originals pruned, `usage.db` is the only
record of that usage left on the machine — which is why it lives under `$XDG_DATA_HOME` and is
migrated forward across versions rather than discarded. See
[Usage store format](../../formats/usage-store.md).

## Related

- [Shared archive command behavior](../../commands/archive/common.md)
- [Archive store format](../../formats/archive-store.md)
- [`archive run`](../../commands/archive/run.md)
