# `md links`

## Synopsis

```text
cairn md links <file> [options]
```

Lists links in one document with source context and groups them as internal, external, image,
or anchor references. Local files and heading anchors are checked for existence; external URLs
are classified but not fetched.

## Arguments

| Argument | Required | Description                                 |
| -------- | -------- | ------------------------------------------- |
| `file`   | Yes      | Markdown file to inspect, or `-` for stdin. |

## Options

| Option                               | Default         | Description                                             |
| ------------------------------------ | --------------- | ------------------------------------------------------- |
| `--format <fmt>`                     | Project default | `llm`, `human`, or `json`.                              |
| `--paths <style>`                    | Project default | `absolute` or `relative`.                               |
| `--stdin-name <path>`                | None            | Logical path for stdin.                                 |
| `--broken-only` / `--no-broken-only` | `false`         | Show only broken links or include valid links.          |
| `--type <type>`                      | All             | Filter to `internal`, `external`, `image`, or `anchor`. |
| `-h`, `--help`                       | —               | Show help.                                              |

Exit `0` means all checked local targets exist or the selected type is not checked. Broken
local links exit `2`.
