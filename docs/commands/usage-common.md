# Shared usage command behavior

Every command below `claude-cli usage` reads an assistant's own session logs and reports on
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

For the `claude-code` provider, the log root is `$CLAUDE_CONFIG_DIR` when set and `~/.claude`
otherwise, and `--logs` overrides both. Under it:

```text
projects/<slug>/<session-uuid>.jsonl                       main transcript
projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl  subagent transcript
```

Subagent transcripts are included by default. On a real corpus they routinely outnumber main
transcripts several times over and account for a large share of all tokens, so excluding them
with `--no-subagents` makes the headline numbers a main-thread figure rather than a total.

## Counting

One API response is written to the transcript as several lines, one per content block, each
carrying an identical full copy of that response's token usage. Counts here deduplicate by
response, so they are roughly a factor of two below what summing the lines would give. Tool
calls really are one per line and are counted per line.

Records the assistant generated locally rather than by calling a model carry no usable counters
and are excluded.

A subagent's tokens come from its own transcript. The parent's record of the call reports only
the subagent's final message, which understates the real figure several-fold, and is not used.

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

Each transcript is reduced once and stored under `$XDG_CACHE_HOME/claude-cli/usage/<provider>/`
(or `~/.cache/...`), one shard per project. The key is each file's path, size, and modification
time: transcripts are append-only, so an unchanged file cannot hold a record the stored
aggregate is missing, and only files that grew are reopened.

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
