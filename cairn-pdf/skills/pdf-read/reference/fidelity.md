# What survives a PDF conversion

Read this when a user asks what will be lost, or when explaining a specific `AP###` finding. The
authoritative list of codes is [`docs/formats/diagnostic-codes.md`](https://github.com/cairn-tool/cairn/blob/main/docs/formats/diagnostic-codes.md).

## The one thing that decides everything

A PDF stores glyphs at coordinates. It does not store paragraphs, headings, or lists. So there are
two entirely different conversions, chosen **per page**:

| Path           | When                             | Fidelity                                            |
| -------------- | -------------------------------- | --------------------------------------------------- |
| Structure tree | The page carries usable tagging. | Close to exact; structure is read, not guessed.     |
| Geometric      | It does not.                     | Approximate throughout; every boundary is inferred. |

`AP200` is always emitted and names the path with page counts. `pdf inspect`'s `document.structured`
predicts it. Never describe geometrically inferred structure as the document's own.

## The text layer comes first

| `textLayer` | Meaning                               | What you can get           |
| ----------- | ------------------------------------- | -------------------------- |
| `present`   | A normal text layer.                  | Everything below.          |
| `sparse`    | A few glyphs over mostly image.       | Fragments. Not a document. |
| `absent`    | No text at all. The page is an image. | **Nothing.** `AP050`.      |

A chapter opener, a title page, and a full-page figure with a caption all classify `sparse`
correctly. `characters` and `density` are published beside the label, so the threshold can be
re-applied if a caller disagrees.

**There is no OCR in this toolset.** `absent` is the final answer, not a prompt to try another
command.

## On the structure-tree path

| Construct                          | Result                                          | Quality     |
| ---------------------------------- | ----------------------------------------------- | ----------- |
| `H1`–`H6`                          | A heading at that level.                        | exact       |
| `P`                                | A paragraph.                                    | exact       |
| `L`, `LI`, `Lbl`, `LBody`          | A list; the label is consumed as a marker.      | exact       |
| `Table`, `TR`, `TD`, `TH`          | A GFM table.                                    | exact       |
| `BlockQuote`                       | A block quote.                                  | exact       |
| `Artifact`                         | Dropped — running heads and page numbers.       | exact       |
| `H` (generic)                      | Level inferred from font size. `AP224`          | approximate |
| A cell spanning rows or columns    | Flattened. `AP220`                              | approximate |
| `Figure`                           | Its text only; no image. `AP216`                | approximate |
| `Formula`, `TOC`, `Code`           | Flattened to text, a list, or a fence.          | approximate |
| `Link`                             | Text kept; the href is not resolved.            | approximate |
| **A role the tool does not model** | **Its text is emitted as a paragraph. `AP219`** | unsupported |

`AP219` is the one that matters most: an unrecognized role is reported and its text kept, never
dropped. Dropping is the one degradation whose output is indistinguishable from success.

## On the geometric path

Inferred, and usually right: reading order and columns; paragraph boundaries from the modal line
spacing; heading level from font size ranked against the document's modal body font; list items from
a bullet or numeral plus a hanging indent; running headers and footers, by repetition at a consistent
height across four or more pages; words split by a line-end hyphen, rejoined unless the hyphenated
form occurs mid-line elsewhere. Where a bookmark title matches a heading on the same page, the
outline pins its level.

Refused, and reported:

| Construct                                   | Result                                   | Code    |
| ------------------------------------------- | ---------------------------------------- | ------- |
| Tables                                      | One paragraph per row.                   | `AP202` |
| More than three columns, or a mixed layout  | Read top to bottom.                      | `AP201` |
| Text at a non-right angle; vertical writing | Excluded from reading order.             | `AP203` |
| Images and figures                          | Nothing; the text layer cannot see them. | `AP216` |
| Link targets                                | Text only.                               | —       |
| Underline, strikethrough, super/subscript   | Plain text.                              | `AP230` |

**Tables are the one to explain carefully.** A geometric reconstruction gets merged cells, wrapped
cell text, and rules drawn as vector paths wrong, and produces a confidently wrong table a reader
cannot tell from a right one — so it is refused rather than attempted. Do not rebuild one by hand
from the flattened rows and present it as the document's table.

Bold and italic are inferred from font names (`AP230`), which works for embedded fonts with
descriptive names and **never** for the standard 14 — pdf.js reports those as a generic family
regardless of weight. Font size, not weight, is the primary heading signal for that reason.

## Normalization always applied

| Change                                            | Code    |
| ------------------------------------------------- | ------- |
| Ligatures expanded: `ﬁ` → `fi`, `ﬄ` → `ffl`       | `AP231` |
| Control characters removed                        | `AP232` |
| Text normalized to NFC; whitespace runs collapsed | —       |
| Words rejoined across a line-end hyphen           | `AP214` |
| Paragraphs rejoined across a page break           | `AP206` |

Ligature expansion is deliberate: leaving U+FB01 in place breaks searching a converted document for
"find", "office", or "file", which is most of the reason to convert.

## What `--strict` does

Blocks on any non-`exact` finding. Because `AP200` is a **notice** rather than an approximation,
`--strict` does not refuse a document merely for being untagged — it refuses one where a construct
was actually lost: a flattened table, an uncertain reading order, dropped rotated text.

Use it for a CI gate or an archival conversion. Do not use it as the default for reading a document
to answer a question.
