# `pdf inspect`

## Synopsis

```text
cairn pdf inspect <file> [options]
```

Reports what a document is before anything tries to read it: how many pages, whether it is tagged,
whether it is encrypted, and how much text each page actually carries. The question it answers is
what a conversion will cost, asked before paying it.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

Only the [common options](common.md#options). There is no `--pages`: the inventory is document-wide
by definition. There is no `--output`: this is a report, not a document.

## The two fields to read first

**`document.tagged`** decides what every other command can tell you. A tagged document carries a
structure tree that names its own paragraphs, headings, lists, and table cells, so
[`pdf to-markdown`](to-markdown.md) infers almost nothing. An untagged one is inference throughout.

**`document.structured`** is the measured version of that claim. Some producers declare
`/MarkInfo <</Marked true>>` and ship an empty tree, which reports `tagged: true`,
`structured: "none"`, and `AP114`.

## The text layer, and how it is classified

Each page is classified from its glyph count per square inch:

| Label     | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `present` | A normal text layer. Extraction and conversion will work.                       |
| `sparse`  | A handful of glyphs over mostly image. Do not expect a document from this page. |
| `absent`  | No text at all. The page is an image; extraction returns nothing.               |

A conventionally typeset Letter page runs about 32 characters per square inch, and the threshold
between `sparse` and `present` sits at 5 — roughly six to eight lines. `absent` additionally
requires the page to carry almost nothing, because scanned pages routinely carry a real Bates stamp
or a producer watermark in a genuine text layer.

**The evidence is published beside the verdict.** `characters` and `density` are on every page row,
so a caller who disagrees with the threshold can re-classify without reverse-engineering it:

```bash
cairn pdf inspect report.pdf -fj | jq '[.pages[] | select(.density < 12) | .page]'
```

Known and correct false positives: a chapter opener, a title page, and a full-page figure with a
caption all classify `sparse`. That means "do not expect a document from this page", not "this page
is broken".

## Examples

```bash
# What is this, and what will converting it cost?
cairn pdf inspect report.pdf -fh

# Does this document need OCR? (No PDF command can do OCR; this says whether it would be needed.)
cairn pdf inspect scan.pdf -fj | jq '.document.textLayer'

# Which pages are images?
cairn pdf inspect scan.pdf -fj | jq '[.pages[] | select(.textLayer == "absent") | .page]'

# Can the converted structure be trusted?
cairn pdf inspect report.pdf -fj | jq '{tagged: .document.tagged, measured: .document.structured}'
```

## Exit codes

| Condition                                          | Code | Stream |
| -------------------------------------------------- | ---- | ------ |
| Inventory written                                  | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF | `1`  | stderr |
| A page could not be analyzed at all                | `2`  | stderr |

Exit 2 leaves the inventory _incomplete_ rather than wrong: every page that could be analyzed is
still reported.

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf text`](text.md) — extract what this reports the existence of
- [`pdf to-markdown`](to-markdown.md) — convert it
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-pages-and-text)
