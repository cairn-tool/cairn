# Running a queue, in full

See [the `qa` command listing](https://github.com/cairn-tool/cairn/blob/main/docs/commands.md) for
the canonical flag reference. This file carries what a caller needs in context.

## Shared options

Every `qa` subcommand takes these.

| Option              | Default              |                                                                       |
| ------------------- | -------------------- | --------------------------------------------------------------------- |
| `--format <fmt>`    | `llm`                | `llm`, `human`, or `json`. Shorthands `-fh`, `-fj`. Not configurable. |
| `--envelope`        | off                  | Wrap `--format json` in the versioned result envelope.                |
| `--runs-dir <path>` | config `qa.runs-dir` | Directory holding `_plans/` and the per-case folders.                 |
| `--config <file>`   | discovered           | Use a specific `.cairn.yml`.                                          |
| `--no-config`       | —                    | Disable project configuration discovery.                              |

`--format json` implies `--no-tui`.

## `qa run`

| Option              | Default                 |                                                                   |
| ------------------- | ----------------------- | ----------------------------------------------------------------- |
| `--repo <path>`     | **required**            | Repository root and agent working directory.                      |
| `--parallel <n>`    | `8`                     | Most agents at once.                                              |
| `--model <slug>`    | per-backend             | Model for cases with no `model:`. Repeat as `--model agent=slug`. |
| `--only <names>`    | all pending             | Comma-separated, e.g. `tc-27,tc-28`.                              |
| `--limit <n>`       | none                    | Run at most N of the sorted queue.                                |
| `--dry-run`         | off                     | Print the queue and the commands; launch nothing.                 |
| `--show-prompts`    | off                     | With `--dry-run`, print each prompt in full.                      |
| `--no-tui`          | off                     | Line-oriented log instead of the pane view.                       |
| `--timeout-min <n>` | `60`                    | Kill an agent after N minutes.                                    |
| `--agent <path>`    | per-backend PATH lookup | Explicit binary for **every** backend.                            |

| Exit | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Every started case reached `ok`, the queue was empty, or `--dry-run` |
| `1`  | Invocation, I/O, or configuration error                              |
| `2`  | At least one case failed, timed out, or produced no output           |

## `qa list`

Catalogs every `_plans/tc-N.yaml` with its status, agent, model and constraint, and launches nothing.
Takes an optional `--repo` used only to relativize paths. Exits `0` or `1`.

## `qa summary`

Regenerates `<runs-dir>/summary.md` from the files on disk. Launches nothing, and reads only the
records — a row cannot claim a verdict its `_results.md` does not carry. Takes no `--repo`, so its
relative paths are current-directory relative. Exits `0` or `1`.

Run it after authoring plans, and after any batch of runs. `qa run` also regenerates it on exit,
including on drain and interrupt.

## Concurrency

`--parallel` is the global ceiling. Each case declares how it may share it.

| Case                           | Behaviour                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `parallel: true`               | Unconstrained — runs whenever a slot is free. `tags:` is not allowed.                                         |
| `parallel: false` with `tags:` | Each tag is a mutex: at most one running case holds a given tag. Cases sharing no tag still run side by side. |
| `parallel: false`, no tags     | A barrier. The queue drains to zero agents, the case runs alone, then the queue resumes.                      |

Cases dispatch in case-number order. A case blocked on a tag is skipped over rather than holding the
queue; a barrier is not, so it cannot starve.

A backend may also declare its own `maxParallel`. When it does, the effective cap is the lower of
that and `--parallel`; when it does not, `--parallel` alone decides.

## The lock

`<runs-dir>/.harness.lock` stops two queues overlapping on the same runs directory. On macOS and BSD
it is a kernel `O_EXLOCK`, released the instant the process dies. On Linux it is a pid file reclaimed
by a liveness check.

## What a run leaves behind

| Path                             |                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `<runs-dir>/tc-N/`               | The case's deliverables, promoted from `tc-N-temp/` on success                              |
| `<runs-dir>/summary.md`          | The tracker, regenerated from disk                                                          |
| `<runs-dir>/_runs/<ts>-<pid>.md` | One session log per invocation, rewritten as cases finish                                   |
| `<runs-dir>/_logs/<run-id>/`     | Per-case `command.txt`, `stream.jsonl`, `stderr.txt`, `transcript.txt`, plus `summary.json` |

**Gitignore `_logs/`.** Cairn writes no `.gitignore`, the transcripts are large, and they quote
repository source.

Per-case statuses: `ok` (exit 0, both records present, rename succeeded), `no-output` (temp folder
missing a record), `no-folder` (the agent never created `tc-N-temp/`), `error`, `timeout`.

## Configuration

A `qa:` block in `.cairn.yml` may set `runs-dir`, `model`, `parallel` and `agent`. How a case is
spawned is not configurable — there is no `commands.qa` map.

`--repo` is **not** confined to `config.root`, so a `.cairn.yml` in the current directory does not
block pointing the harness at another tree.

⚠️ `agent:` in config names an executable that cairn will spawn. Config discovery skips
`node_modules`, so a vendored `.cairn.yml` cannot supply it — but a checked-in one in your own tree
can. Treat it as you would any committed command.

## Never exposed over MCP

`qa run` is not, and must not be, a tool on `cairn serve mcp`. That server is read-only and process
execution has no place behind it — the same rule as `scripts run`.
