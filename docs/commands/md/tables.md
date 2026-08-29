# `md tables`

## Synopsis

```text
cairn md tables <file> [options]
```

Lists GFM tables with source range, column count, row count, alignment, headers, and parsed
cell data. Human/LLM output includes cell content only when requested; JSON always contains
the parsed table data.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Markdown file, or `-` for stdin. |

## Options

| Option                       | Default         | Description                                                |
| ---------------------------- | --------------- | ---------------------------------------------------------- |
| `--format <fmt>`             | Project default | `llm`, `human`, or `json`.                                 |
| `--paths <style>`            | Project default | `absolute` or `relative`.                                  |
| `--stdin-name <path>`        | None            | Logical path for stdin.                                    |
| `--content` / `--no-content` | `false`         | Include or suppress rendered table content in text output. |
| `--index <n>`                | All             | Select one table by 1-based positive index.                |
| `-h`, `--help`               | —               | Show help.                                                 |

An invalid or out-of-range index exits `1`.
