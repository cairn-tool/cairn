# `md outline`

## Synopsis

```text
cairn md outline <file> [options]
```

Renders the selected headings as an indented outline. JSON output represents the same heading
hierarchy as a nested tree.

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
