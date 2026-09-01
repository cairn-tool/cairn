# Usage reporting

What the `usage` toolset reads, what it counts, and why its numbers differ from a raw count of the log files.

Coding assistants leave a structured record of every session on disk. The `usage` toolset reads
those transcripts and reports on them — tokens, tools, skills, subagents, hooks, slash commands —
so "where is my context actually going" is a question with an answer. Nothing is sent anywhere,
and nothing outside the usage store is written.

Six log sources are registered: **Claude Code**, **Codex CLI**, **Antigravity CLI**,
**Gemini CLI**, **OpenCode**, and **Cursor**.

```bash
cairn usage summary                        # headline totals across every project
cairn usage summary --since 7d --project . # this week, this repository
cairn usage tokens --by day --since 30d    # spend over time
cairn usage tools --by server --kind mcp   # which MCP servers get used
cairn usage sessions --sort tokens --top 10
cairn usage agents                         # what delegation really costs
cairn usage hooks                          # hook latency and failures

cairn usage providers                      # what is registered, and what each records
cairn usage summary --provider codex
cairn usage summary --provider all         # every assistant, merged
cairn usage tokens --by provider --provider all

cairn usage import --provider all          # warm the store deliberately
cairn usage index                          # what the store holds
cairn usage migrate --check                # is the store current
```

Two things make the numbers trustworthy, and both are easy to get wrong. One API response is
written to the transcript as several lines, each carrying an identical copy of that response's
token usage, so summing the lines over-counts by roughly a factor of two; counts here
deduplicate by response. And a subagent's cost is recorded in the parent only as its _final_
message, understating the real figure several-fold, so subagent tokens are read from the
subagent's own transcript. Subagents are included by default — on a real corpus they account for
more tokens than the main thread — and `--no-subagents` excludes them.

Each transcript is reduced once into a SQLite store at `$XDG_DATA_HOME/cairn/usage.db`, keyed on
its size and modification time. Transcripts are append-only, so only files that grew are ever
reopened: a first import of a multi-gigabyte corpus takes about a minute and every later one is
immediate. `usage index` inspects it, `usage import` fills it, and `usage migrate` moves it
between versions.

The store keeps two grains. The reports above read a day rollup of a few tens of thousands of
rows. Underneath it is a per-occurrence `event` table that no report reads, so that questions a
day bucket cannot express can be asked of the file directly:

```sql
-- tokens by hour of day, which no --by dimension can produce
SELECT substr(ts, 12, 2) AS hour,
       SUM(input + output + cache_read + cache_write) AS tokens
  FROM event WHERE kind = 'response' GROUP BY hour ORDER BY hour;
```

It is a plain SQLite file, so DuckDB can read it directly
(`INSTALL sqlite; ATTACH '...usage.db' AS usage (TYPE sqlite);`) if a columnar engine suits the
question better. The store lives under `XDG_DATA_HOME` rather than `XDG_CACHE_HOME` because it is
data: once transcripts are archived and pruned it may be the only record of that usage left, so
it is migrated forward across versions rather than discarded.

`--provider` selects the log source and `--provider all` merges every one present on the machine.
What a provider can answer is data it declares rather than a branch in the reports, so a further
assistant's logs are one new module and one registry line away from joining the same subcommands.

See [shared usage command behavior](../commands/usage/common.md) for the full option set, the
time-window and project-selection rules, and what the totals do and do not cover. Each provider's
transcript format and counting caveats are documented separately:
[Claude Code](../providers/claude-code/usage-logs.md),
[Codex](../providers/codex/usage-logs.md),
[Antigravity](../providers/antigravity/usage-logs.md),
[Gemini CLI](../providers/gemini-cli/usage-logs.md),
[OpenCode](../providers/opencode/usage-logs.md), and
[Cursor](../providers/cursor/usage-logs.md).

## Related

- [Shared usage command behavior](../commands/usage/common.md) — discovery, counting, windows, and the store.
- [Usage store](../formats/usage-store.md) — the SQLite schema and its hand-owned version.
- [Providers](../providers.md) — what each assistant's log format does to the numbers.
