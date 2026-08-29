# Shared archive command behavior

The `archive` toolset copies what a coding assistant leaves behind into long-term storage:
plan documents, the files tools produced, and optionally the session transcripts and logs.
Nothing is sent anywhere, and nothing outside the archive directory is written.

## Common options

| Option            | Default                        | Description                                         |
| ----------------- | ------------------------------ | --------------------------------------------------- |
| `--format <fmt>`  | `llm`                          | Output format: `llm`, `human`, `json`.              |
| `--envelope`      | —                              | Wrap `--format json` output in the result envelope. |
| `--archive <dir>` | `$XDG_DATA_HOME/cairn/archive` | Where the archive lives.                            |
| `-fh` / `-fj`     | —                              | Shorthands for `--format=human` / `--format=json`.  |

`--archive` is the option that matters most once transcripts are included: the corpus that
produces ~150 MB of plans and artifacts produces over 9 GB with transcripts and logs, and that
usually belongs on external or network storage rather than in a home directory.

## What gets archived

Selection is an **allowlist of directories declared per provider**, in `src/archive/sets.ts` —
never a sweep of a home directory with exclusions bolted on. That distinction is load-bearing.
`~/.claude` alone holds hundreds of megabytes of plugin payloads, a downloaded binary, and a
`jobs/` tree that on a real machine was 343 MB of Rust build output. None of it is conversation
data, and a blocklist would eventually fail to exclude the next such directory. Walking only what
is named cannot pick them up by accident.

Four classes, selected with `--include`:

| Class         | Default | What it is                                                           |
| ------------- | ------- | -------------------------------------------------------------------- |
| `plans`       | yes     | Plan documents, implementation plans, walkthroughs, task notes.      |
| `artifacts`   | yes     | Files tools produced: fetched PDFs, rendered pages, memory, scripts. |
| `transcripts` | no      | Session and subagent transcripts.                                    |
| `logs`        | no      | Prompt history, CLI logs, shell snapshots, and provider databases.   |

`plans` and `artifacts` are the default because they are the durable output of a session, they
are small, and nothing else on the machine keeps them. `transcripts` and `logs` are opt-in
because they are three orders of magnitude larger.

### Per provider

| Provider      | Plans                                       | Artifacts                                         | Transcripts                             | Logs                                               |
| ------------- | ------------------------------------------- | ------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| `claude-code` | `plans/*.md`                                | `projects/**/tool-results/**`, `**/memory/*.md`   | `projects/**/*.jsonl` and subagent meta | `history.jsonl`, `daemon.log`, shell snapshots     |
| `codex`       | — (Codex writes none)                       | `computer-use/**`                                 | `sessions/**/rollout-*.jsonl`           | `history.jsonl`, `*.sqlite`                        |
| `antigravity` | `brain/*/**.md` outside `.system_generated` | other `brain/` output outside `.system_generated` | `**/logs/transcript.jsonl`              | `log/*.log`, `history.jsonl`, `conversations/*.db` |
| `gemini-cli`  | `tmp/*/*/plans/*.md`                        | `tmp/*/tool-outputs/**`                           | `tmp/*/chats/**/*.jsonl`                | `tmp/*/logs.json`                                  |
| `opencode`    | — (OpenCode writes none)                    | `storage/**/*.json`                               | — (they are rows in `opencode.db`)      | `log/*.log`, `snapshot/**`, `opencode.db`          |

Antigravity's plans and artifacts are told apart from its machinery by one directory name,
`.system_generated`, rather than by a list of filenames. Its `transcript_full.jsonl` is
deliberately skipped: it shares a schema with `transcript.jsonl` and differs only in whether long
strings are truncated, so archiving both would store the same conversation twice.

### Live databases

Every Codex `.sqlite` and all of Antigravity's conversation `.db` files carry live `-wal`
sidecars. Copying the main file alone can capture a page image torn mid-write, and a `.db`
without its `-wal` may be missing recent writes entirely. Those sets are marked for a **SQLite
online backup**, which produces one consistent file. The sidecars are never archived beside the
database; their contents are folded into the snapshot.

## Storage

```text
archive/
  archive.db                  the index
  segments/seg-000001.tar.gz  append-only, immutable
  segments/seg-000002.tar.gz
```

A segment is an ordinary deterministic `.tar.gz`. **`tar tzf` recovers its contents with no index
and no `cairn`**, which is the point of choosing a standard container for a store meant to outlive
the tool that wrote it. Members are named `blobs/<aa>/<sha256>` rather than by their original
path, which does two things at once: identical files become one member, and every name is 73
characters, comfortably inside the ustar `name` field that the real paths — nested seven deep
under project slugs — would overflow.

Segments are never rewritten. A later run appends a new one, which is what makes the archive safe
to copy to slower storage and keeps an interrupted run from damaging what came before.

## Incremental, twice over

Two independent things make a second run cheap:

1. A file whose `(path, size, modification time)` already matches the index is **never opened**.
2. A file that is opened but whose content is already stored is **never written again**; only its
   row is added.

So an unchanged corpus costs one `stat` per file, and a file that merely moved costs one row.

A file whose content _changes_ gets a new row against a new blob, so the archive accumulates every
version it ever saw without anyone asking it to. [`archive list`](list.md) shows the
newest and counts the rest; [`archive extract`](extract.md) reaches an older one by hash.

## The index is migrated, not discarded

`archive.db` carries a hand-owned schema version, separate from the usage store's. Like that one,
it is migrated across versions rather than thrown away — it is the only map from an original path
to the segment holding that file's bytes, and the segments themselves are append-only. An index
written by a newer `cairn` is refused rather than opened. See
[`archive migrate`](migrate.md).

## Exit codes

| Condition                          | Code | Stream |
| ---------------------------------- | ---- | ------ |
| Command completed                  | `0`  | stdout |
| Invocation error                   | `1`  | stderr |
| The archive and its index disagree | `2`  | stderr |

Exit `2` comes only from [`archive verify`](verify.md). It is the one command here that
fails by default rather than under a `--strict` flag, because corruption is the actionable finding
it exists to report. An unreadable source file during a run is counted and reported, never fatal:
over thousands of artifacts a file removed mid-walk is routine.
