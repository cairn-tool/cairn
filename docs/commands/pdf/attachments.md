# `pdf attachments`

## Synopsis

```text
cairn pdf attachments <file> [options]
```

Lists the files embedded inside a PDF, and writes them out unchanged under `--extract`.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

The [common options](common.md#options), plus:

| Option            | Default | Description                                               |
| ----------------- | ------- | --------------------------------------------------------- |
| `--extract <dir>` | —       | Write the embedded files into this directory.             |
| `--strict`        | off     | Treat a sanitized name or an unreadable file as blocking. |

## Reading, not rewriting

A PDF can carry arbitrary files inside it. This reads bytes that are already in the document and
writes them out unchanged; the source PDF is opened read-only and is never modified. That is what
keeps extraction inside the toolset's [reading boundary](common.md#this-toolset-reads-it-never-writes-a-pdf).

Nothing embedded is ever executed or opened. An embedded file is bytes to this command, whatever it
claims to be.

## Binary never goes to stdout

Not "refuses when stdout is a TTY" — never. `--extract` is the only way bytes leave this command.

A command that emits UTF-8 under one flag and a binary blob under another is a contract no consumer
can code against, so the inventory and the payload are always text and the write is always explicit.
Without `--extract` this command writes nothing at all, which is what makes it safe to expose over
[MCP](../serve.md) as `list_pdf_attachments`.

## Stored names are attacker-controlled

An embedded file's name is chosen by whoever built the document, and will eventually contain `../`.
Three rules follow, and each is visible in the payload rather than applied silently.

**The name is sanitized here.** The parser already strips the directory before this command sees it;
that is not treated as sufficient. Every name is reduced to a basename again, both `/` and `\` are
treated as separators, and a name that is empty, `.`, `..`, drive-relative, or a Windows device name
(`CON`, `NUL`, `COM1`, …) is refused outright rather than repaired into something surprising. Device
names are refused on every platform, not only Windows, so an extraction behaves the same everywhere
rather than failing only on the host that happens to care. The payload carries both `rawFilename` — the
stored name verbatim — and `filename`, so a rename is visible.

**Extraction is planned in full before anything is written.** One refused destination means _no file
is written at all_, rather than a half-populated directory whose contents depend on iteration order.

**A collision never overwrites.** A name already taken, by an earlier attachment or by a file that
was already in the target directory, is written as `name-2.ext` and reports `AP302`. Overwriting
either would destroy something the user did not ask to lose.

```console
$ cairn pdf attachments report.pdf --extract ./out
     4096 c677787e3f16  data.csv       -> /home/me/out/data.csv
        6 33bff9108736  evil.csv       -> /home/me/out/evil.csv
AP301  Stored name '../../etc/evil.csv' was sanitized to 'evil.csv' before writing
```

## What the inventory can and cannot say

Size and SHA-256 require decoding each file. That is done — the document is already in memory, so it
is decompression rather than I/O, and those two fields are what make an inventory actionable. It is
bounded: past the budget an entry is still listed, with `AP304` saying why it carries no size.

The **declared media type is not reported**, because the parser does not expose it. An executable is
identified from its magic number instead and reported as `binary: elf | pe | macho`. Guessing a MIME
type from an extension would be a claim this cannot support.

## Examples

```bash
# What is in here?
cairn pdf attachments report.pdf

# Get them out
cairn pdf attachments report.pdf --extract ./attachments

# Does this document carry an executable?
cairn pdf attachments report.pdf -fj | jq '[.attachments[] | select(.binary)]'

# Fail CI if any embedded name had to be sanitized
cairn pdf attachments report.pdf --extract ./out --strict
```

## Exit codes

| Condition                                                                                          | Code | Stream |
| -------------------------------------------------------------------------------------------------- | ---- | ------ |
| Listed, and written when `--extract` was given                                                     | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF                                                 | `1`  | stderr |
| A destination was refused, a file could not be decoded, or any name was sanitized under `--strict` | `2`  | stderr |

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf forms`](forms.md) — the other command that reads content out of a document
- [`cairn serve mcp`](../serve.md) — `list_pdf_attachments`, inventory only
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-embedded-files-and-forms)
