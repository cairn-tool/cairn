# `md code-blocks`

## Synopsis

```text
cairn md code-blocks <file> [options]
```

Lists fenced code blocks with their language, source line range, and line count. An optional
filter compares the fence language and optional content output includes the block body.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Markdown file, or `-` for stdin. |

## Options

| Option                       | Default         | Description                                  |
| ---------------------------- | --------------- | -------------------------------------------- |
| `--format <fmt>`             | Project default | `llm`, `human`, or `json`.                   |
| `--paths <style>`            | Project default | `absolute` or `relative`.                    |
| `--stdin-name <path>`        | None            | Logical path for stdin.                      |
| `--lang <language>`          | Any             | Include only code blocks with this language. |
| `--content` / `--no-content` | `false`         | Include or exclude code block bodies.        |
| `-h`, `--help`               | —               | Show help.                                   |
