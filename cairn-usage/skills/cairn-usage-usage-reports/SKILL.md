---
name: usage-reports
description: Report on local LLM assistant usage with the cairn usage toolset — tokens by model or day, tool calls, sessions, projects, skills, subagents, hooks, and slash commands. Use when asked what an assistant cost, what it spent time on, which tools or skills were used, or how usage compares across projects or time.
---

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
