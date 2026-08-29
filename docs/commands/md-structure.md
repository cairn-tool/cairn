# `md structure`

## Synopsis

```text
cairn md structure <file> [options]
```

Produces a compact document skeleton containing headings, fenced code blocks, lists, and
display-math regions with line ranges. It is intended for a quick structural overview rather
than content extraction.

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
