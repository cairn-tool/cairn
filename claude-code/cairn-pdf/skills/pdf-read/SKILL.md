---
name: pdf-read
description: Read PDF documents with the cairn pdf toolset — extract the text layer, read the outline, check structural integrity, convert content to Markdown, pull out embedded images, render pages or regions to PNG, and recognise scanned pages with OCR, reporting what each step inferred or lost. Use when asked to read, summarize, quote, or convert a PDF, to get a figure or page image out of one, when a PDF needs to become Markdown for a docs tree, or when deciding whether a document carries usable text at all.
---

# Reading PDF documents

A PDF is not a document in the sense the rest of a repository means it. There is no text file
underneath, no structure to walk, and often no text at all. `cairn pdf` turns one into text,
structure, Markdown, images, or page renders — deterministically and locally: no credentials, no
network, no model call. Scanned pages are recognised only by `pdf ocr`, with the installed Tesseract,
and recognised text is always **marked as recognised**; nothing else in the toolset does OCR.

Confirm the toolset exists before relying on it: `cairn describe pdf -fj` lists the subcommands.
If the group is absent, or `images`, `render`, or `ocr` is missing from it, the installed cairn
predates that feature — say so and stop rather than guessing at flags. All of them are
`stability: experimental`, so read payload shapes through `cairn describe` and
`cairn schema pdf-result` rather than hardcoding them.

## Commands

| Command                                  | When                                                              |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `pdf inspect <file>`                     | **First, always.** What is this, and what will reading it cost?   |
| `pdf text <file>`                        | The characters are wanted, not the structure.                     |
| `pdf to-markdown <file>`                 | The structure is wanted: headings, lists, tables.                 |
| `pdf outline <file>`                     | The bookmarks — a table of contents, or where a chapter starts.   |
| `pdf validate <file>`                    | Is this file structurally sound before trusting anything from it? |
| `pdf attachments <file>`                 | What files are embedded inside it, and get them out.              |
| `pdf forms <file>`                       | The form's field names and the values already filled in.          |
| `pdf images <file> --out <dir>`          | The pictures in it: each raster image, and where it sits.         |
| `pdf render <file> --page N --out f.png` | A page, or a region of it (`--box`), as a PNG.                    |
| `pdf ocr <file>`                         | The text of pages with no text layer, recognised and marked.      |

`-` reads stdin for all of them. `text` and `to-markdown` take `--pages`, `--output`,
`--columns`, and `--strict`; `images` and `ocr` take `--pages` too.

Columns are found on each page (`--columns auto`): a title or caption across them is read whole and
the columns below it in turn, and `pdf text -fj` reports each page's `layout`. If a page still reads
interleaved, say so and pass `--columns 2` (or `1` to read top to bottom). Symbol and Wingdings
characters in private use (U+F044 for Δ) are mapped through their fonts and reported as `AP051`;
`AP052` names the ones left, which a `pdf render` of the page can settle.

If the `cairn` MCP server is available, `inspect_pdf`, `read_pdf_text`, `convert_pdf_to_markdown`,
`get_pdf_outline`, `list_pdf_attachments`, and `list_pdf_form_fields` do the same work for a PDF
**inside the served root**, and are cheaper than shelling out. For a PDF anywhere else, to extract
an embedded file, or for `images`, `render`, and `ocr`, use the CLI: the MCP surface writes nothing.

## It reads; it never writes a PDF

There is no merge, split, page reorder, rotation, form fill, watermark, or redact, and there will
not be. If a user asks for one, say so plainly and offer what this can do instead. Do not reach for
another tool to do it on cairn's behalf without being asked.

## Inspect first, and read two fields

```bash
cairn pdf inspect report.pdf -fj | jq '{tagged: .document.tagged, measured: .document.structured, text: .document.textLayer}'
```

**`document.textLayer`** says whether there is anything to extract. `absent` means the page is an
image: `pdf text` will return nothing and `pdf to-markdown` will emit nothing for it. That is not a
failure to work around. If the text is needed, run `pdf ocr`, which recognises exactly those pages
when Tesseract is installed (`AP470` says it is not — report that and stop). There is no `--ocr` on
`pdf text`: recognised text is a separate result with `source: "ocr"` and a confidence per page.

**`document.tagged`** decides whether converted structure can be trusted, and
`document.structured` is the measured version of that claim. Some producers declare tagging and ship
an empty tree, which reports `tagged: true`, `structured: "none"`, and `AP114`.

## Images, page renders, and recognition

```bash
cairn pdf images report.pdf --out ./figures --min-size 64   # each picture, plus figures/images.json
cairn pdf render report.pdf --page 12 --box 72,400,540,700 --dpi 300 --out fig.png
cairn pdf ocr scan.pdf --out scan.ocr.json                   # only the pages with no text layer
```

`pdf images` writes a JPEG as the JPEG it already is and everything else as PNG, and records for
each placement the page, the object, the pixel size, the colour space, and `box`. `pdf render` is
deterministic: the same file and arguments give the same PNG bytes, so a rendered figure can be
committed and checked. Both need nothing beyond cairn itself, except that `render` and `ocr` use the
optional `@napi-rs/canvas` (`AP450` when it is missing).

`pdf ocr` output is always marked as recognised: `source: "ocr"` on every page in the payload, and a
`[recognised text: …]` line before every page on stdout. Keep that marking when passing the text on.

## Tagged or untagged is the fact that decides everything

A tagged page carries a structure tree naming its own paragraphs, headings, list items, and table
cells: the conversion reads it and is close to exact. An untagged page has every one of those
boundaries **inferred** from geometry — heading level from font size ranked against the body font,
paragraphs from line spacing, list items from a bullet plus a hanging indent.

`AP200` is always emitted and says which path each page took. The path is chosen **per page**,
because a scanned appendix bound onto a tagged report is a real document. Read it before describing
converted output as the document's structure.

## Streams

**The document is on stdout. Diagnostics are on stderr.** This is the opposite of every
`cairn agent` command, and it is what makes redirection safe:

```bash
cairn pdf to-markdown report.pdf > report.md   # findings do not land in the file
```

So do not parse stdout for findings, and do not read a clean stdout as a clean conversion. Under
`--format json` the payload carries both and goes to stdout instead, so `-fj` is not the same output
in JSON.

## Exit codes, and why `0` does not mean lossless

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | Read or converted. **Approximations do not fail the command.** |
| `1`  | Invocation or I/O error, or the input is not a PDF.            |
| `2`  | An error — or, under `--strict`, any approximation.            |

Every untagged page is inference throughout, so failing on that by default would make a working
conversion indistinguishable from a broken one. **Read `diagnostics` to know what happened; never
report a conversion as faithful because it exited `0`.** Add `--strict` when the task genuinely
requires fidelity — a CI gate, or a document being converted for archival.

Findings carry an `AP###` code and a `quality` of `exact`, `approximate`, or `unsupported`.
[`reference/fidelity.md`](reference/fidelity.md) maps what survives each path; read it when a user
asks what will be lost, or when explaining a specific finding.

## Practice

1. **Inspect before converting anything you did not author.** One cheap call turns "read this PDF"
   into an informed answer, and it is the only way to know whether the document has text at all.
2. **Report the losses, do not bury them.** After converting, summarize the non-`exact` findings in
   plain language. "Two tables were flattened to paragraphs and page 7 is a scan" is the useful
   answer; "converted successfully" is not.
3. **Never present an inferred heading structure as the document's own.** On an untagged document
   say the structure was inferred. `AP200` tells you which it was.
4. **A flattened table is reported, never rebuilt.** `AP202` means tabular content became one
   paragraph per row. Do not hand-assemble a Markdown table from it and present it as the
   document's — you cannot see the merged cells that made the tool refuse.
5. **Recognised text is never the document's own text.** Quote OCR output as recognised, with its
   page confidence, and check a page below the floor (`AP473`) against a `pdf render` of it before
   relying on it. Without an engine, say the page needs OCR; do not guess its content from the
   filename, the outline, or the metadata.
6. **Quote page numbers from `pdf text --pages`, not from the converted Markdown.** Conversion drops
   running headers and rejoins paragraphs across pages, so the Markdown has no page boundaries.
7. **Converted Markdown lands lint-clean.** The stringify options match cairn's own
   `.markdownlintrc`, so `cairn pdf to-markdown spec.pdf --output docs/spec.md` can be followed
   directly by `cairn md lint docs/spec.md --style`.
8. **A timeout names its page and the budget needed.** On a long document `AP005` says where the
   budget ran out and how much the whole needs: rerun with that `--timeout`, or read it in parts
   with `--pages`. It is not one failure per page.
9. **Do not hand-edit converted Markdown to fix a conversion loss silently.** Fix it and say what
   you fixed, or report the limitation.
10. **To get a figure out, render it rather than reconstructing it.** `pdf images` gives each embedded
    picture and its `box`; a chart drawn as vectors has no image at all, so `pdf render --box` cuts
    the region out instead. Every box — from `images`, `ocr` words, or one you pass to `render` — is
    PDF user space: points, origin at the **bottom left**, `/Rotate` not applied.
