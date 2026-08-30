---
name: usage-store
description: Manage the cairn usage store and understand what its numbers mean. Use when importing transcripts, rebuilding or clearing the usage index, applying store migrations, or explaining why a usage figure differs from a raw count of the log files.
---

# The cairn usage store

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`).

Longer conventions: [`${BUNDLE_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

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

Two more that change what a number means:

- **Subagent tokens come from the subagent's own transcript**, never the parent's summary of it.
  The parent's `toolUseResult.totalTokens` is the subagent's final message only, and understates
  real spend several-fold.
- **A session id is unique only within its provider.** Counting or grouping sessions on the bare
  id merges two providers' sessions when they mint the same UUID, which they do.

If someone has hand-computed a figure from the raw logs and it disagrees with cairn, cairn is
almost certainly right — say which correction explains the gap.

## Provider coverage

`cairn usage providers` lists the log sources and what each can answer. They differ: a
`gemini-cli` prompt count taken over subagent transcripts is wrong by a factor of fourteen,
because a subagent's `user` record is the instruction its parent injected — so prompts are counted
in main transcripts only.

Cursor is deliberately unregistered: there is no local corpus to write or verify a parser against.

## More

Full flags are in [`reference/store.md`](reference/store.md).
