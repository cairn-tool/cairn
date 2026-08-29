# `md lint`

## Synopsis

```text
cairn md lint <files...> [options]
```

Runs Mermaid, KaTeX, and local-reference checks over one or more Markdown files, directories,
globs, or stdin selections. Markdown style checking is opt-in by default. Selection can be
intersected with changed and untracked Git files.

## Arguments

| Argument   | Required | Description                                             |
| ---------- | -------- | ------------------------------------------------------- |
| `files...` | Yes      | One or more Markdown files or globs. `-` selects stdin. |

## Options

| Option                             | Default                         | Description                                                                  |
| ---------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `--format <fmt>`                   | Project `output.format`         | `llm`, `human`, `json`, `jsonl`, or `sarif`.                                 |
| `--paths <style>`                  | Project `output.paths`          | `absolute` or `relative` paths.                                              |
| `--stdin-name <path>`              | None                            | Logical workspace path for stdin.                                            |
| `-s`, `--style` / `--no-style`     | `checks.markdownlint` (`false`) | Enable or disable markdownlint.                                              |
| `--mermaid` / `--no-mermaid`       | `checks.mermaid` (`true`)       | Enable or disable Mermaid validation.                                        |
| `--katex` / `--no-katex`           | `checks.katex` (`true`)         | Enable or disable KaTeX validation.                                          |
| `--references` / `--no-references` | `checks.references` (`true`)    | Enable or disable local file and heading-reference validation.               |
| `--changed-since <revision>`       | None                            | Keep only selected changed and untracked Git files relative to the revision. |
| `--include <glob>`                 | `files.include`                 | Repeatable Markdown include glob; CLI values replace configuration.          |
| `--exclude <glob>`                 | `files.exclude`                 | Repeatable Markdown exclude glob; CLI values replace configuration.          |
| `-h`, `--help`                     | —                               | Show help.                                                                   |

Exit `0` means all enabled checks pass. Findings are written to stderr and exit `2`.
Invocation, selection, and configuration failures exit `1`.
