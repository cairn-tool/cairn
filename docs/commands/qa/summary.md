# `qa summary`

## Synopsis

```text
cairn qa summary --runs-dir <path> [options]
```

Regenerates `<runs-dir>/summary.md` from the files on disk. It does not launch an agent.

See [shared QA behavior](common.md) for POSIX-only, logs, and configuration.

## Options

Only the [common options](common.md#options). `--runs-dir` is required unless `qa.runs-dir` is set
in project configuration.

## What it writes

`summary.md` is derived from `_plans/tc-N.yaml` plus each `tc-N/` run folder. A case with broken
YAML still earns a row and a flag instead of vanishing from the tracker.

## Exit codes

| Condition                               | Code | Stream |
| --------------------------------------- | ---- | ------ |
| `summary.md` written                    | `0`  | stdout |
| Invocation, I/O, or configuration error | `1`  | stderr |

This command never exits 2.

## Related surfaces

- [`qa run`](run.md) is what produces the run folders this reads.
- [`qa list`](list.md) reports pending versus done without rewriting `summary.md`.
