# `md orphans`

## Synopsis

```text
cairn md orphans [directory] [options]
```

Builds inbound-reference information for selected Markdown documents and reports files that
no other selected Markdown file references. Explicit entry points are never considered
orphans.

## Arguments

| Argument    | Required | Description                                                   |
| ----------- | -------- | ------------------------------------------------------------- |
| `directory` | No       | Directory to scan. Defaults to the configured workspace root. |

## Options

| Option                | Default             | Description                                               |
| --------------------- | ------------------- | --------------------------------------------------------- |
| `--format <fmt>`      | Project default     | `llm`, `human`, or `json`.                                |
| `--paths <style>`     | Project default     | `absolute` or `relative`.                                 |
| `--stdin-name <path>` | None                | Shared option; directory scanning does not use stdin.     |
| `--include <glob>`    | `files.include`     | Repeatable include glob.                                  |
| `--exclude <glob>`    | `files.exclude`     | Repeatable exclude glob.                                  |
| `--ignore <glob>`     | Empty               | Repeatable glob removed from orphan reporting.            |
| `--entry <file>`      | `files.entryPoints` | Repeatable entry-point file exempt from orphan reporting. |
| `-h`, `--help`        | —                   | Show help.                                                |

No orphans exits `0`; one or more orphans exits `2`.
