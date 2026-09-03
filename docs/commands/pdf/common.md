# Shared PDF command behavior

Shared by every [`pdf`](../../commands.md#pdf-commands) subcommand. The per-command pages cover
only what differs.

## This toolset reads; it never writes a PDF

Input is a PDF. Output is Markdown, plain text, or JSON. There is no merge, split, page reorder,
rotation, form fill, watermark, or redact, and there will not be: that is a different product with
a different risk profile, and the boundary is what lets every command here be idempotent with
respect to its input. A bug can produce wrong output; it cannot corrupt a document.

`--output` writes Markdown or text, never a PDF.

## Input

| Form   | Meaning                                |
| ------ | -------------------------------------- |
| a path | Read that file.                        |
| `-`    | Read the document from standard input. |

Every command takes exactly one document. No command reads project configuration: `.cairn.yml` has
no say over how a document handed to the tool on the command line is parsed, on the same reasoning
that keeps `usage` and `scripts` out of it.

## Input is bounded before it is parsed

A PDF is a container format that usually arrives off a network, so the reader treats it as hostile:

| Bound            | Default | Raised by     |
| ---------------- | ------- | ------------- |
| Input size       | 64 MiB  | `--max-bytes` |
| Parse wall clock | 30 s    | `--timeout`   |
| Page count       | 5000    | `--max-pages` |

Symlinks are resolved, and anything that is not a regular file is refused **on the open descriptor**
rather than on the path, so the file cannot be swapped between the check and the read. A FIFO is
refused rather than blocking until a writer appears.

The size default is 64 MiB rather than something larger because the buffer is resident, is then
handed to the parser, and the parser's own object cache commonly runs three to five times the file
size on top of that. A 256 MB input is a multi-gigabyte process, and the failure is an out-of-memory
abort with no diagnostic at all.

**A zip bomb is bounded by time and memory, not by a per-stream byte budget.** The parser does the
decoding and exposes no such hook, so this page does not claim one. What it does claim is the table
above, plus a 32-megapixel cap on any single decoded image.

## Nothing embedded is ever executed

A PDF can carry JavaScript actions, launch actions, submit actions, and additional actions that fire
on open. No command in this toolset runs any of them, follows a launch action, or submits a form.
Outline URLs are recorded and never followed — no fetch, no HEAD, no DNS. Reporting what a document
would do when opened is planned for `pdf audit`; acting on it is not planned at all.

## Streams

The primary output owns **stdout** and diagnostics go to **stderr**, so
`cairn pdf to-markdown report.pdf > report.md` cannot get findings spliced into the document. This
is the opposite of every `agent` subcommand, which puts findings on stdout.

Under `--format json` the payload carries both and goes to stdout instead. That means `-fj` is not
"the same output in JSON": the default already emits the document alone, and `-fj` wraps it in a
result object.

## Options

| Option            | Default  | Description                                                   |
| ----------------- | -------- | ------------------------------------------------------------- |
| `--format <fmt>`  | `llm`    | `llm`, `human`, or `json`.                                    |
| `--envelope`      | off      | Wrap `--format json` output in the versioned result envelope. |
| `--max-bytes <n>` | 67108864 | Maximum input size in bytes, up to 512 MiB.                   |
| `--max-pages <n>` | 5000     | Refuse a document with more pages, before any page is opened. |
| `--timeout <ms>`  | 30000    | Wall-clock budget for parsing.                                |

`--pages`, `--output`, and `--strict` are on the subcommands that can use them; each page says so.

**There is no `--password`.** A password on a command line is readable by every process on the
machine, and this toolset advertises that it needs no credentials. A document that genuinely
requires one reports `AP010` and exits 1. A document encrypted with an _empty_ user password — the
common "protected" case — opens normally and reports `AP113`, because its restrictions are advisory
and the tool says so rather than pretending they were enforced.

## Every payload carries `document`

`document` is present on all five subcommands whenever the document opened, not only on `inspect`.
A conversion from a tagged document and one from a scan are not the same kind of artifact and must
not look identical, so `jq .document.tagged` works on a `to-markdown` payload.

Two fields answer different questions and are both worth reading:

- **`tagged`** is what the document _claims_: it declares `/MarkInfo <</Marked true>>`.
- **`structured`** is what was _measured_, by opening each page's structure tree. Producers do
  declare tagging and ship an empty tree, which reports `tagged: true`, `structured: "none"`, and
  `AP114`.

## Exit codes and what `ok` means

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| `0`  | No blocking findings.                               |
| `1`  | Invocation or I/O error, or the input is not a PDF. |
| `2`  | A blocking finding.                                 |

An `error` always blocks. An approximation blocks only under `--strict`. **`ok: true` does not mean
the conversion was lossless or the text complete** — read `diagnostics`, or run
[`pdf inspect`](inspect.md) first.

All five subcommands can exit 2, including the three that read as pure inventory, because **a PDF
fails per page rather than per document**. An undecodable content stream on page 47 of 300 leaves
the other 299 pages perfectly good, and the command has to emit them _and_ say page 47 is missing.
Reporting nothing would be the one degradation this project refuses.

## Findings

Every finding carries an `AP###` code; the full table is in
[diagnostic codes](../../formats/diagnostic-codes.md#pdf-invocation-and-input). A finding also
carries `quality`, which is what `--strict` reads:

| Quality       | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `exact`       | The construct has a direct equivalent, or nothing was lost.     |
| `approximate` | Something equivalent was emitted, but it is not the same thing. |
| `unsupported` | Nothing was emitted for this construct.                         |

## Stability

Every `pdf` command is `stability: "experimental"`. Read payload shapes through
[`describe`](../describe.md) and [`schema pdf-result`](../schema.md) rather than hardcoding them.
See [contract](../../contract.md#experimental-commands).

## Related surfaces

- [`pdf inspect`](inspect.md), [`pdf text`](text.md), [`pdf outline`](outline.md),
  [`pdf validate`](validate.md), [`pdf to-markdown`](to-markdown.md),
  [`pdf attachments`](attachments.md), [`pdf forms`](forms.md)
- [Reading PDF documents](../../guide/pdf.md)
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-invocation-and-input)
