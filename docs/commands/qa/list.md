# `qa list`

## Synopsis

```text
cairn qa list --runs-dir <path> [options]
```

Catalogs every `_plans/tc-N.yaml` with status `pending` or `done` and launches nothing. A case is
`done` when its `tc-N/` output folder exists.

See [shared QA behavior](common.md) for POSIX-only, logs, and configuration.

## Options

Everything in [`qa` common behavior](common.md#options), plus:

| Option          | Default      | Description                                            |
| --------------- | ------------ | ------------------------------------------------------ |
| `--repo <path>` | `--runs-dir` | Repository root, used only to resolve case file paths. |

`--runs-dir` is required unless `qa.runs-dir` is set in project configuration.

## Exit codes

| Condition                               | Code | Stream |
| --------------------------------------- | ---- | ------ |
| Listing written                         | `0`  | stdout |
| Invocation, I/O, or configuration error | `1`  | stderr |

This command never exits 2.

## Related surfaces

- [`qa run`](run.md) launches the pending cases this lists.
- [`qa summary`](summary.md) writes the tracker table.
