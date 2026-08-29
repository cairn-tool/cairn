# `md lint-dir`

## Synopsis

```text
cairn md lint-dir [directory] [options]
```

Runs the lint check set over every selected Markdown file in a directory. Files are processed
with bounded concurrency and results retain deterministic input order.

## Arguments

| Argument    | Required | Description                                                   |
| ----------- | -------- | ------------------------------------------------------------- |
| `directory` | No       | Directory to scan. Defaults to the configured workspace root. |

## Options

| Option                             | Default                   | Description                                                    |
| ---------------------------------- | ------------------------- | -------------------------------------------------------------- |
| `--format <fmt>`                   | Project default           | `llm`, `human`, `json`, `jsonl`, or `sarif`.                   |
| `--paths <style>`                  | Project default           | `absolute` or `relative`.                                      |
| `--stdin-name <path>`              | None                      | Shared option; directory input does not normally use stdin.    |
| `-s`, `--style` / `--no-style`     | `checks.markdownlint`     | Toggle markdownlint.                                           |
| `--mermaid` / `--no-mermaid`       | `checks.mermaid`          | Toggle Mermaid checks.                                         |
| `--katex` / `--no-katex`           | `checks.katex`            | Toggle KaTeX checks.                                           |
| `--references` / `--no-references` | `checks.references`       | Toggle reference checks.                                       |
| `--summary` / `--no-summary`       | `false`                   | Show one pass/fail line per file instead of detailed findings. |
| `--concurrency <n>`                | CPU count, clamped to 1–8 | Maximum files checked concurrently. Must be positive.          |
| `--include <glob>`                 | `files.include`           | Repeatable include glob.                                       |
| `--exclude <glob>`                 | `files.exclude`           | Repeatable exclude glob.                                       |
| `--changed-since <revision>`       | None                      | Check only selected changed and untracked files.               |
| `-h`, `--help`                     | —                         | Show help.                                                     |

Exit `0` means all files pass or no Markdown files were selected. Any finding exits `2`.
