# `md rename-file`

## Synopsis

```text
cairn md rename-file <source> <destination> [options]
```

Moves one Markdown document or referenced asset inside the workspace and rewrites selected
inline and reference-style links/images that resolve to it. Query strings, fragments,
root-relative style, and URL encoding are preserved. When a Markdown document moves, its own
outbound relative links are recomputed from the destination.

The command refuses sources outside the workspace, symlink or non-file sources, existing
destinations, destinations outside the workspace, and missing destination parents. It writes
the moved file and affected Markdown documents unless `--dry-run` is active.

## Arguments

| Argument      | Required | Description                                                             |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `source`      | Yes      | Existing Markdown document or referenced asset inside the workspace.    |
| `destination` | Yes      | New path inside the workspace; its parent directory must already exist. |

## Options

| Option                       | Default         | Description                                                   |
| ---------------------------- | --------------- | ------------------------------------------------------------- |
| `--format <fmt>`             | Project default | `llm`, `human`, or `json`.                                    |
| `--paths <style>`            | Project default | `absolute` or `relative`.                                     |
| `--stdin-name <path>`        | None            | Shared option; moving requires filesystem paths.              |
| `--include <glob>`           | `files.include` | Repeatable include glob bounding the Markdown reference scan. |
| `--exclude <glob>`           | `files.exclude` | Repeatable exclude glob bounding the reference scan.          |
| `--dry-run` / `--no-dry-run` | `false`         | Preview changes or apply them.                                |
| `-h`, `--help`               | —               | Show help.                                                    |

Successful application or preview exits `0`; unsafe paths, collisions, missing inputs, or I/O
errors exit `1`.
