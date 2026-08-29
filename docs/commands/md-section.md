# `md section`

## Synopsis

```text
cairn md section <file> <heading> [options]
```

Extracts one section selected by case-insensitive heading text or GitHub anchor slug. By
default, output includes the heading and all nested subsections and wraps non-raw output in
section metadata.

## Arguments

| Argument  | Required | Description                                              |
| --------- | -------- | -------------------------------------------------------- |
| `file`    | Yes      | Markdown file, or `-` for stdin.                         |
| `heading` | Yes      | Heading text or anchor slug, matched case-insensitively. |

## Options

| Option                                       | Default         | Description                                             |
| -------------------------------------------- | --------------- | ------------------------------------------------------- |
| `--format <fmt>`                             | Project default | `llm`, `human`, or `json`; ignored by raw output.       |
| `--paths <style>`                            | Project default | `absolute` or `relative`.                               |
| `--stdin-name <path>`                        | None            | Logical path for stdin.                                 |
| `--include-heading` / `--no-include-heading` | `true`          | Include or remove the selected heading line.            |
| `--children` / `--no-children`               | `true`          | Include nested subsections or stop at the next heading. |
| `--raw` / `--no-raw`                         | `false`         | Emit only raw Markdown or include section metadata.     |
| `-h`, `--help`                               | —               | Show help.                                              |

Missing files or headings exit `1`; successful extraction exits `0`.
