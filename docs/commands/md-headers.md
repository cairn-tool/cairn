# `md headers`

## Synopsis

```text
cairn md headers <file> [options]
```

Extracts Markdown headings with source line, depth, rendered text, and GitHub-compatible slug.
Duplicate headings receive GitHub-style numeric suffixes.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Markdown file, or `-` for stdin. |

## Options

| Option                | Default         | Description                                  |
| --------------------- | --------------- | -------------------------------------------- |
| `--format <fmt>`      | Project default | `llm`, `human`, or `json`.                   |
| `--paths <style>`     | Project default | `absolute` or `relative`.                    |
| `--stdin-name <path>` | None            | Logical path for stdin.                      |
| `--max-depth <n>`     | `6`             | Include heading levels 1 through this value. |
| `-h`, `--help`        | —               | Show help.                                   |
