# `md index`

## Synopsis

```text
cairn md index <action> [directory] [options]
```

Inspects or manages the persistent parsed-workspace cache at
`${XDG_CACHE_HOME:-~/.cache}/cairn/workspaces/<workspace-hash>.json`. Normal commands
reuse current entries after checking file size and modification time. Missing, corrupt,
incompatible, or unwritable cache data is treated as a cache miss.

## Arguments

| Argument    | Required | Description                                                                    |
| ----------- | -------- | ------------------------------------------------------------------------------ |
| `action`    | Yes      | `status`, `build`, or `clear`.                                                 |
| `directory` | No       | Workspace to inspect/build, or whose cache to clear. Defaults to project root. |

`status` reports current, stale, and missing entries. `build` forces selected files to be
reparsed. `clear` removes only this workspace's index.

## Options

| Option                | Default         | Description                               |
| --------------------- | --------------- | ----------------------------------------- |
| `--format <fmt>`      | Project default | `llm`, `human`, or `json`.                |
| `--paths <style>`     | Project default | `absolute` or `relative`.                 |
| `--stdin-name <path>` | None            | Shared option; index actions use files.   |
| `--include <glob>`    | `files.include` | Repeatable include glob for status/build. |
| `--exclude <glob>`    | `files.exclude` | Repeatable exclude glob for status/build. |
| `-h`, `--help`        | —               | Show help.                                |
