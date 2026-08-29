# `md tasks`

## Synopsis

```text
cairn md tasks <file> [options]
```

Extracts GFM task-list items with source lines, checked state, rendered text, and completion
totals.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Markdown file, or `-` for stdin. |

## Options

| Option                       | Default         | Description                                                            |
| ---------------------------- | --------------- | ---------------------------------------------------------------------- |
| `--format <fmt>`             | Project default | `llm`, `human`, or `json`.                                             |
| `--paths <style>`            | Project default | `absolute` or `relative`.                                              |
| `--stdin-name <path>`        | None            | Logical path for stdin.                                                |
| `--status <status>`          | All             | Filter to `done` or `pending`. Configuration may explicitly use `all`. |
| `--summary` / `--no-summary` | `false`         | Show only totals or include individual tasks.                          |
| `-h`, `--help`               | —               | Show help.                                                             |
