# `md frontmatter`

## Synopsis

```text
cairn md frontmatter <file> [options]
```

Parses YAML frontmatter and displays the resulting mapping. With `--key`, retrieves one value
using dotted notation such as `author.name`.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Markdown file, or `-` for stdin. |

## Options

| Option                | Default         | Description                                |
| --------------------- | --------------- | ------------------------------------------ |
| `--format <fmt>`      | Project default | `llm`, `human`, or `json`.                 |
| `--paths <style>`     | Project default | `absolute` or `relative`.                  |
| `--stdin-name <path>` | None            | Logical path for stdin.                    |
| `--key <key>`         | None            | Extract one nested key using dot notation. |
| `-h`, `--help`        | —               | Show help.                                 |

No frontmatter is a successful empty result. A missing requested key or file exits `1`.
