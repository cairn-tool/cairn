# OpenCode: usage logs

Parsed by `src/usage/providers/opencode.ts`, registered as `opencode`.

## Log root

`$XDG_DATA_HOME/opencode` when set, `~/.local/share/opencode` otherwise, guarded on
`opencode.db` existing. There is no `OPENCODE_*` variable for the data directory —
`OPENCODE_CONFIG_DIR` points at configuration, which is a different tree.

## One database, not one file per session

```sql
session(id, project_id, parent_id, directory, title, version, agent, model,
        cost, tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write, time_created, time_updated)
message(id, session_id, time_created, time_updated, data)           -- JSON
part(id, message_id, session_id, time_created, time_updated, data)  -- JSON
```

This is the second provider that reads somebody else's live database, and it follows the same
rules as Antigravity: opened **read-only** through the shared `loadSqlite()` — never a second
copy of that loader, whose warning suppression keeps `node:sqlite` off stderr — and every failure
treated as an empty store rather than an exception. A renamed column costs exactly the column it
names.

## Counting

**The same usage is recorded at three grains**, and reading more than one doubles every figure:

| Where                               | What it holds                     |
| ----------------------------------- | --------------------------------- |
| `message.data.tokens`               | the assistant message's own usage |
| `part.data.tokens` on `step-finish` | a copy of the same figures        |
| `session.tokens_*`                  | the session's rollup of them      |

Measured against a real store, all three agree exactly and match `opencode stats`. **Only the
message grain is read.** It is the right one twice over: a message that produced no `step-finish`
part still carries usage, and `message.id` is a primary key — the same reason `claude-code`
deduplicates on `message.id` rather than on anything anonymous. The session rollup is a
cross-check, asserted in the unit tests rather than at runtime, and `part` rows are read only for
tool calls.

Unlike Codex and Gemini CLI, `tokens.cache.read` is a field of its own rather than part of
`input`, so nothing is subtracted.

**Cost is dropped.** `session.cost` and `message.data.cost` are both there, but `TokenTotals` has
no place for a currency figure and adding one is a usage-store migration plus a contract change.

## Mapping one database onto transcripts

`discover()` must return per-file records whose freshness the store judges on `(size, mtime)`,
and OpenCode has no filesystem unit below the whole database. The unit is therefore synthesized:
**one entry per session**, with a `relative` of `session/<session id>`.

Collapsing the store into a single entry was not an option. A `FileAggregate` carries exactly one
session id, kind, project and time span, so one entry would destroy `usage sessions`, `--last`,
`--project`, and the main/subagent split.

Once the unit is synthesized the freshness key has to be too, or the mapping is worse than
useless:

- **Not the file's mtime.** It is one value shared by every session, so any write would
  invalidate all of them and force a full re-parse on every scan.
- **Not `session.time_updated` alone.** It is measurably stale against the messages beneath it —
  observed lagging its own last message by two hours — so a session could stay cached
  half-written.
- The key is the **latest timestamp anywhere in the session**, and `size` fingerprints the
  message and part counts. `isFresh` compares exactly that pair, and neither half alone catches
  every edit.

`--since` therefore prunes on a real content timestamp rather than a filesystem mtime a backup
tool can bump, and the `partial` delete rule is unaffected: a complete walk enumerates every
`session` row, so a session missing from discovery really was deleted.

The store is parsed **once and memoized**, keyed on the database's own path, mtime and size.
SQLite declares no index for these foreign keys, so a per-session `WHERE session_id = ?` would be
a full scan of `message` and `part` for every session.

## Subagents

`session.parent_id`. Because it is on the row, `--no-subagents` prunes before anything is parsed —
the third provider that can, after `claude-code` and `gemini-cli`.

A subagent names its own role on its messages (`data.agent`), which agrees with the parent's
`task` call and needs no cross-session join.

## Tools

From `part` rows with `data.type === "tool"`: the name from `data.tool`, the spawned role from
`data.state.input.subagent_type` on a `task` call, and an error from `data.state.status`.

`task` is OpenCode's own subagent-spawning builtin and keeps that name, so it classifies as
`builtin` in `usage tools --by kind` while filling the agents report — the same treatment Codex's
`spawn_agent` and Gemini's `invoke_agent` get.

## Capabilities

| Capability     | Value | Why                                                                  |
| -------------- | ----- | -------------------------------------------------------------------- |
| tokens         | yes   |                                                                      |
| cache detail   | yes   | Named read and write fields, disjoint from input                     |
| tools          | yes   |                                                                      |
| skills         | no    | No part type names a skill                                           |
| subagents      | yes   | `session.parent_id`                                                  |
| hooks          | no    | Plugins can hook the lifecycle; no execution is written to any table |
| MCP            | no    | A tool part records a bare name with no server                       |
| slash commands | no    | A command reaches the store only as the prompt it expanded to        |
| projects       | yes   | `session.directory`                                                  |

## Verification

Every figure here is checkable against OpenCode's own reporting, and was:

```bash
opencode stats
cairn usage summary --provider opencode
cairn usage tools --provider opencode
```

The totals, the session count, and all four tool names and counts agree. Note that
`opencode stats` counts the subagent session in its totals, so the comparison is against Cairn's
**default** — subagents included — rather than `--no-subagents`.

## Related

- [Shared usage command behavior](../../commands/usage/common.md)
- [Usage store format](../../formats/usage-store.md)
