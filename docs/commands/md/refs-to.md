# `md refs-to`

## Synopsis

```text
cairn md refs-to <file> [directory] [options]
```

Searches selected Markdown documents for references to one target file. Relative link
resolution is performed from each source document, so different spellings that resolve to the
same target are matched.

## Arguments

| Argument    | Required | Description                                                  |
| ----------- | -------- | ------------------------------------------------------------ |
| `file`      | Yes      | Target file whose inbound references should be found.        |
| `directory` | No       | Search directory. Defaults to the configured workspace root. |

## Options

| Option                | Default         | Description                                                    |
| --------------------- | --------------- | -------------------------------------------------------------- |
| `--format <fmt>`      | Project default | `llm`, `human`, or `json`.                                     |
| `--paths <style>`     | Project default | `absolute` or `relative`.                                      |
| `--stdin-name <path>` | None            | Shared option; workspace scanning does not normally use stdin. |
| `--include <glob>`    | `files.include` | Repeatable Markdown include glob.                              |
| `--exclude <glob>`    | `files.exclude` | Repeatable Markdown exclude glob.                              |
| `-h`, `--help`        | —               | Show help.                                                     |

No inbound references is a successful empty result.
