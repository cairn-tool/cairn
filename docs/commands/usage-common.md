# Shared usage command behavior

Every command below `cairn usage` reads an assistant's own session logs and reports on
them. Nothing is sent anywhere, and nothing outside the scan cache is written.

## Common options

Every `usage` subcommand except [`usage providers`](usage-providers.md) accepts these. Each
command page lists only the options particular to it.

| Option              | Default       | Description                                                           |
| ------------------- | ------------- | --------------------------------------------------------------------- |
| `--format <fmt>`    | `llm`         | `llm`, `human`, or `json`. Not configurable.                          |
| `--envelope`        | `false`       | Wrap `--format json` output in the result envelope.                   |
| `--provider <name>` | `claude-code` | Log source to report on. See [`usage providers`](usage-providers.md). |
| `--project <path>`  | Every project | Limit to a project path, slug, or name. Repeatable.                   |
| `--since <spec>`    | Unbounded     | Earliest day: `7d`, `2w`, `3m`, `1y`, or an ISO date. Inclusive.      |
| `--until <spec>`    | Unbounded     | Latest day, same forms as `--since`. Inclusive.                       |
| `--last <n>`        | Every session | Keep only the n most recently active sessions.                        |
| `--top <n>`         | `20`          | Rows to show; `0` for all. `totals` is unaffected.                    |
| `--logs <dir>`      | Discovered    | Read logs from this directory instead of the discovered one.          |
| `--no-subagents`    | —             | Exclude subagent transcripts.                                         |
| `--no-index`        | —             | Bypass the scan cache; neither read it nor write it.                  |
| `--strict`          | `false`       | Exit `2` when a transcript could not be fully read.                   |
| `-h`, `--help`      | —             | Show help.                                                            |

`-fh` expands to `--format=human` and `-fj` to `--format=json` before argument parsing.

## Where the logs come from

`--logs` overrides discovery for a single provider; it cannot be combined with `--provider all`,
because one directory cannot be several providers' log root.

### `claude-code`

`$CLAUDE_CONFIG_DIR` when set, `~/.claude` otherwise.

```text
projects/<slug>/<session-uuid>.jsonl                       main transcript
projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl  subagent transcript
```

### `codex`

`$CODEX_HOME` when set, `~/.codex` otherwise.

```text
sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl
```

The date directories and the filename stamp are **local time**, while every timestamp inside a
record is UTC, so days always come from the records rather than the path.

### `antigravity`

`~/.gemini/antigravity-cli` — the CLI. The IDE keeps its own store encrypted at rest, and it is
not attempted. One conversation is split across two files joined by a shared id:

```text
conversations/<id>.db                                tokens, model, workspace, git, agent
brain/<id>/.system_generated/logs/transcript.jsonl   tools, timeline, prompts, errors
history.jsonl                                        slash commands
```

### Subagents

Subagent transcripts are included by default. On a real corpus they routinely outnumber main
transcripts several times over and account for a large share of all tokens, so excluding them
with `--no-subagents` makes the headline numbers a main-thread figure rather than a total.

Only `claude-code` records a subagent in the transcript's _path_, so only it can drop them
before opening anything. The others record it inside the file, so `--no-subagents` filters them
after reading rather than before — the answer is the same, the saving is not.

## Counting

Every provider is normalized onto one token model, which means undoing a different distortion in
each. These are not cosmetic differences: getting any of them wrong changes the answer by a
factor, not a rounding.

| Provider      | What the log records                                                                                     | What is done with it                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `claude-code` | One API response written as several lines, each carrying an identical full copy of its usage             | Deduplicated by response; summing the lines over-counts output roughly two and a half fold |
| `codex`       | A **running total** per thread, alongside a per-request field that is re-emitted unchanged on duplicates | Consecutive totals are differenced; summing the per-request field inflates by about 4%     |
| `antigravity` | A **per-request** context size that is not a running total — it falls whenever context is trimmed        | Summed; differencing it would produce nonsense                                             |

Codex counts cache reads _inside_ its input figure, unlike the others, so the cached part is
subtracted out and reported as a cache read. Left merged, Codex input reads several times higher
than the same work under Claude Code.

Records an assistant generated locally rather than by calling a model carry no usable counters
and are excluded.

A subagent's tokens come from its own transcript. Where a parent records the call's cost at all,
it reports only the subagent's final message, which understates the real figure several-fold,
and is not used.

## What each provider can answer

Not every assistant records everything. What a provider can report is data it declares, which
the reports read rather than branching on its name — so a command whose subject a provider does
not record says so and exits `0`, rather than printing an empty table that would read as "you
never did this".

|                           | `claude-code` | `codex` | `antigravity` |
| ------------------------- | ------------- | ------- | ------------- |
| tokens                    | yes           | yes     | yes           |
| cache read / write detail | yes           | yes     | no            |
| tools                     | yes           | yes     | yes           |
| MCP                       | yes           | yes     | no            |
| skills                    | yes           | yes     | no            |
| subagents                 | yes           | yes     | yes           |
| hooks                     | yes           | no      | no            |
| slash commands            | yes           | yes     | yes           |

Codex configures hooks but records no execution of one; Antigravity's only hook appears as prose
inside a system message, and counting a substring of free text is a guess rather than a
measurement. Antigravity records no cache breakdown at all, so its input figure is context
processed — a prompt prefix counted once per turn — rather than unique input.

`usage providers` prints this table for the providers actually present on your machine.

## Reporting across providers

`--provider all` merges every registered provider that has logs here. Each keeps its own scan
cache, and every figure carries the provider that produced it, so `usage tokens --by provider`
and `usage tools --by provider` break a merged report back down.

A session id is unique only within the assistant that issued it, so sessions are counted per
provider; two providers using the same id are two sessions, not one.

## What the totals do and do not cover

These numbers describe requests that produced a recorded assistant turn. Background calls that
leave no such turn — session-title generation, some compaction work — are not in the
transcripts and so are not counted. Treat the output as a faithful account of recorded activity
rather than as a billing statement.

Token totals include cache reads, which on a long session are most of what a request costs in
context. Cache writes report an authoritative total alongside a split by TTL; the oldest
records carry no split, so the two TTL figures can sum to less than the total, and never to
more.

## Time windows

`--since` and `--until` are inclusive **day** bounds, because the scan index stores per-day
buckets. A relative span is a span rather than a calendar unit: `3m` is 90 days and `1y` is 365.

A lower bound also prunes the walk by file modification time before anything is opened, which
is what makes `--since 7d` cheap over a large corpus.

## Project selection

Project identity is the working directory recorded inside the transcripts, not the log
directory name — that name substitutes both path separators and underscores and cannot be
reliably turned back into a path.

`--project` accepts a path (`.`, `./x`, `~/dev/app`, `/abs/path`), which matches that directory
and everything under it, or a bare name, which matches any project path containing it, case
insensitively.

## The scan cache

Each transcript is reduced once and stored under `$XDG_CACHE_HOME/cairn/usage/<provider>/`
(or `~/.cache/...`), one shard per project. The key is each file's path, size, and modification
time: a transcript that has not changed cannot hold a record the stored aggregate is missing, so
only files that grew are reopened. Providers cache separately, so adding one does not invalidate
another's work.

A filtered scan merges into the stored shards rather than replacing them, so a `--since` run
never evicts what a full run had already done. See [`usage index`](usage-index.md) to inspect,
rebuild, or clear it.

The cache is private and self-invalidating. Its internal format is not part of the published
contract and can change without notice; a mismatch costs a re-parse, never a wrong answer.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

A scan over thousands of transcripts routinely meets a file removed mid-walk or a truncated
final line in a session still being appended to. Those are counted under `scan` in the payload
and reported, never fatal, because failing by default would make the command useless in the
automated context it is most wanted in. `--strict` is how a caller opts into caring.
