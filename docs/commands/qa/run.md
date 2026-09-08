# `qa run`

## Synopsis

```text
cairn qa run --repo <path> --runs-dir <path> [options]
```

Runs the queue of pending test cases: every `_plans/tc-N.yaml` that does not yet have a `tc-N/`
output folder. Each case is inlined into a prompt and spawned on its declared agent backend with
permission checks bypassed.

See [shared QA behavior](common.md) for POSIX-only, logs, and configuration.

## Options

Everything in [`qa` common behavior](common.md#options), plus:

| Option              | Default                                                            | Description                                                              |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `--repo <path>`     | —                                                                  | Repository root: agent cwd and Cursor `--workspace`. Required.           |
| `--parallel <n>`    | `8`                                                                | Most agents at once.                                                     |
| `--model <slug>`    | per-agent default                                                  | Model for cases with no `model:` key. Repeat as `--model agent=slug`.    |
| `--only <names>`    | all pending                                                        | Comma-separated case names, e.g. `tc-27,tc-28`.                          |
| `--limit <n>`       | none                                                               | Run at most N eligible cases.                                            |
| `--dry-run`         | off                                                                | Print the queue and the commands; launch nothing.                        |
| `--show-prompts`    | off                                                                | With `--dry-run`, print each prompt in full instead of eliding the plan. |
| `--no-tui`          | off (on when stdout is not a TTY, `CI` is set, or `--format json`) | Line-oriented log instead of the pane view.                              |
| `--timeout-min <n>` | `60`                                                               | Kill an agent after N minutes.                                           |
| `--agent <path>`    | per-backend PATH lookup                                            | Explicit binary used for **every** backend. The fake-agent test hook.    |

`--format json` implies `--no-tui`.

A TUI is used when stdout is a TTY, the format is `llm` or `human`, and `CI` is unset.

## Backends

| `agent:` in the case file | Binary (PATH order)     | Default model          | Distinct flags                                                |
| ------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------- |
| `cursor`                  | `cursor-agent`, `agent` | `cursor-grok-4.6-high` | `--force --trust --workspace <repo>`                          |
| `claude-code`             | `claude`                | `sonnet`               | `--verbose --dangerously-skip-permissions` (no `--workspace`) |

A cursor-only queue does not fail because `claude` is absent: PATH lookup is lazy per profile.
`--agent <path>` overrides every backend.

`--model slug` applies to every backend. `--model cursor=composer-2.5` sets one.

## Empty queue

If every case already has an output folder, the command prints that there are no eligible cases
and exits 0.

## Exit codes

| Condition                                                  | Code | Stream |
| ---------------------------------------------------------- | ---- | ------ |
| Every case passed, the queue was empty, or `--dry-run`     | `0`  | stdout |
| Invocation, I/O, or configuration error                    | `1`  | stderr |
| At least one case failed, timed out, or produced no output | `2`  | stdout |

## Related surfaces

- [`qa list`](list.md) catalogs cases without launching.
- [`qa summary`](summary.md) regenerates `summary.md` from disk.
- [QA guide](../../guide/qa.md)
