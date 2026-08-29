# `md validate-frontmatter`

## Synopsis

```text
cairn md validate-frontmatter <paths...> [options]
```

Validates YAML frontmatter across selected Markdown inputs. A JSON or YAML Schema and the
configured shortcut rules are cumulative: documents must satisfy both. Shortcut rules cover
required/prohibited fields, types, allowed values, formats, patterns, and cross-file uniqueness.

## Arguments

| Argument   | Required | Description                                           |
| ---------- | -------- | ----------------------------------------------------- |
| `paths...` | Yes      | Markdown files, directories, globs, or `-` for stdin. |

## Options

| Option                       | Default              | Description                                  |
| ---------------------------- | -------------------- | -------------------------------------------- |
| `--format <fmt>`             | Project default      | `llm`, `human`, `json`, `jsonl`, or `sarif`. |
| `--paths <style>`            | Project default      | `absolute` or `relative`.                    |
| `--stdin-name <path>`        | None                 | Logical path for stdin.                      |
| `--schema <file>`            | `frontmatter.schema` | JSON or YAML Schema file.                    |
| `--include <glob>`           | `files.include`      | Repeatable include glob.                     |
| `--exclude <glob>`           | `files.exclude`      | Repeatable exclude glob.                     |
| `--changed-since <revision>` | None                 | Keep only selected Git changes.              |
| `-h`, `--help`               | —                    | Show help.                                   |

Valid input exits `0`; configuration or schema-loading errors exit `1`; validation findings
exit `2`.
