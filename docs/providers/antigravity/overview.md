# Antigravity

Google's Antigravity CLI. The mirror image of Cursor: it is a usage log source and an archive
source, and not a conversion target.

| Role              | Supported | Identifier    | Declared in                          |
| ----------------- | --------- | ------------- | ------------------------------------ |
| Conversion target | **no**    | —             | no target profile exists             |
| Usage log source  | yes       | `antigravity` | `src/usage/providers/antigravity.ts` |
| Archive source    | yes       | `antigravity` | `src/archive/sets.ts`                |

It is also the hardest provider to read. A conversation is split across two stores in two
different formats, one of which is **schema-less protobuf** with no published `.proto` — field
numbers reverse-engineered from `--decode_raw` against real trajectories, and guarded at
runtime because a renumbering has to fail loudly rather than produce a plausible wrong number.

## Where things live

`~/.gemini/antigravity-cli`. There is no environment override; only `--logs <dir>`.

```text
~/.gemini/antigravity-cli/
  conversations/<id>.db                                 tokens, model, workspace, git, identity
  conversations/<id>.db-wal, <id>.db-shm                live write sidecars
  brain/<id>/implementation_plan.md                     plan documents
  brain/<id>/walkthrough.md, task.md, …                 other session output
  brain/<id>/.system_generated/logs/transcript.jsonl    tools, timeline, prompts, errors
  brain/<id>/.system_generated/logs/transcript_full.jsonl
  history.jsonl                                         slash commands
  log/*.log                                             CLI logs
```

One `<id>` joins all three surfaces: it is simultaneously the SQLite filename stem, the brain
directory name, and `history.jsonl`'s `conversationId`. That correspondence was verified at 501
of 501 conversations on a real corpus.

A conversation's `brain/<id>/` holds `.system_generated/` — the machinery — and, at its top
level, whatever the session actually produced. That single directory name is what tells output
from machinery, which is why every archive set tests for it rather than listing filenames.

## The IDE store is not attempted

Antigravity's IDE keeps its own conversation store at
`~/.gemini/antigravity/conversations/*.pb`. It is **encrypted at rest** and is deliberately not
read. Only the CLI's store is.

## Host profile

There is none — Antigravity is not a conversion target, so no `TargetProfile` exists for it and
`agent specs` does not list it. See [Agent bundles](agent-bundles.md).

## Pages

- [Agent bundles](agent-bundles.md) — why there is no target profile
- [Usage logs](usage-logs.md) — the two-store format and the protobuf guard
- [Archiving](archiving.md) — the artifact sets

## Caveats worth knowing up front

- **Prompt tokens are a per-request context size, not a running total.** They were measured
  falling 1,479 times across the corpus as context is trimmed. They are summed, never
  differenced — the opposite of Codex.
- **What that sum means is context processed**, which re-counts a prompt prefix once per turn.
  It is reported as input because no cache breakdown exists anywhere on disk to separate the
  two.
- **The token column can be lost without losing the conversation.** If the protobuf guard
  fails, every JSONL-derived figure is kept and no tokens are emitted at all.
- **About one transcript line in a thousand is torn** by an interleaved append and will not
  parse. Those are counted, never fatal.
- **`history.jsonl` records no per-use timestamp**, so every slash command is stamped with the
  conversation's first timestamp.
