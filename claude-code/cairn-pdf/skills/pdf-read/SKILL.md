---
name: pdf-read
description: Read PDF documents with the cairn pdf toolset — extract the text layer, read the outline, check structural integrity, and convert content to Markdown, reporting what each conversion inferred or lost. Use when asked to read, summarize, quote, or convert a PDF, when a PDF needs to become Markdown for a docs tree, or when deciding whether a document carries usable text at all.
---

# Reading PDF documents

A PDF is not a document in the sense the rest of a repository means it. There is no text file
underneath, no structure to walk, and often no text at all. `cairn pdf` turns one into text,
structure, or Markdown — deterministically and locally: no credentials, no network, no model call,
and **no OCR**.

Confirm the toolset exists before relying on it: `cairn describe pdf -fj` lists the five
subcommands. If the group is absent, the installed cairn predates this feature — say so and stop
rather than guessing at flags. All five are `stability: experimental`, so read payload shapes
through `cairn describe` and `cairn schema pdf-result` rather than hardcoding them.

## Commands

| Command                  | When                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `pdf inspect <file>`     | **First, always.** What is this, and what will reading it cost?   |
| `pdf text <file>`        | The characters are wanted, not the structure.                     |
| `pdf to-markdown <file>` | The structure is wanted: headings, lists, tables.                 |
| `pdf outline <file>`     | The bookmarks — a table of contents, or where a chapter starts.   |
| `pdf validate <file>`    | Is this file structurally sound before trusting anything from it? |
| `pdf attachments <file>` | What files are embedded inside it, and get them out.              |
| `pdf forms <file>`       | The form's field names and the values already filled in.          |

`-` reads stdin for all of them. `text` and `to-markdown` take `--pages`, `--output`, and
`--strict`.

If the `cairn` MCP server is available, `inspect_pdf`, `read_pdf_text`, `convert_pdf_to_markdown`,
`get_pdf_outline`, `list_pdf_attachments`, and `list_pdf_form_fields` do the same work for a PDF
**inside the served root**, and are cheaper than shelling out. For a PDF anywhere else, or to
extract an embedded file, use the CLI: the MCP surface writes nothing.

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
failure to work around — it is the answer. **This toolset has no OCR**, so say the document needs
OCR and stop rather than trying another command in the hope of a different result.

**`document.tagged`** decides whether converted structure can be trusted, and
`document.structured` is the measured version of that claim. Some producers declare tagging and ship
an empty tree, which reports `tagged: true`, `structured: "none"`, and `AP114`.

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
5. **A page with no text layer needs OCR, which this cannot do.** Say so. Do not fall back to
   guessing content from the filename, the outline, or the metadata.
6. **Quote page numbers from `pdf text --pages`, not from the converted Markdown.** Conversion drops
   running headers and rejoins paragraphs across pages, so the Markdown has no page boundaries.
7. **Converted Markdown lands lint-clean.** The stringify options match cairn's own
   `.markdownlintrc`, so `cairn pdf to-markdown spec.pdf --output docs/spec.md` can be followed
   directly by `cairn md lint docs/spec.md --style`.
8. **Do not hand-edit converted Markdown to fix a conversion loss silently.** Fix it and say what
   you fixed, or report the limitation.
