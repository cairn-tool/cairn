# `pdf to-markdown`

## Synopsis

```text
cairn pdf to-markdown <file> [options]
```

Converts a document's content to Markdown, reporting per construct what was inferred and what was
lost.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

Everything in [`pdf` common behavior](common.md#options), plus:

| Option             | Default    | Description                                |
| ------------------ | ---------- | ------------------------------------------ |
| `--pages <ranges>` | every page | Pages to emit, e.g. `1,3,5-8`.             |
| `--output <file>`  | stdout     | Write the Markdown to this file instead.   |
| `--strict`         | off        | Treat approximations as blocking findings. |

## A PDF has no paragraphs

It has positioned glyph runs. There are no paragraphs, no headings, and no lists in the file — only
text placed at coordinates. So there are two ways to get structure back, and this command uses both,
choosing **per page**:

- **From the structure tree.** A tagged page names its own paragraphs, headings, list items, and
  table cells. The conversion is close to exact.
- **From geometry.** An untagged page has every block boundary _inferred_ from position, spacing,
  and font metrics. Approximate by construction.

The path is chosen per page rather than per document because mixed documents are real — a scanned
appendix bound onto a tagged report — and because `tagged` is a claim rather than a measurement.
`AP200` is always emitted and names which path each page took, with counts.

Read `document.tagged` before trusting the structure, and run [`pdf inspect`](inspect.md) before
running this at all.

## What is inferred on an untagged page

Reading order and columns; line and paragraph boundaries from the modal line spacing; heading level
from font size **ranked** against the document's modal body font, never from absolute point sizes;
list items from a bullet or numeral plus a hanging indent; running headers and footers, by detecting
repetition at a consistent height across four or more pages; and words split by a line-end hyphen,
rejoined unless the hyphenated form occurs mid-line elsewhere in the document.

Where a bookmark title matches a heading candidate on the same page, the outline pins that heading's
level. That is the cheapest accuracy win available and costs one extra read.

## What it refuses, and reports instead

The governing rule: a degradation whose output is indistinguishable from success is the one
unacceptable failure mode.

| Refused                                                    | Reported as                               |
| ---------------------------------------------------------- | ----------------------------------------- |
| Geometric table reconstruction                             | `AP202`, one paragraph per row            |
| More than three columns, or unresolvable mixed layout      | `AP201`, read top to bottom               |
| Text at a non-right angle, and vertical writing            | `AP203`, runs excluded                    |
| Link targets on text                                       | nothing — the text layer carries no links |
| Images and figures on the geometric path                   | `AP216`                                   |
| Underline, strikethrough, super- and subscript, small caps | `AP230`                                   |
| Pages with no text layer                                   | `AP050`, nothing emitted for the page     |

**A GFM table is only ever built from a structure tree.** A geometric reconstruction gets merged
cells, wrapped cell text, and rules drawn as vector paths wrong, and produces a confidently wrong
table a consumer has no way to tell from a right one. Tabular content on an untagged page is
detected, flattened to one paragraph per row, and reported.

An unrecognized structure role gets `AP219` and has its text emitted as a paragraph, rather than
disappearing.

## `--strict`, and why `AP200` is only a notice

`AP200` reports which path each page took, and it is a **notice**. If "this page was untagged" were
itself blocking, `--strict` would refuse essentially every real PDF and would therefore mean nothing.

`--strict` blocks on the per-construct losses in the table above — a flattened table, an uncertain
reading order, dropped rotated text. Those are signals a caller can act on.

## `--pages` emits a subset without changing the inference

Document-wide statistics — the modal body font, the heading size ranking, repeated-header detection,
the set of genuinely hyphenated words — are computed over **every** page, and the selection is
applied afterwards. So page 40 converted alone is a true subset of page 40 within a full conversion,
rather than a differently-inferred document. `AP208` records that a subset was emitted.

## Output stability

Emits no frontmatter: a PDF's metadata is [`pdf inspect`](inspect.md)'s answer, and inventing a
title from a producer string is not this command's job.

Every `remark-stringify` option is pinned, and shared with
[`jira adf to-markdown`](../jira/adf/to-markdown.md), so a minor bump cannot silently change the
bytes of every document either command has produced. The conventions match this repository's own
`.markdownlintrc`, so converted documents lint clean where they land.

Typographic ligatures are expanded (`ﬁ` becomes `fi`) with `AP231`. Leaving them breaks searching a
converted document for "find", "office", or "file", which is most of the reason to convert.

## Examples

```bash
# Convert, keeping findings out of the document
cairn pdf to-markdown report.pdf > report.md

# Convert and check what it cost
cairn pdf to-markdown report.pdf -fj | jq '{path: .document.structured, codes: [.diagnostics[].code]}'

# Only accept a conversion worth trusting
cairn pdf to-markdown report.pdf --strict --output report.md

# One chapter
cairn pdf to-markdown manual.pdf --pages 40-58
```

## Exit codes

| Condition                                          | Code | Stream |
| -------------------------------------------------- | ---- | ------ |
| Converted; read diagnostics for what was inferred  | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF | `1`  | stderr |
| An error, or any approximation under `--strict`    | `2`  | stderr |

`ok: true` does not mean lossless.

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf inspect`](inspect.md) — run this first
- [`pdf text`](text.md) — characters without structure
- [`jira adf to-markdown`](../jira/adf/to-markdown.md) — the other conversion into Markdown
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-to-markdown)
