# `md refs`

## Synopsis

```text
cairn md refs <file> [options]
```

Lists references originating in one Markdown document and checks whether local targets exist.
Inline links plus full, collapsed, and shortcut reference-style links/images are resolved.
By default, only local file references are listed.

## Arguments

| Argument | Required | Description                                 |
| -------- | -------- | ------------------------------------------- |
| `file`   | Yes      | Markdown file to inspect, or `-` for stdin. |

## Options

| Option                               | Default         | Description                                |
| ------------------------------------ | --------------- | ------------------------------------------ |
| `--format <fmt>`                     | Project default | `llm`, `human`, or `json`.                 |
| `--paths <style>`                    | Project default | `absolute` or `relative`.                  |
| `--stdin-name <path>`                | None            | Logical path for stdin.                    |
| `-e`, `--external` / `--no-external` | `false`         | Include or exclude external URLs.          |
| `-a`, `--anchors` / `--no-anchors`   | `false`         | Include or exclude anchor-only references. |
| `-i`, `--images` / `--no-images`     | `false`         | Include or exclude image references.       |
| `-h`, `--help`                       | —               | Show help.                                 |

Exit `0` means all reported local targets exist. Missing targets exit `2`.
