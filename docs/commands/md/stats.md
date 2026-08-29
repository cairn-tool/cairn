# `md stats`

## Synopsis

```text
cairn md stats <file> [options]
```

Reports word count, heading totals by depth, link and image counts, fenced-code counts by
language, paragraph count, and list counts.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Markdown file, or `-` for stdin. |

## Options

| Option                | Default         | Description                |
| --------------------- | --------------- | -------------------------- |
| `--format <fmt>`      | Project default | `llm`, `human`, or `json`. |
| `--paths <style>`     | Project default | `absolute` or `relative`.  |
| `--stdin-name <path>` | None            | Logical path for stdin.    |
| `-h`, `--help`        | —               | Show help.                 |
