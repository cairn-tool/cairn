# Gemini CLI: usage logs

Parsed by `src/usage/providers/gemini-cli.ts`, registered as `gemini-cli`.

Every fact on this page was established by measurement against a corpus of 1,777 transcripts
carrying 25,671 token records, and the figures the provider produces were checked against an
independent fold of the same files.

## Log root

`~/.gemini`, guarded on `tmp/` existing. There is **no environment override**: the CLI was
checked for one and none is honoured for the data root, so `--logs <dir>` is the only way to
point the provider elsewhere. The guard is also what keeps this provider off Antigravity's tree,
which lives at `~/.gemini/antigravity-cli` and is guarded on `conversations/`.

```text
tmp/<slug>/chats/session-<local stamp>-<short id>.jsonl   main
tmp/<slug>/chats/<parent session uuid>/<short id>.jsonl   subagent
tmp/<slug>/.project_root                                  the absolute project root
tmp/<slug>/logs.json                                      prompts and slash commands
```

`tmp/bin/` holds downloaded helper binaries beside the projects, so discovery requires a `chats/`
directory rather than walking `tmp/` indiscriminately.

## Record format

Line 1 is normally a header — `{sessionId, projectHash, startTime, lastUpdated, kind}`, plus
`directories` on a subagent — but **not always**. At least one transcript in a real corpus begins
with an ordinary record, so the header is detected rather than assumed and a file without one
parses normally.

Later lines are either a record:

```json
{ "id": "…", "timestamp": "…", "type": "gemini" | "user" | "info",
  "content": …, "toolCalls": [ … ], "thoughts": …, "model": "…",
  "tokens": { "input": 0, "output": 0, "cached": 0, "thoughts": 0, "tool": 0, "total": 0 } }
```

or a patch record, `{"$set": {…}}`. Patch records carry `lastUpdated`, `summary`, or
`memoryScratchpad` and never tokens or tool calls — verified on all 16,197 of them. They are
skipped outright, because their timestamp would otherwise open a day bucket nothing filled.

`$set.summary` is the session **title**, not a context reset. Gemini writes no compaction record,
so `compactions` is always zero here.

## Counting

This is the only provider that has to undo more than one distortion, and it has three.

### `cached` is inside `input`

Codex's rule, not Claude Code's. `total === input + output + thoughts` holds on every record, and
`cached` is not among the addends — so the cached prefix is counted **within** `input`. It is
subtracted back out and reported as a cache read:

```text
input     = input - cached
cacheRead = cached
```

Left merged, input reads several times high. There is no cache-**write** counter anywhere in the
format, so that figure is always zero — the same shape Codex reports for a request that wrote no
cache. `cacheTokens` is still declared `yes`, because the read half is a real measurement.

### `input` is a context size, not a running total

Antigravity's rule, not Codex's. The figure falls whenever context is trimmed — 878 drops against
10,506 rises between consecutive records — so it is **summed**. Differencing it would produce
nonsense.

### One turn is written two to five times under one id

Claude Code's rule. An `id` appears once (2,056 times), twice (12,164), three times (216), four
(89) and five (53). The `tokens` block is byte-identical on every copy — 13,063 comparisons, zero
differences — so tokens are **deduplicated on `id`**. Counting the copies roughly doubles every
figure.

**Tool calls need a second, separate deduplication**, and it is not the same rule. The
`toolCalls` array _grows_ across repeats: 12,512 pairs go empty→full and 551 go full→full, of
which 121 differ, and in one case the later list is longer. It never shrinks. So the rule for
tools is **last occurrence wins**, which is not knowable until the file ends — the provider
buffers the last list seen per `id` and flushes at EOF. Some records carry tool calls and no
tokens at all, which is why this cannot ride on the token deduplication.

### The validity guard

`total === input + output + thoughts`, `0 <= cached <= input`, and `input` within a context
bound. A record that fails contributes no tokens; its tool calls still count.

This is deliberately narrower than Antigravity's guard, which abandons a whole file's token
column on a failure. Antigravity reads schema-less protobuf where a wholesale field renumbering
would poison every value at once. Gemini's fields are **named**, so a bad record is only ever one
bad record.

## Prompts

Counted in **main transcripts only**. A subagent transcript's `user` record is the spawn
instruction its parent injected, not a human turn: on the reference corpus, 1,714 of 1,868 `user`
records are exactly that, so counting them all reports 1,868 prompts where 126 were typed.

## Slash commands

From `logs.json`, which is the only place a command is **named**. The transcript keeps the
expanded prompt, so `/opplan-convert northcom/boreal-shield` reaches the chat as
`northcom/boreal-shield`.

Each entry carries its own timestamp, so a command lands on the day it was used rather than on
the session's first day — better than Antigravity's shared history file, which has none.

Two limits, both inherent:

- A cached aggregate keys on the **chat file's** size and mtime, so a command written to
  `logs.json` after that file last changed is not seen until it changes again.
- `logs.json` outlives the transcripts. `/clear` keeps a session id in the history while
  truncating the chat, so a command belonging to a session with no surviving transcript has no
  aggregate to attach to and is dropped.

## Subagents

`chats/<parent uuid>/<id>.jsonl`. Because subagent-ness is in the **path**, `--no-subagents`
prunes the walk rather than filtering after reading — one of only two providers that can.
`scan.ts`'s parsed-`kind` filter still runs as a backstop.

A subagent's `sessionId` is its own short id and `parentSessionId` is the directory holding it,
matching Codex. **`agentType` is left unset**: the child records no role of its own, and the role
lives in the parent's `invoke_agent` call, which a single-transcript parse cannot reach. The
spawn counts and role names are still exact, because the parent fills `agents` from that same
call — this only means the child has nothing extra to add.

## Projects

`tmp/<slug>/.project_root` holds the absolute project root as plain text, so project identity is
**exact** where Claude Code's directory slug is lossy. `projectHash` in the header is a sha256 of
that same path, which makes it a cross-check rather than a source, and `projects.json` duplicates
it from outside the shard; neither is used.

## Tool names

Kept exactly as Gemini writes them. `invoke_agent` and `activate_skill` are this assistant's own
builtins: they fill `agents` and `skills` as well, but they are **not** renamed to Claude Code's
`Agent`/`Skill`, because printing a tool name that appears nowhere in the transcript is a worse
answer than a coarse `kind`. Both classify as `builtin` in `usage tools --by kind`, exactly as
Codex's `spawn_agent` does.

## Capabilities

| Capability     | Value | Why                                                                      |
| -------------- | ----- | ------------------------------------------------------------------------ |
| tokens         | yes   |                                                                          |
| cache detail   | yes   | Read only; there is no cache-write figure, so that counter stays at zero |
| tools          | yes   |                                                                          |
| skills         | yes   | `activate_skill` names the skill in `args.name`                          |
| subagents      | yes   | Told apart by path                                                       |
| hooks          | no    | Configured in `~/.gemini/settings.json`; no execution is ever recorded   |
| MCP            | no    | A call records a bare name, so an MCP tool cannot be told from a builtin |
| slash commands | yes   | From `logs.json`                                                         |
| projects       | yes   | From `.project_root`                                                     |

## Failure handling

A line that will not parse increments `malformedLines` and is skipped. A record that fails the
token guard loses its tokens and keeps everything else. A missing `.project_root` leaves the
project unattributed rather than reconstructing it from the slug. None of these throws.

## Related

- [Shared usage command behavior](../../commands/usage/common.md)
- [Antigravity: usage logs](../antigravity/usage-logs.md) — the other provider under `~/.gemini`
- [Usage store format](../../formats/usage-store.md)
