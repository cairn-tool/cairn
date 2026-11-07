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
| `--columns <mode>` | `auto`     | Reading order: `auto`, or a column count from 1 to 6.  |
| `--output <file>`  | stdout     | Write the text to this file instead.                   |
| `--strict`         | off        | Treat a page with no text layer as a blocking finding. |

## It extracts text; it does not recognize it

A scanned page is an image and carries no text layer. This command reports `AP050` for it rather
than returning an empty string with no explanation, because an empty string is indistinguishable
from a genuinely blank page. Run [`pdf inspect`](inspect.md) first to see which pages have one.

`pdf text` never recognises text in an image, and has no `--ocr` flag: its output is a pure
function of the document. [`pdf ocr`](ocr.md) recognises exactly the pages this command reports
`AP050` for, and marks everything it returns as recognised; see
[why the two stay separate](ocr.md#why-pdf-text-has-no---ocr).

## Output shape

Pages are separated by a **form feed** (`\f`) on stdout, as `pdftotext` does — matching the
ecosystem is worth more than inventing a separator. Under `--format json` they are a per-page array
instead, and **a page that could not be decoded is absent from it** rather than present and empty.
One undecodable page never costs the other 299.

Word spacing is reconstructed from glyph advances, because a PDF carries no spaces between
separately positioned runs. Line breaks follow the baselines. No paragraph, heading, or list
inference happens here — that is [`pdf to-markdown`](to-markdown.md)'s job — so a running header
appears in the output exactly where it appears on the page.

## Columns

Read top to bottom, a two-column page interleaves its columns into text that reads like prose and
is not, and a sentence that runs over a line break in one column is no longer a substring of the
text. So each page's columns are found first (`--columns auto`, the default): each line is cut at
gaps wider than an em, and a **gutter** is an x band the narrow pieces leave empty, between at least
five lines of text on each side that fill their column. A line with a piece across a gutter — a
title, an abstract, a wide caption — is read whole where it stands, and the lines between two such
lines are read column by column. A page whose title runs the full width is still read as two columns
below it.

What was inferred is reported per page under `--format json` as `layout`: the number of columns,
`method` (`auto` or `forced`), the gutters' x positions in page-upright points, and how many lines
crossed them. A page read in columns also reports `AP210`; one where auto found more than three
candidate gutters (a form, a wide table) is read top to bottom and reports `AP201`. A table's short
cells are not mistaken for columns: its rows read across.

`--columns 1` reads every page top to bottom, as before. `--columns 2` (up to 6) reads every page
in that many columns, at its widest empty bands, or in equal widths where it has too few.

## Symbol fonts

Word and most other producers write a Symbol or Wingdings character with a ToUnicode map that puts
it in private use: U+F044 where the page shows Δ, U+F0B7 for a bullet. The byte means something only
in its font, so on a page that has such characters the fonts are looked up by name and each byte is
read through its font's encoding: Symbol (`SymbolMT`, `Symbol,Bold`…), ZapfDingbats, Wingdings, and
MT Extra's ℏ and ℓ. Adobe's private-use code points for Symbol's bracket and integral pieces map
whatever the font. `AP051` reports what was mapped, by font; `AP052` names the characters left in
private use, by font, with their code points.

## Large documents

The default `--timeout` is 30 s, or 50 ms a page for a document of more than 600 pages: a 1,300-page
handbook gets 65 s rather than the time a 30-page paper has. When the budget runs out, one `AP005`
says at which page, how many pages were not read, and the budget the rate so far says the whole
document needs; the pages read are kept.

## Examples

```bash
# The whole document
cairn pdf text report.pdf

# Just the pages you need
cairn pdf text manual.pdf --pages 40-42

# Fail a CI job if this document is a scan
cairn pdf text incoming.pdf --strict

# Per-page, machine-readable, with each page's columns
cairn pdf text report.pdf -fj | jq '.text[] | {page, characters, columns: .layout.columns}'

# A page known to be in two columns
cairn pdf text paper.pdf --pages 3 --columns 2
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
