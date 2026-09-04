# Reading PDF documents

Why the `pdf` toolset exists: an assistant cannot read a PDF, and neither can `grep`. A PDF is not a
document in the sense the rest of cairn means it — there is no text file underneath, no structure to
walk, and frequently no text at all. `cairn pdf` turns one into something the `md` toolset, a
reviewer, or a model can actually work with, and tells you exactly what that cost.

Everything is local and deterministic: no credentials, no network, no model call. Nothing embedded
in the document is ever executed, and **no command ever writes a PDF**.

```bash
# What is this, and what will converting it cost?
cairn pdf inspect report.pdf -fh

# Get the text
cairn pdf text report.pdf > report.txt

# Get the structure
cairn pdf to-markdown report.pdf > report.md

# Is it sound?
cairn pdf validate incoming.pdf
```

## Start with `inspect`, always

Two fields decide what everything else can tell you, and both are on `pdf inspect`.

`document.tagged` says whether the document carries a structure tree. `document.textLayer` says
whether it carries text at all. A document that is tagged and has a present text layer converts
almost exactly. A document whose text layer is `absent` is a stack of images, and there is nothing
for any command here to extract.

Running `pdf to-markdown` without checking first is not dangerous — it will tell you what it did —
but it is the difference between reading a diagnostic and being surprised by one.

## A text layer is not the text on the page

The text layer is what the producer wrote into the file. It is usually the text you can see, and
sometimes it is not: a scan has none, a scan run through OCR elsewhere has one that may be wrong,
and a page can carry a watermark or a Bates stamp in a real text layer with the actual content as an
image behind it.

That last case is why `pdf inspect` classifies by **density** rather than by presence. A page with
eleven characters on it is reported `absent`, not `present`, because eleven characters is a stamp
rather than a document. The character count and the density are both in the payload, so if you
disagree with where the line sits you can move it yourself:

```bash
cairn pdf inspect scan.pdf -fj | jq '[.pages[] | select(.density < 12) | .page]'
```

**This toolset does no OCR.** It reports when OCR would be needed and stops there.

## Tagged or untagged is the fact that decides everything

A PDF has no paragraphs, no headings, and no lists. It has glyphs at coordinates. So there are two
completely different ways `pdf to-markdown` can work.

If the document is **tagged**, the producer recorded the structure — this is a paragraph, this is a
level-2 heading, these cells are a table — and the conversion reads it. Word, LaTeX with `hyperref`,
and accessibility-conscious publishing pipelines all produce tagged PDFs.

If it is **untagged**, every one of those boundaries is _inferred_ from geometry: heading level from
font size ranked against the body font, paragraphs from line spacing, list items from a bullet plus
a hanging indent, running headers from repetition across pages. It works well, and it is guessing.

`AP200` always says which happened. The path is chosen **per page**, because a scanned appendix
bound onto a tagged report is a real document.

## Conversion is lossy, and says so

`ok: true` does not mean lossless. Every construct that could not be carried across gets a finding
with a `quality`, and `--strict` turns approximations into a blocking exit.

The one thing the converter will not do is guess silently. A table on an untagged page is flattened
to one paragraph per row and reported (`AP202`) rather than rebuilt, because a reconstructed table
gets merged cells and wrapped text wrong and produces something a reader cannot tell from a correct
table. A structure role the tool does not model emits its text as a paragraph and reports `AP219`
rather than disappearing. Dropping content silently is the one failure this project refuses.

## The document owns stdout

Findings go to stderr, so redirection just works:

```bash
cairn pdf to-markdown report.pdf > report.md      # only Markdown in the file
cairn pdf to-markdown report.pdf 2> findings.txt  # only findings here
```

That is the opposite of the `agent` commands, which put findings on stdout. Under `--format json`
the payload carries both and goes to stdout instead — so `-fj` is not "the same output in JSON".

## Converted Markdown lands lint-clean

The `remark-stringify` options are pinned and shared with `jira adf to-markdown`, and they match
this repository's own `.markdownlintrc`. So a converted document drops straight into a docs tree:

```bash
cairn pdf to-markdown spec.pdf --output docs/reference/spec.md
cairn md lint docs/reference/spec.md --style
cairn md toc docs/reference/spec.md --write
```

## Getting content out that is not the page

Two commands read things that are inside the document but are not its text.

[`pdf attachments`](../commands/pdf/attachments.md) lists the files embedded in a PDF, and writes
them out unchanged under `--extract`. Without that flag it writes nothing at all — binary never goes
to stdout under any format, so the inventory is always safe to run and the write is always explicit.
An embedded file's stored name is chosen by whoever built the document and will eventually contain
`../`, so extraction is planned in full before anything is written: one refused destination means no
file is written, and a name that collides is resolved rather than overwriting.

[`pdf forms`](../commands/pdf/forms.md) reports AcroForm field names, types, and current values,
which are frequently the most useful thing in a filled form and a nuisance to reach any other way.
It reads and never writes; there is no flag that sets a value. An XFA form reports `type: "xfa"`
with no fields rather than an empty list, because its values live in an XML packet this does not
read and silence there would look exactly like a document with no form.

## Over MCP

Six of these commands are also [MCP tools](../commands/serve.md#tools) — `inspect_pdf`,
`read_pdf_text`, `convert_pdf_to_markdown`, `get_pdf_outline`, `list_pdf_attachments`, and
`list_pdf_form_fields` — so a host can read a PDF without shelling out.

Two constraints come with that surface. A PDF must live **under `--root`**, like every other path
argument; that is a genuine narrowing, and it is preferred to introducing a second confinement
boundary on a surface whose whole claim is that there is one. And nothing there writes: the
attachment tool inventories, and `--extract` has no equivalent.

## There is no writer, and there will not be one

Input is a PDF; output is Markdown, text, or JSON. No merge, split, page reorder, rotation, form
fill, watermark, or redact.

That boundary buys three things worth keeping: no PDF-writing library in the dependency tree, a much
smaller failure surface (every command is idempotent with respect to its input — a bug can produce
wrong output, it cannot corrupt a document), and a coherent security posture. "Parse hostile input
carefully and never act on it" is defensible; "parse it, act on it, and write the result back" is a
much harder position to hold.

Redaction in particular is absent on purpose. Getting it 95% right produces a document that _looks_
redacted and is not — which is exactly the indistinguishable-from-success failure the rest of this
page is about.

## Related

- [PDF commands](../commands.md#pdf-commands)
- [Shared PDF command behavior](../commands/pdf/common.md)
- [Diagnostic codes](../formats/diagnostic-codes.md#pdf-invocation-and-input)
- [Jira and Confluence rich text](jira.md) — the other conversion into Markdown
