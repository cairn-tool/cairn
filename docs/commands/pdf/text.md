# `pdf text`

## Synopsis

```text
cairn pdf text <file> [options]
```

Extracts the text layer a document already carries, page by page.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

Everything in [`pdf` common behavior](common.md#options), plus:

| Option             | Default    | Description                                            |
| ------------------ | ---------- | ------------------------------------------------------ |
| `--pages <ranges>` | every page | Pages to read, e.g. `1,3,5-8`, `-4`, `20-`.            |
| `--output <file>`  | stdout     | Write the text to this file instead.                   |
| `--strict`         | off        | Treat a page with no text layer as a blocking finding. |

## It extracts text; it does not recognize it

A scanned page is an image and carries no text layer. This command reports `AP050` for it rather
than returning an empty string with no explanation, because an empty string is indistinguishable
from a genuinely blank page. Run [`pdf inspect`](inspect.md) first to see which pages have one.

There is no OCR in this toolset, and `pdf text` will not acquire one silently.

## Output shape

Pages are separated by a **form feed** (`\f`) on stdout, as `pdftotext` does — matching the
ecosystem is worth more than inventing a separator. Under `--format json` they are a per-page array
instead, and **a page that could not be decoded is absent from it** rather than present and empty.
One undecodable page never costs the other 299.

Word spacing is reconstructed from glyph advances, because a PDF carries no spaces between
separately positioned runs. Line breaks follow the baselines. No paragraph, heading, or list
inference happens here — that is [`pdf to-markdown`](to-markdown.md)'s job — so a running header
appears in the output exactly where it appears on the page.

## Examples

```bash
# The whole document
cairn pdf text report.pdf

# Just the pages you need
cairn pdf text manual.pdf --pages 40-42

# Fail a CI job if this document is a scan
cairn pdf text incoming.pdf --strict

# Per-page, machine-readable
cairn pdf text report.pdf -fj | jq '.text[] | {page, characters}'
```

## Exit codes

| Condition                                          | Code | Stream |
| -------------------------------------------------- | ---- | ------ |
| Text written                                       | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF | `1`  | stderr |
| A page could not be decoded                        | `2`  | stderr |
| A page has no text layer, under `--strict`         | `2`  | stderr |

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf inspect`](inspect.md) — which pages have a text layer at all
- [`pdf to-markdown`](to-markdown.md) — structure, not just characters
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-pages-and-text)
