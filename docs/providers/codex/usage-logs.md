# Codex: usage logs

Provider id `codex`, declared in `src/usage/providers/codex.ts`. Select it with
`--provider codex`, or include it in a merged report with `--provider all`.

## Log root

`$CODEX_HOME` when set, `~/.codex` otherwise, overridden by `--logs <dir>`. The root counts as
present only when it contains a `sessions/` directory.

## Layout

```text
sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl
```

Discovery walks exactly three directory levels below `sessions/` and takes files that start
with `rollout-` and end with `.jsonl`.

**The date directories and the filename stamp are local time. Every timestamp inside a record
is UTC.** Deriving a day from the path would misfile every session near a day boundary by the
machine's UTC offset, so days always come from the records. The path becomes the cache shard
key — `YYYY-MM-DD` — where it is a naming convention rather than a claim about when anything
happened.

Discovery cannot tell a subagent thread from a main one, because that fact lives inside the
file. Every discovered file is provisionally `kind: "main"`; the parser sets the real value and
`src/usage/scan.ts` filters on that. `--no-subagents` therefore saves nothing on Codex — the
answer is the same, the work is not.

## Record shape

Every line is `{ timestamp, ordinal?, type, payload }`. Line 1 is a `session_meta` header; the
rest are a discriminated union on `payload.type`.

### The header

Only **line 1** is trusted. A few files carry a second `session_meta` for an ancestor thread,
and reading it would overwrite the thread's own identity.

```jsonc
{
  "type": "session_meta",
  "timestamp": "2026-08-29T12:00:00Z",
  "payload": {
    "id": "…", // this thread's own id -> sessionId
    "session_id": "…", // the root it descends from -> parentSessionId
    "parent_thread_id": "…", // fallback for the above
    "thread_source": "subagent",
    "agent_role": "reviewer", // -> agentType
    "agent_path": "…",
    "agent_nickname": "…", // -> session title
    "cwd": "/path/to/project",
    "cli_version": "…",
    "git": { "branch": "main" },
    "source": { "subagent": { "thread_spawn": { "depth": 1 } } },
  },
}
```

`payload.id` and `payload.session_id` differ on subagent and forked threads. `source` is a bare
string on legacy files and an object on current ones, so the spawn depth is read defensively.

### Body records

| `payload.type`            | Read for                                                        |
| ------------------------- | --------------------------------------------------------------- |
| `token_count`             | token usage, from `info.total_token_usage`                      |
| `custom_tool_call`        | a tool call, by `payload.name`                                  |
| `function_call`           | a tool call, named `namespace.name` when a namespace is present |
| `mcp_tool_call_end`       | an MCP call, named `mcp__<server>__<tool>`                      |
| `web_search_end`          | a `web.search` tool call                                        |
| `user_message`            | a prompt                                                        |
| `context_compacted`       | a compaction                                                    |
| `item_completed`          | skills and `$name` commands, when `item.type` is `UserMessage`  |
| `thread_settings_applied` | the model in force                                              |

The model is also updated by any record whose top-level `type` is `turn_context`. Model can
change mid-session, so it is tracked as a running value and each token delta is attributed to
whatever was in force at the time.

### `response_item` versus `event_msg`

Codex writes the same activity twice: `response_item` is the raw API view and `event_msg` the
UI view. **Tool calls are counted from `response_item` only** — counting both doubles every
call.

MCP calls and web searches have no `response_item` counterpart, so they are taken from
`event_msg` with no risk of double-counting. That asymmetry is deliberate and is what makes the
tool counts add up.

## Token counting

This is the part that is easiest to get wrong, and the errors are factors rather than
roundings.

### The figure is cumulative

`info.total_token_usage` is a **running total for the thread**. Per-request usage is the
difference between consecutive readings:

```text
request tokens = clamp(current - previous, 0)
```

The clamp matters: a resumed or forked thread can replay a lower reading, and a negative token
count is never the right answer.

`info.last_token_usage` sits beside it and looks like the per-request figure you want. It is
not usable: it is **re-emitted unchanged on duplicate events**, and summing it inflates the
total by about 4% (measured over one session). The delta of the cumulative figure is exact by
construction, and it is what makes per-day attribution possible at all.

A duplicate re-emission carries the same cumulative figure and therefore a zero delta. A
zero-token delta is dropped rather than counted, so it does not inflate the request count.

`info` is `null` on a handful of records corpus-wide; those are skipped.

### Cache reads are inside the input figure

`input_tokens` **includes** `cached_input_tokens`, unlike Claude Code's. The cached part is
subtracted out and reported separately as a cache read:

| Raw field                  | Reported as                            |
| -------------------------- | -------------------------------------- |
| `input_tokens`             | input, **minus** `cached_input_tokens` |
| `cached_input_tokens`      | cache read                             |
| `cache_write_input_tokens` | cache write                            |
| `output_tokens`            | output                                 |
| `reasoning_output_tokens`  | thinking                               |

Skipping the subtraction overstates Codex input roughly eight-fold, and makes Codex look
several times more expensive than the same work under Claude Code.

There is no TTL split, and no web-search or web-fetch counter.

## Subagents

A thread is a subagent when its header carries `thread_source: "subagent"`. The parent is
`payload.session_id`, falling back to `payload.parent_thread_id`; the agent role and path come
from `agent_role` and `agent_path`; the spawn depth from
`source.subagent.thread_spawn.depth`.

Subagent spawns are also counted from the parent side: a `function_call` named `spawn_agent`
increments the agent counter, with the type read from the JSON `arguments` field's
`agent_type`. A spawn whose arguments will not parse still happened, and is counted as
`(unrecorded)`.

## Skills and slash commands

Both come from `item_completed` records whose `item.type` is `UserMessage`:

- a content part with `type: "skill"` names an invoked skill
- a `text_elements[].placeholder` beginning with `$` is Codex's slash-command analogue, and the
  only place a command is named

## Capabilities

| Capability              | Supported | Why not                                                                                  |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------- |
| tokens                  | yes       |                                                                                          |
| cache read/write detail | yes       |                                                                                          |
| tools                   | yes       |                                                                                          |
| skills                  | yes       |                                                                                          |
| subagents               | yes       |                                                                                          |
| hooks                   | **no**    | configured in `~/.codex/hooks.json`, but no execution is ever recorded in a rollout file |
| MCP                     | yes       |                                                                                          |
| slash commands          | yes       |                                                                                          |
| projects                | yes       |                                                                                          |

`usage hooks --provider codex` says the provider cannot answer and exits `0`, rather than
printing an empty table that would read as "you never ran a hook".

## Failure handling

Same as every provider: a line that will not parse increments `malformedLines`, the scan
continues, and the count is reported under `scan`. Exit `2` only under `--strict`.

## Related

- [Shared usage command behavior](../../commands/usage/common.md)
- [Usage store format](../../formats/usage-store.md)
- `tests/unit/usage-codex.test.ts` pins the cumulative differencing and the cache subtraction
