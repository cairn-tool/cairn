# Antigravity: usage logs

Provider id `antigravity`, declared in `src/usage/providers/antigravity.ts`. Select it with
`--provider antigravity`, or include it in a merged report with `--provider all`.

## Log root

`~/.gemini/antigravity-cli`, overridden by `--logs <dir>`. There is no environment variable.
The root counts as present only when it contains a `conversations/` directory.

The IDE's own store, `~/.gemini/antigravity/conversations/*.pb`, is encrypted at rest and is
deliberately not attempted.

## Two stores, one id

Antigravity splits a conversation across two files in two formats, joined by an id that is
simultaneously the SQLite filename stem, the brain directory name, and `history.jsonl`'s
`conversationId` — verified at 501 of 501 conversations.

```text
conversations/<id>.db                                tokens, model, workspace, git, identity
brain/<id>/.system_generated/logs/transcript.jsonl   tools, timeline, prompts, errors
history.jsonl                                        slash commands
```

The division of labor between them is a rule, not a convenience:

> **The JSONL carries named fields Google cannot silently renumber, and is the source for
> everything it can answer. The SQLite half is protobuf with no published schema — field
> numbers only — so it supplies only what exists nowhere else, behind a validity guard.**

If that guard fails, the token column is lost and the rest of the provider keeps working.

## Discovery

Discovery lists `conversations/*.db`. The `-wal` and `-shm` sidecars are live write state, not
trajectories, and are skipped.

Whether a trajectory is a subagent is recorded _inside_ it, so every discovered file is
provisionally `kind: "main"` and `src/usage/scan.ts` filters on the parsed value.
`--no-subagents` therefore prunes nothing at discovery on this provider.

Databases are opened **read-only**: two of them carry live `-wal` sidecars.

## The SQLite half

Three tables are read, all of them protobuf blobs.

### `trajectory_metadata_blob` — identity

`SELECT data FROM trajectory_metadata_blob LIMIT 1`, decoded as a message:

| Path           | Field                                   |
| -------------- | --------------------------------------- |
| `1.1`          | workspace, as a `file://` URI → project |
| `1.4`          | git branch                              |
| `2`            | started-at timestamp                    |
| `4.1` or `8.1` | agent type                              |
| `8.2`          | title                                   |
| `5`            | parent conversation id                  |

These are string fields, and a string field validates itself — a workspace is a `file://` URI
or it is not one — so they need no numeric guard. A parent id that differs from the
conversation's own id marks it a subagent.

### `steps` — token usage

`SELECT step_payload FROM steps WHERE step_type = 15` — step type 15 is LLM generation, the
only step kind carrying a usage message. Within a step payload:

| Field | Meaning                  |
| ----- | ------------------------ |
| `5`   | the wrapper message body |
| `5.1` | the step timestamp       |
| `5.9` | the usage message        |

And within the usage message:

| Field | Meaning           |
| ----- | ----------------- |
| `3`   | completion tokens |
| `5`   | prompt tokens     |
| `9`   | thinking tokens   |
| `10`  | output tokens     |

### `gen_metadata` — model

`SELECT data FROM gen_metadata ORDER BY idx LIMIT 1`, then field `1`, then field `19` falling
back to field `21`. The model family does not vary within a trajectory. Anything unreadable
reports `(unknown)` rather than failing.

## The protobuf guard

Field numbers are all there is to go on, so two invariants are checked on **every** usage
record before any of it is trusted:

```text
completion == thinking + output
0 <= prompt <= 2,000,000
```

The first held in every record inspected. The second is a bound: the largest prompt seen
anywhere in the corpus was 118,471.

A field that stops satisfying either is not the field we think it is. **On failure the whole
token read returns null**: no tokens are emitted for that conversation, every JSONL-derived
figure is kept, and the provider carries on. Emitting a renumbered field's value as a token
count would be worse than emitting nothing, because it would look like an answer.

The reader itself (`src/usage/providers/protobuf.ts`) is a hand-rolled wire-format decoder
rather than a dependency: there is no schema to compile against, and the wire format is four
cases. It is deliberately **total rather than strict** — an unknown wire type stops the scan and
returns what was read so far, because a partial decode the caller can validate is more useful
than an exception from a format nobody published. Every consumer treats a missing field as
absent and never assumes.

## Token counting

**Prompt tokens are a per-request context size, not a running total.** They were measured
falling 1,479 times across the corpus, as context is trimmed. They are therefore **summed**,
never differenced — the exact opposite of Codex, where differencing is mandatory.

| Raw field    | Reported as |
| ------------ | ----------- |
| prompt (5)   | input       |
| output (10)  | output      |
| thinking (9) | thinking    |

What that sum represents is **context processed**, which re-counts a prompt prefix once per
turn. It is reported as input because no cache breakdown exists anywhere on disk to separate
unique input from re-read context. Comparing Antigravity's input figure directly against Claude
Code's is comparing two different quantities.

There is no cache-read or cache-write column, no TTL split, and no web-search or web-fetch
counter.

## The JSONL half

`transcript.jsonl` rather than `transcript_full.jsonl`: the two share a schema and differ only
in whether long strings are truncated, so the short one carries every structural fact at
roughly two thirds the bytes.

```jsonc
{
  "type": "USER_INPUT", // USER_INPUT | ERROR_MESSAGE | CHECKPOINT | …
  "source": "USER_EXPLICIT",
  "status": "ERROR",
  "created_at": "2026-08-29T…",
  "tool_calls": [{ "name": "…" }],
}
```

| Signal     | Condition                                           |
| ---------- | --------------------------------------------------- |
| tool call  | each entry in `tool_calls`, by `name`               |
| prompt     | `type: "USER_INPUT"` with `source: "USER_EXPLICIT"` |
| error      | `type: "ERROR_MESSAGE"` or `status: "ERROR"`        |
| compaction | `type: "CHECKPOINT"`                                |

A record with no `created_at` files under no day and is skipped. About one line in a thousand
is torn by an interleaved append and will not parse; those increment `malformedLines` and are
never fatal.

## Slash commands

`history.jsonl` is a single small file at the log root rather than one per conversation, so it
is read once per root and memoized. Rows with `type: "slash_command"` carry a `conversationId`
and a `display` string, whose first whitespace-delimited token is the command name.

Two consequences:

- **A conversation's cached aggregate keys on its database**, so a slash command recorded after
  that database last changed will not appear until it changes again. That is an accepted trade
  for not re-reading the history file five hundred times.
- **`history.jsonl` records no per-use timestamp**, so every use is stamped with the
  conversation's first timestamp and files under that day.

## Subagents

A trajectory is a subagent when the identity blob's parent field (5) differs from its own id.
The agent type comes from field `4.1` or `8.1`, and is used as both `agentType` and
`agentPath` — Antigravity records no separate path.

## Capabilities

| Capability              | Supported | Why not                                                                                                                    |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| tokens                  | yes       |                                                                                                                            |
| cache read/write detail | **no**    | no breakdown exists anywhere on disk                                                                                       |
| tools                   | yes       |                                                                                                                            |
| skills                  | **no**    | skills are configured, but no per-invocation record is written                                                             |
| subagents               | yes       |                                                                                                                            |
| hooks                   | **no**    | a stop hook appears only as prose inside a system message; counting a substring of free text is a guess, not a measurement |
| MCP                     | **no**    | no MCP tool has ever fired here, and a tool name carries no server                                                         |
| slash commands          | yes       |                                                                                                                            |
| projects                | yes       |                                                                                                                            |

A report whose subject the provider cannot answer says so and exits `0`, rather than printing
an empty table that would read as "you never did this".

## Failure handling

Three independent degradations, and each costs only its own column:

| Failure                       | Cost                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `node:sqlite` unavailable     | everything from the database; the JSONL half still parses |
| database unreadable or locked | the same                                                  |
| protobuf guard fails          | the token column only                                     |
| torn JSONL line               | that line; counted in `malformedLines`                    |

`usage` exits `2` for any of these only under `--strict`.

## Related

- [Shared usage command behavior](../../commands/usage/common.md)
- [Usage store format](../../formats/usage-store.md)
- `tests/unit/usage-antigravity.test.ts` pins the summing and the guard
