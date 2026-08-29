# Claude Code: usage logs

Provider id `claude-code`, declared in `src/usage/providers/claude-code.ts`. It is the default
for every `usage` command.

## Log root

`$CLAUDE_CONFIG_DIR` when set, `~/.claude` otherwise, overridden by `--logs <dir>`. The root
counts as present only when it contains a `projects/` directory.

## Layout

```text
projects/<slug>/<session-uuid>.jsonl                        main transcript
projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl   subagent transcript
projects/<slug>/<session-uuid>/subagents/agent-<id>.meta.json
```

Discovery walks `projects/<slug>/` for `*.jsonl` files, and — unless `--no-subagents` — one
level further into `<session-uuid>/subagents/`. Claude Code is the **only** provider that
records subagent status in the transcript's _path_, so it is the only one that can drop
subagents before opening anything; the others have to read the file first.

Files are sorted by byte comparison of their root-relative path, never `localeCompare`, so the
scan order does not depend on the ICU build of the machine that ran it.

`<slug>` is the working directory with separators replaced. It is lossy, so it is used only as
a cache shard key. Project identity comes from the `cwd` field inside the records.

## Record shape

Every line is a JSON object. The fields the parser reads:

```jsonc
{
  "type": "assistant", // assistant | user | attachment | system | custom-title | ai-title
  "subtype": "api_error", // on system records
  "timestamp": "2026-08-29T...", // ISO, UTC. A record with no timestamp files under no day.
  "sessionId": "…", // NOT session_id — see below
  "cwd": "/path/to/project",
  "gitBranch": "main",
  "version": "…", // the Claude Code version that wrote it
  "isMeta": false,
  "promptSource": "typed",
  "message": {
    "id": "msg_…",
    "model": "claude-opus-…",
    "content": [{ "type": "tool_use", "name": "Read", "input": {} }],
    "usage": {},
  },
  "attachment": { "type": "hook_success", "hookName": "…", "exitCode": 0, "durationMs": 12 },
  "hookInfos": [{ "durationMs": 12 }],
  "hookErrors": [],
}
```

### `session_id` is a trap

Records carry **both** `sessionId` (camel) and `session_id` (snake), and the snake-case value
is different and stale. `sessionId` is the one that matches the filename. Keying on the wrong
one merges unrelated sessions. `tests/unit/usage-parse.test.ts` pins this.

## Token counting

`message.usage` is read once per response:

| Field                                      | Reported as         |
| ------------------------------------------ | ------------------- |
| `input_tokens`                             | input               |
| `output_tokens`                            | output              |
| `cache_read_input_tokens`                  | cache read          |
| `cache_creation_input_tokens`              | cache write         |
| `cache_creation.ephemeral_5m_input_tokens` | cache write, 5m TTL |
| `cache_creation.ephemeral_1h_input_tokens` | cache write, 1h TTL |
| `output_tokens_details.thinking_tokens`    | thinking            |
| `server_tool_use.web_search_requests`      | web search          |
| `server_tool_use.web_fetch_requests`       | web fetch           |

Unlike Codex, `input_tokens` **excludes** cache reads, so nothing is subtracted out.

The two TTL figures are a split of the authoritative `cache_creation_input_tokens` total. The
oldest records carry no split, so the two can sum to less than the total and never to more.

### The response fan-out

**Claude Code writes one JSONL line per content block, and every one of those lines carries an
identical full copy of `message.usage`.** Summing lines over-counts output tokens by roughly
two and a half fold.

Usage is therefore taken **once per `message.id`**. Tool-use blocks are still counted per line,
because there really is one tool call per line.

`usage.iterations[]` mirrors the same fields rather than adding to them, and is deliberately
not read: summing it on top would double every request that has it while leaving older records
untouched.

### Synthetic records

Records with `model: "<synthetic>"` are generated locally rather than by calling a model. They
have a null `requestId`, a non-`msg_` id, and all-zero counters, and are excluded.

## What else is counted

| Signal         | Read from                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Tool calls     | `tool_use` content blocks on assistant records, per line                                                                         |
| Subagents      | a `tool_use` block named `Agent` (or `Task`, for older logs); the type is `input.subagent_type`, defaulting to `general-purpose` |
| Skills         | a `tool_use` block named `Skill`, plus `invoked_skills` and `dynamic_skill` attachments                                          |
| Prompts        | user records with `promptSource: "typed"` and `isMeta !== true`                                                                  |
| Slash commands | `<command-name>…</command-name>` inside the user message text — not a field                                                      |
| Hooks          | `hook_success` and `hook_cancelled` attachments, plus `stop_hook_summary` system records                                         |
| Errors         | system records with `subtype: "api_error"`                                                                                       |
| Compactions    | system records with `subtype: "compact_boundary"`                                                                                |
| Session title  | the last `custom-title` or `ai-title` record in file order                                                                       |

Slash commands are not a structured field; they arrive as a block inside the user's message
text and are extracted by pattern.

### Hooks are reported on two surfaces

A `hook_success` attachment carries `hookName`, `exitCode`, and `durationMs`: a nonzero exit is
a failure, and the duration feeds both a running total and a maximum. `hook_cancelled` counts an
execution and a cancellation.

Stop hooks do **not** appear as attachments. They report through a `stop_hook_summary` system
record, with one `hookInfos` entry per execution and a `hookErrors` array. Counting both
surfaces would double-count a single execution, so Stop is taken only from the summary.

`hookErrors` is why the event stream has a `hook_error` kind at all: Claude Code reports
failures there with **no matching execution record**, so a hook's failure count and its
execution count legitimately diverge. Emitting a `hook` event for each would invent runs that
never happened.

## Subagents

Subagent transcripts routinely outnumber main transcripts about six to one and hold more bytes,
so they are scanned by default. `--no-subagents` prunes them at discovery.

A subagent transcript's own records carry the **parent's** `sessionId`, and the parent session
id is also its containing directory, so neither has to be read out of the file. The agent id is
the filename with the `agent-` prefix stripped.

`agent-<id>.meta.json` beside the transcript supplies `agentType` and `spawnDepth`. A missing
or unparseable meta file costs those two fields and nothing else.

**A subagent's tokens come from its own transcript.** The parent's
`toolUseResult.totalTokens` is the subagent's _final message only_ and understates real spend
several-fold; it is not used.

## Capabilities

| Capability              | Supported |
| ----------------------- | --------- |
| tokens                  | yes       |
| cache read/write detail | yes       |
| tools                   | yes       |
| skills                  | yes       |
| subagents               | yes       |
| hooks                   | yes       |
| MCP                     | yes       |
| slash commands          | yes       |
| projects                | yes       |

Claude Code is the only registered provider that can answer every one of these.

## Failure handling

A line that will not parse increments `malformedLines` and the scan continues. A truncated
final line is routine in a transcript that is still being appended to, so it is reported in the
payload under `scan` rather than thrown. `usage` exits `2` for it only under `--strict`.

## Related

- [Shared usage command behavior](../../commands/usage/common.md)
- [Usage store format](../../formats/usage-store.md)
- [Archiving](archiving.md) — the same transcripts, kept rather than counted
