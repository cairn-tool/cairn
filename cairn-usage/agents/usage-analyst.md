---
name: usage-analyst
description: Investigates LLM usage and spend with cairn, chaining several reports and returning a conclusion. Use for open questions about cost or activity that need more than one query, where the intermediate JSON would otherwise flood the conversation.
model: inherit
---

# Usage analyst

You answer open questions about assistant usage with the `cairn usage` toolset and return a
conclusion, not a data dump. A spend investigation is four or five chained queries whose
intermediate output is enormous; keeping that out of the caller's context is the job.

## Procedure

1. Confirm `cairn` is available: `command -v cairn`. If it is missing, say so and stop.
2. Orient with `cairn usage summary --since <range>`.
3. Narrow along one dimension at a time — `tokens --by day` for a trend, `--by project` for where,
   `--by model` for what. Use `-fj` and filter with `jq`; do not paste raw tables around.
4. Drill into specifics only once the shape is clear: `usage sessions --sort tokens --top 5`, then
   `usage agents` or `usage tools` if a session looks anomalous.
5. Check `scan` in the JSON payload before concluding. Unreadable transcripts are counted there
   rather than made fatal, and a low figure sometimes means a partial read.

Leave `--strict` off unless the caller asked whether the data is complete.

## What to report

- **Answer the question first**, in one or two sentences with the number.
- **Say what range and provider** the figure covers. `--since` is day-granular.
- **Name the correction** if the figure would surprise someone who counted the log files by hand —
  response-level deduplication, subagent tokens from their own transcripts, a provider's running
  totals. A number without that context invites someone to "correct" it wrongly.
- **Show the commands** you ran, so the caller can reproduce it.

Do not speculate about cost in currency unless the caller supplied rates. The toolset reports
tokens; `cost` is deliberately not carried through the store.

# Reporting usage with cairn

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`).

Longer conventions: [`./assets/cli-basics.md`](../../assets/cli-basics.md).

Everything here reads transcripts already on disk. **Nothing is sent anywhere**, and nothing
outside the usage store is written.

## Start with `summary`

```bash
cairn usage summary
cairn usage summary --since 7d
```

Headline totals — sessions, tokens, tools, features. Run it first; it usually reframes the
question.

## Then pick a dimension

| Question                          | Command                                 |
| --------------------------------- | --------------------------------------- |
| What did tokens go to?            | `usage tokens --by model\|day\|project` |
| Which tools ran?                  | `usage tools --by name\|kind\|server`   |
| What happened in each session?    | `usage sessions --sort tokens`          |
| Which projects cost the most?     | `usage projects`                        |
| Which skills got used?            | `usage skills`                          |
| What did subagents actually cost? | `usage agents --by role`                |
| Are hooks failing?                | `usage hooks`                           |
| Which slash commands get used?    | `usage commands`                        |

```bash
cairn usage tokens --by day --since 30d
cairn usage tokens --by model --project ~/code/app
cairn usage tools --by name --kind mcp
cairn usage sessions --sort tokens --top 10
cairn usage agents --by role
```

## Shared filters

Every reporting command takes the same ones:

| Option              | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `--provider <name>` | Log source, or `all`; defaults to `claude-code`               |
| `--project <path>`  | Limit to a project path, slug, or name (repeatable)           |
| `--since <spec>`    | Earliest day: a span like `7d`, `2w`, `3m`, `1y`, or ISO date |
| `--until <spec>`    | Latest day, same forms                                        |
| `--last <n>`        | Only the n most recently active sessions                      |
| `--top <n>`         | Rows to show; `0` for all                                     |
| `--no-subagents`    | Exclude subagent transcripts                                  |
| `--strict`          | Exit 2 when a transcript could not be fully read              |

`cairn usage providers` lists the log sources available and what each can answer. Use it before
assuming a provider is supported — they differ in what their logs record.

## Two things to state whenever you quote a number

**`--since` and `--until` are day-granular.** Not instants. The day rollup is what makes
`tokens --by day` cheap, and accepting an instant would promise a precision that rollup cannot
keep. "Last 24 hours" is not expressible; `--since 1d` is a calendar day.

**Every provider distorts its own token log, and cairn undoes each distortion separately.** The
figures are corrected, not raw — that is the point. But it means a number here will not match a
naive sum of the transcript files, and if someone has computed one by hand, cairn's is the right
one. The specifics are in the `usage-store` skill.

## Exit codes

`usage` exits `2` **only under `--strict`**. Over thousands of transcripts a removed file or a
truncated final line is routine, so those are counted under `scan` in the payload rather than made
fatal — blocking by default would make the command useless in CI.

If a count looks low, check `scan` in `-fj` output before concluding anything.

## Machine-readable

```bash
cairn usage tokens --by day --since 30d -fj | jq -r '.rows[] | "\(.day) \(.total)"'
cairn usage sessions --sort tokens -fj | jq '.rows[0]'
```

## More

Every command's dimensions and flags are in [`reference/reports.md`](reference/reports.md).
Importing and the store are in the `usage-store` skill.

# The cairn usage store

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`).

Longer conventions: [`./assets/cli-basics.md`](../../assets/cli-basics.md).

Transcripts are imported once into a SQLite store under `$XDG_DATA_HOME`, holding both the day
rollup the reports read and a per-occurrence event table for questions a day bucket cannot answer.

## Commands

```bash
cairn usage index                 # what does the store hold?
cairn usage index --rebuild       # discard and re-import everything
cairn usage index --clear         # discard it
cairn usage import                # import new transcripts
cairn usage import --rebuild
cairn usage migrate --check       # pending migrations?
cairn usage migrate               # apply them
```

The store maintains itself — reports import what they need. Reach for `import` when you know new
transcripts landed, and `--rebuild` when a figure looks wrong rather than merely stale.

`--no-index` on any reporting command bypasses the store entirely, neither reading nor writing it.
Use it to check whether a suspicious number is a store problem or a parsing one.

## A filtered import may not delete

`--since` and `--no-subagents` prune **discovery**. A walk that never looked at a file cannot
conclude the file is gone, so a filtered import is marked partial and is not allowed to evict
anything. Only a complete walk may delete.

The practical consequence: if you want to clean out stale entries, run an unfiltered
`cairn usage import`. A filtered one will not do it, by design.

## The store version is migrated, never discarded

Unlike a cache, a version mismatch here may not throw the file away. After
`cairn archive run --include transcripts` prunes the source logs, **the store can be the only
record of that usage left**. A store from a newer build is refused rather than opened.

Never suggest deleting the store to resolve a version complaint. Run `usage migrate`, or upgrade
`cairn`.

## Why the numbers differ from a naive count

This is the part worth carrying into any answer that quotes a figure. Each provider distorts its
own token log differently, and cairn undoes each one separately:

| Provider    | The distortion                                                                          | The correction                                                                  |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Claude Code | One JSONL line per content block, each with an identical full copy of `message.usage`   | Dedupe on `message.id`. Summing lines over-counts output ~2.5x                  |
| Codex       | A **running total** per thread, re-emitted on duplicates                                | Difference consecutive readings; summing inflates ~4%                           |
| Codex       | Cache reads counted **inside** `input_tokens`                                           | Subtract the cached part out                                                    |
| Antigravity | A per-request context size that is **not** cumulative                                   | Sum it — differencing produces nonsense, since it falls when context is trimmed |
| Gemini CLI  | All three at once: repeated ids, per-request context size, cached prefix inside `input` | Dedupe, sum, subtract                                                           |
| OpenCode    | The same usage recorded at three grains                                                 | Read only the message grain; reading two doubles it                             |
| Cursor      | None — `tokenCount` on a turn is a genuine per-request figure                           | The only provider needing no correction; see the end date below                 |

Three more that change what a number means:

- **Subagent tokens come from the subagent's own transcript**, never the parent's summary of it.
  The parent's `toolUseResult.totalTokens` is the subagent's final message only, and understates
  real spend several-fold.
- **A session id is unique only within its provider.** Counting or grouping sessions on the bare
  id merges two providers' sessions when they mint the same UUID, which they do.
- **Cursor's tokens have an end date.** Cursor stopped writing counters in December 2025 and
  settles usage server-side now, so a recent window reports sessions and tools against **zero
  tokens**. That is the host, not a gap in the parser — never present it as missing data.

If someone has hand-computed a figure from the raw logs and it disagrees with cairn, cairn is
almost certainly right — say which correction explains the gap.

## Provider coverage

`cairn usage providers` lists the log sources and what each can answer. They differ: a
`gemini-cli` prompt count taken over subagent transcripts is wrong by a factor of fourteen,
because a subagent's `user` record is the instruction its parent injected — so prompts are counted
in main transcripts only.

Cursor is registered, and two of its properties change how its numbers read. Its tokens have an
**end date** — see above — so a window after 2025 legitimately reports activity with no tokens.
And a Cursor _turn_ is not a response: each tool step is its own turn, so requests are counted
from the token counters rather than from turns, and its day rollups are per conversation, the one
provider where they are not per record.

## More

Full flags are in [`reference/store.md`](reference/store.md).
