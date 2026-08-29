# `check-update`

## Synopsis

```text
cairn check-update [options]
```

Queries npm directly for the latest published `@bstockus/cairn` version. It deliberately
bypasses the passive notifier's 24-hour cache, then refreshes that cache with the result. npm
performs registry and authentication resolution, including scoped-registry settings in
`.npmrc`.

## Arguments

This command has no positional arguments.

## Options

| Option           | Default | Description                                                    |
| ---------------- | ------- | -------------------------------------------------------------- |
| `--format <fmt>` | `llm`   | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `-h`, `--help`   | —       | Show help.                                                     |

## Exit codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| `0`  | The installed version is current.                                     |
| `1`  | The registry could not be reached or did not return a usable version. |
| `2`  | A newer published version is available.                               |
