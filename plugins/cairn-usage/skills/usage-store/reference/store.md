# The usage store in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats and exit codes.

## Commands

| Command                  | Meaning                                   |
| ------------------------ | ----------------------------------------- |
| `usage index`            | Show what the store holds                 |
| `usage index --rebuild`  | Discard and re-import everything          |
| `usage index --clear`    | Discard the store                         |
| `usage import`           | Import new transcripts                    |
| `usage import --rebuild` | Re-import from scratch                    |
| `usage migrate --check`  | Report pending migrations without writing |
| `usage migrate`          | Apply them                                |

All the shared reporting filters apply to `import`, and that is what makes an import _partial_.

## Two grains, kept honest

The store holds a **day rollup**, which is what makes `tokens --by day` cheap and what `--since`
is pushed into as SQL, and a **per-occurrence event table** for questions a day bucket cannot
express.

Providers emit per-occurrence events _alongside_ the day buckets they already built, never
instead of them, so no published number depends on the event stream being complete. Folding the
event stream back must reproduce the day buckets exactly.

## `usage index` reports two retained fields

`shards` is retained at `0`: one store replaced the per-project shard files, so it counts
something that no longer exists but is a required property of the published schema. `bytes` is the
whole store's size repeated on every `caches` entry, not a per-entry figure. `removed` counts
transcripts, not files.

These are recorded rather than quietly fixed, because changing them would break a consumer.

## Discovery and pruning

`subagents/agent-*.jsonl` outnumbers main transcripts about 6:1 and holds more bytes, so subagent
transcripts are scanned by default. `--no-subagents` prunes discovery.

Only `claude-code`, `gemini-cli`, and `opencode` can prune subagents at discovery time — the first
two record the thread source in the transcript's path and `opencode` on the session row. `codex`
and `antigravity` record it inside the file, so those are filtered on the parsed kind instead.

## Why a filtered import may not delete

`--since` and `--no-subagents` prune discovery, so dropping rows for what such a walk did not find
would evict every entry it never looked at, and make the next full import re-parse everything.
Only a complete walk may delete. That is the `partial` flag.

## Provider notes worth knowing

- **Claude Code** writes one JSONL line per content block, each carrying an identical full copy of
  `message.usage`. Counting lines over-counts output tokens ~2.5x. Tool-use blocks really are one
  per line and are counted per line. Records with `model: "<synthetic>"` are locally generated and
  carry no usable counters. A `session_id` (snake) appears alongside `sessionId` with a
  **different, stale** value — never key on it.
- **Codex** reports a running total per thread; its `last_token_usage` is re-emitted on duplicates,
  and summing inflates ~4%. Cache reads sit _inside_ `input_tokens`.
- **Antigravity** reports a per-request context size that is not cumulative. Its tokens come from
  a schema-less protobuf whose field numbers are reverse-engineered; on any consistency-check
  failure every JSONL-derived figure is kept and no tokens are emitted.
- **Gemini CLI** needs all three corrections at once, and its tool calls need a second, different
  dedupe: the `toolCalls` array grows across repeats and never shrinks, so the rule is
  last-occurrence-wins.
- **OpenCode** records the same usage at three grains — the assistant message, its `step-finish`
  part, and the session rollup. Only the message grain is read. Unlike Codex and Gemini CLI, its
  `tokens.cache.read` is disjoint from `input` and is **not** subtracted. `cost` is dropped.
- **`gemini-cli` and `antigravity` share `~/.gemini`** and are carefully kept from claiming each
  other's tree.

## The store version

`PRAGMA user_version` holds it; it is hand-owned, a shipped migration is never edited, and a store
from a newer build is **refused** rather than opened. It is migrated rather than discarded because
the store can outlive the logs it was built from.
