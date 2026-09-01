# Cursor: usage logs

Parsed by `src/usage/providers/cursor.ts`, registered as `cursor`.

## Log root

The Electron user-data directory, guarded on `User/globalStorage/state.vscdb` existing:

| Platform | Directory                              |
| -------- | -------------------------------------- |
| macOS    | `~/Library/Application Support/Cursor` |
| Windows  | `%APPDATA%/Cursor`                     |
| Linux    | `~/.config/Cursor`                     |

There is no environment override; only `--logs`. The candidates are tried in order and the
first whose store exists wins, rather than switching on the platform — which is what keeps the
provider hermetic under a test suite that swaps `HOME`.

Cursor is an editor rather than a CLI, and it keeps its things in **two** trees. The one above
holds the conversations. `~/.cursor` holds the plans, the agent transcripts and the per-session
output, and is not read by `usage` at all — it carries no counters. It is archived, and the
consequences of that split are on the [archiving page](archiving.md).

## One database, not one file per conversation

```sql
ItemTable(key TEXT UNIQUE, value BLOB)        -- settings, and the legacy conversation index
cursorDiskKV(key TEXT UNIQUE, value BLOB)     -- the corpus, keyed by prefix
composerHeaders(composerId PK, workspaceId, createdAt, lastUpdatedAt,
                isArchived, isSubagent, recency, checkpointAt, value)
```

A conversation is a _composer_, and `composerId` joins every prefix in `cursorDiskKV`:

| Key                                              | What it holds                                 |
| ------------------------------------------------ | --------------------------------------------- |
| `composerData:<id>`                              | the conversation: timestamps, model, ordering |
| `bubbleId:<id>:<bubbleId>`                       | one turn                                      |
| `agentKv:blob:<sha256>`                          | opaque; see below                             |
| `checkpointId:`, `codeBlockDiff:`, `ofsContent:` | file snapshots and diffs                      |

This is the third provider that reads somebody else's live database, and it follows the rules
Antigravity and OpenCode set: opened **read-only** through the shared `loadSqlite()` — never a
second copy of that loader, whose warning suppression keeps `node:sqlite` off stderr — and every
failure treated as an empty store rather than an exception. A renamed column costs exactly the
column it names.

Every read is bounded by a **key range** rather than a `LIKE`, so the `UNIQUE` index on `key`
is always used. On a real machine that table holds roughly 450,000 rows and 5 GB of values, and
an unconstrained scan of it is minutes rather than milliseconds.

## Counting

**Cursor stopped writing token counters.** `tokenCount.inputTokens` and `.outputTokens` on a turn
are genuine per-request figures, but on a real corpus of 137,895 turns every nonzero one falls
between **2025-06-17 and 2025-12-23**. Newer conversations carry the field with zeroes in it and
settle usage server-side, reachable only through each turn's `usageUuid`. The legacy
`composerData.usageData.<model>.costInCents` stopped at 2026-01-17 in the same way.

So this provider reports real tokens for the window Cursor wrote them and zero afterwards. **A
report over a window after 2025 showing sessions and tools but no tokens is correct**, and is a
fact about the host rather than a gap in the parser.

A turn whose counters are absent or all zero emits **no response event at all**. Counting them
would report one request per turn against no tokens across the entire modern corpus — the same
suppression `codex` applies to a zero delta.

| What the log records                                     | What is done with it                |
| -------------------------------------------------------- | ----------------------------------- |
| Per-request `inputTokens`/`outputTokens`, on older turns | Summed as-is; no distortion to undo |
| The same fields, zeroed, on newer turns                  | No request counted                  |
| `contextTokensUsed`                                      | **Not read** — see below            |

Unlike Codex and Gemini CLI, nothing is subtracted: the input figure has never contained a
cached part, because **no cache counter has ever existed in this schema**. `tokenCount` has only
ever had those two fields, which is why `cacheTokens` is `no` rather than a zero that might be
mistaken for "you never hit cache".

### Why `contextTokensUsed` is not read

It is the only live token figure in the store, and it is the one number here that would have no
defensible interpretation. It is the size of the **most recent turn's** context: overwritten
every turn, excluding output entirely. It cannot be summed the way Antigravity's per-request
context size is, because it is not per request; and it cannot be differenced the way Codex's
running total is, because it is not cumulative. Reporting it as tokens would produce a number
with nothing behind it.

### What is not readable at all

`agentKv:blob:*` is 2.96 GB of the model-facing message arrays and would be the obvious place to
recover what the counters no longer say. It is not usable: the framing is mixed JSON and
protobuf, and 967 of 1,616 conversations carry a `blobEncryptionKey`.

## Mapping one database onto transcripts

`discover()` must return per-file records whose freshness the store judges on `(size, mtime)`,
and Cursor has no filesystem unit below the whole database. The unit is therefore synthesized:
**one entry per conversation**, with a `relative` of `composer/<composerId>`, exactly as OpenCode
does and for the same reason — a `FileAggregate` carries exactly one session id, kind, project
and time span, so one entry for the store would destroy `usage sessions`, `--last`, `--project`,
and the main/subagent split.

### Discovery is over `composerData:`, not the conversation index

`composerHeaders` looks like the session index and must not be used as one. It is a recent table
that Cursor gated behind its own flag and **never backfilled**, and the legacy index beside it —
`ItemTable['composer.composerHeaders'].allComposers` — does not make up the difference.

Measured on a real store: 229 conversations carry token counters, and **161 of them appear in
neither index**. Deciding existence from either would have silently dropped 37.9M of the
61.7M input tokens on the machine — 61% of everything there was to report. Both indexes are
therefore read only to **enrich** a conversation with the identity they alone carry, never to
decide that it exists.

### The freshness key

Synthesized too, or the mapping is worse than useless:

- **Not the file's mtime.** It is one value shared by every conversation, so any write would
  invalidate all of them and force a re-parse of a 5.65 GB store on every scan.
- `mtimeMs` is the latest timestamp the conversation itself carries, and `size` fingerprints its
  turn count. `isFresh` compares exactly that pair, and neither half alone catches every edit —
  a conversation can grow without its recorded timestamp moving.

The turn counts come from a single **index-only** pass that touches no value, so the fingerprint
for the whole corpus costs a fraction of a second.

Unlike OpenCode, the store is **not** reduced up front. That one is a few megabytes; this one is
5.65 GB. Only the cheap index is built eagerly and memoized on the database's path, mtime and
size; `parse` then reads one conversation's turns through the key range that serves them, and
projects the seven fields it needs **in SQL**, so a turn body averaging 9 KB never crosses into
JavaScript.

## Day attribution is per conversation

Every other provider dates a record from the record. Cursor cannot: a turn carries a timestamp
only in `timingInfo.clientRpcSendTime`, and on a real corpus that is present on 953 of 137,895
turns — and on **5 of the 748** that carry tokens. It is used where it exists, and otherwise
every event in a conversation is anchored on the conversation's own `createdAt`.

So `usage tokens --by day` is accurate to the conversation rather than to the turn. A
conversation spanning midnight books to the day it started.

## Subagents

`composerHeaders.isSubagent`, and `subagentInfo` in either index. Because that is known before
any turn is read, `--no-subagents` prunes at discovery — the fourth provider that can, after
`claude-code`, `gemini-cli` and `opencode`.

`subagentInfo` also carries `parentComposerId`, `subagentTypeName` (the reusable role) and
`toolCallId` (this run's own id) — the same split Codex records as `agent_role` and `agent_path`.

A spawn is counted from the parent's `task_v2` call, which is Cursor's own subagent-spawning
builtin. **The parent's call does not name the role**, but the conversation it spawned does, and
that conversation's `subagentInfo.toolCallId` points back at the exact call — so the two are
joined by identifier rather than by guess. A spawn whose conversation has since been deleted
reports as `(unrecorded)`.

## Tools

From `toolFormerData` on a turn: `name`, `status`, and `toolCallId`. A tool call is recorded on
89,453 of 137,895 turns, so this is the richest thing in the store. `status: "error"` is counted
as an error.

Note that a turn is **not** a response: 134,306 turns are assistant turns against 3,553 prompts,
because each tool step is its own turn. That is exactly why requests are counted from the token
counters rather than from turns.

### MCP

A call is recorded as `mcp-<server>-<tool>`, so an MCP call **can** be told apart from a builtin —
which is why `mcp` is `yes` here and `no` for OpenCode and Gemini CLI, whose tool records name no
server at all. But the boundary _within_ that name is not recoverable: the server half is
sometimes repeated (`mcp-cursor-ide-browser-cursor-ide-browser-browser_lock`) and the separator
occurs inside both halves.

The name is therefore rewritten to `mcp__<rest>` with no second separator, which makes
`classifyTool` report `kind: "mcp"` with the whole flattened name as the server — exactly as much
as is known, and no more.

## Projects

`workspaceIdentifier.uri.fsPath`, carried inside the store itself, so project identity never
depends on reading `User/workspaceStorage/<id>/workspace.json` and never on the
`~/.cursor/projects/<slug>` directory names — those replace both separators and dots and are
lossy in both directions, the same trap `claude-code` documents for its own slugs.

It is read from **all three** places that carry it: the conversation itself, the
`composerHeaders` row, and the legacy index entry. The conversation is the only one of the three
that can speak for a conversation neither index knows about, and reading it lifts attribution
from 386 conversations to 515 across 57 projects on a real store.

**The conversations that carry tokens carry no workspace at all** — none of the 229. Cursor was
not recording one at the time, so their project is genuinely unrecorded rather than merely
unresolved, and they report as `(unknown)`.

A multi-root window carries `configPath` instead, naming a `.code-workspace` document rather than
a directory. That is several folders and a `FileAggregate` has one `project`, so it is left unset
rather than having one picked arbitrarily.

## Capabilities

| Capability     | Value | Why                                                                           |
| -------------- | ----- | ----------------------------------------------------------------------------- |
| tokens         | yes   | Real per-request figures, for conversations before December 2025              |
| cache detail   | no    | `tokenCount` has only ever had `inputTokens` and `outputTokens`               |
| tools          | yes   | `toolFormerData.name`, on 65% of turns                                        |
| skills         | no    | No tool, capability, or turn field names a skill                              |
| subagents      | yes   | `isSubagent` and `subagentInfo`                                               |
| hooks          | no    | Five events are configured in `~/.cursor/hooks.json`; no execution is written |
| MCP            | yes   | An `mcp-` prefixed tool name, though the server boundary is not recoverable   |
| slash commands | no    | A command reaches the store only as the prompt it expanded to                 |
| projects       | yes   | `workspaceIdentifier.uri.fsPath`                                              |

## Verification

Cursor ships no `stats` command, so unlike OpenCode there is **no independent oracle on the
machine**. What is checked instead:

- Every figure the provider reports was reconciled against the same quantity computed directly in
  SQL over the live store, independently of the parser: 61,683,636 input, 5,392,845 output, 748
  requests, 3,553 prompts, 1,103 errors, all matching exactly.
- `tests/unit/usage-events.test.ts` folds the event stream back into day buckets and asserts it
  reproduces what the provider built.
- The counts that decide the design — 161 unindexed token-bearing conversations, the December
  2025 cutoff — are pinned as cases in `tests/unit/usage-cursor.test.ts` against a fixture that
  reproduces each shape.

The remaining check is external and cannot be automated: compare a headline against Cursor's own
usage view for a window inside the token era.

```bash
cairn usage tokens --by model --provider cursor --since 2025-06-01 --until 2025-12-31
```

## Related

- [Shared usage command behavior](../../commands/usage/common.md)
- [Usage store format](../../formats/usage-store.md)
- [Archiving](archiving.md) — the second tree, and why the profile needs one
