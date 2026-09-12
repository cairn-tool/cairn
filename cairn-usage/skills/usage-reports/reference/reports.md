# Usage reporting commands in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats, exit codes, and config
discovery.

## Shared options

Every reporting command takes these:

| Option              | Default       | Meaning                                              |
| ------------------- | ------------- | ---------------------------------------------------- |
| `--provider <name>` | `claude-code` | Log source to report on, or `all`                    |
| `--project <path>`  | —             | Limit to a project path, slug, or name (repeatable)  |
| `--since <spec>`    | —             | Earliest day: `7d`, `2w`, `3m`, `1y`, or an ISO date |
| `--until <spec>`    | —             | Latest day, same forms                               |
| `--last <n>`        | —             | Keep only the n most recently active sessions        |
| `--top <n>`         | `20`          | Rows to show; `0` for all                            |
| `--logs <dir>`      | discovered    | Read logs from here instead                          |
| `--no-subagents`    | off           | Exclude subagent transcripts                         |
| `--no-index`        | off           | Bypass the store; neither read nor write it          |
| `--strict`          | off           | Exit `2` when a transcript could not be fully read   |

`--since`/`--until` are **day-granular**. The lower bound also prunes the walk by file mtime
before anything is opened, which is why a narrow range is much faster.

## The commands

| Command           | `--by` dimensions                                                 | Other options                            |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `usage summary`   | —                                                                 | —                                        |
| `usage tokens`    | `model`, `day`, `week`, `month`, `project`, `session`, `provider` | —                                        |
| `usage tools`     | `name`, `kind`, `server`, `day`, `session`, `provider`            | `--kind builtin\|mcp\|agent\|skill`      |
| `usage sessions`  | —                                                                 | `--sort recent\|tokens\|tools\|duration` |
| `usage projects`  | —                                                                 | —                                        |
| `usage skills`    | —                                                                 | —                                        |
| `usage agents`    | `role`, `path`                                                    | —                                        |
| `usage hooks`     | —                                                                 | —                                        |
| `usage commands`  | —                                                                 | —                                        |
| `usage providers` | —                                                                 | —                                        |

`usage sessions` folds each session's subagent transcripts into its row, so a session's total is
its real one rather than the parent transcript's.

`usage hooks` reports executions by event and tool, with failures and latency. Failure count and
execution count legitimately diverge — Claude Code's `stop_hook_summary` reports failures with no
matching execution record — so a failure rate above 100% is a logging artifact, not a bug.

`usage agents --by role` groups by agent type; `--by path` groups by the transcript path, which is
what you want when one agent type ran in several places.

## Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | Report written. Unreadable transcripts are counted under `scan`. |
| `1`  | Invocation or I/O error                                          |
| `2`  | **Only under `--strict`**: a transcript could not be fully read  |

`usage` is deliberately absent from `commands:` defaults in `.cairn.yml`: it reads logs outside
the workspace, so a checked-in config file has no business steering it.
