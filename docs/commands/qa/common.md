# Shared QA command behavior

Shared by every [`qa`](../../commands.md#qa-commands) subcommand. The per-command pages cover only
what differs.

## POSIX only

`qa` signals a process group (`process.kill(-pid)`), uses `flock`, and optionally takes the
terminal into raw mode plus the alternate screen. None of those have a Windows equivalent in this
build. Invocation on `win32` exits 1 and points here.

Windows support is tracked in [future enhancements](../../future-enhancements.md).

## What it runs

`qa run` discovers `_plans/tc-N.yaml` under `--runs-dir`, inlines each plan into a prompt, and
spawns the case's agent backend with permission checks bypassed. A queue may mix `cursor`,
`claude-code`, and `codex` cases in one execution. Codex retains its normal hook-trust gate and
git-repository check, and loads normal user/project configuration and rules.

That is a different trust boundary from [`scripts run`](../scripts/run.md). Scripts resolve a name
declared in a tracked `.cairn.yml`. QA discovers plan files and forwards their bodies to an agent
that is told to skip its own permission checks.

## Options

| Option              | Default              | Description                                                   |
| ------------------- | -------------------- | ------------------------------------------------------------- |
| `--format <fmt>`    | `llm`                | `llm`, `human`, or `json`. Not configurable.                  |
| `--envelope`        | off                  | Wrap `--format json` output in the versioned result envelope. |
| `--runs-dir <path>` | config `qa.runs-dir` | Directory containing `_plans/` and per-case output folders.   |
| `--config <file>`   | Discovered           | Use a specific `.cairn.yml`.                                  |
| `--no-config`       | —                    | Disable project configuration discovery.                      |

`--repo` is required on `qa run`. `--runs-dir` must resolve under `--repo`. `--repo` is **not**
confined to `config.root`, so a `.cairn.yml` in the current directory does not block pointing the
harness at another tree.

A **relative** `--runs-dir` resolves against `--repo` when one is given, and against the current
directory otherwise. The rule is the same in every subcommand, so `qa run` and `qa list` with
identical flags always name the same directory whatever directory you run them from. `qa summary`
takes no `--repo`, so its relative paths are always current-directory relative.

`--format json` implies `--no-tui`.

## Logs

Agent transcripts land under `<runs-dir>/_logs/<run-id>/`. Gitignore that directory; cairn does
not write a `.gitignore`.

## Configuration

A top-level `qa:` block in `.cairn.yml` may set `runs-dir`, `model`, `parallel`, and `agent`. How a
case is spawned is not configurable: there is no `commands.qa` map. See
[Project configuration](../../configuration.md#qa).
