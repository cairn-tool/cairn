# `md rename-heading`

## Synopsis

```text
cairn md rename-heading <file> <old-heading> <new-heading> [options]
```

Renames one heading and updates internal anchor references that resolve to it. References in
the same document are always eligible; `--directory` additionally scans selected Markdown
documents for cross-file links. Matching is case-insensitive and updated anchors use GitHub
slug behavior, including duplicate-heading suffixes.

This command writes files unless `--dry-run` is active.

## Arguments

| Argument      | Required | Description                                       |
| ------------- | -------- | ------------------------------------------------- |
| `file`        | Yes      | Markdown document containing the heading.         |
| `old-heading` | Yes      | Current heading text, matched case-insensitively. |
| `new-heading` | Yes      | Replacement heading text.                         |

## Options

| Option                       | Default         | Description                                                                                                                  |
| ---------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--format <fmt>`             | Project default | `llm`, `human`, or `json`.                                                                                                   |
| `--paths <style>`            | Project default | `absolute` or `relative`.                                                                                                    |
| `--stdin-name <path>`        | None            | Shared option; renaming requires a real file.                                                                                |
| `--directory <dir>`          | None            | Also update references in selected Markdown files below this directory. The directory must remain inside the workspace root. |
| `--include <glob>`           | `files.include` | Repeatable include glob for the cross-file scan.                                                                             |
| `--exclude <glob>`           | `files.exclude` | Repeatable exclude glob for the cross-file scan.                                                                             |
| `--dry-run` / `--no-dry-run` | `false`         | Preview changes or apply them.                                                                                               |
| `-h`, `--help`               | —               | Show help.                                                                                                                   |

Exit `0` means the rename was applied or previewed. A missing/ambiguous heading, missing file,
or collision with an existing new slug exits `1`.
