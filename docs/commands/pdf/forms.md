# `pdf forms`

## Synopsis

```text
cairn pdf forms <file> [options]
```

Lists a PDF's AcroForm fields with their types and current values.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

The [common options](common.md#options), plus:

| Option     | Default | Description                                                |
| ---------- | ------- | ---------------------------------------------------------- |
| `--strict` | off     | Treat a form this cannot fully read as a blocking finding. |

## It reads; there is no way to fill a field

Field names and values are frequently the most useful thing in a filled form and a nuisance to reach
any other way — which is why this command exists. Writing one back is manipulation, which this
toolset [does not do](common.md#this-toolset-reads-it-never-writes-a-pdf), so there is no flag that
sets a value and there will not be.

```console
$ cairn pdf forms application.pdf
  1  agree      checkbox = "Off"
  1  fullName   text = "Ada Lovelace"
  1  internal   text = "secret" [hidden]
  1  reference  text = "REF-001" [read-only]
```

## One field, many widgets

A single field can render in several places — the same value shown on page 1 and again on a summary
page. The parser reports one entry per widget; this folds them into one row carrying a `widgets`
count, because a consumer wants the field and the multiplicity is the only part of the repetition
that carries information.

A field's `page` is reported **1-based**, matching every other page number in this toolset. The
parser reports it 0-based, and `-1` for a field attached to no page at all — that becomes
`page: null` plus `AP312`, never page 0.

## Password fields are reported, with the flag

A field marked as a password field is emitted with its value and `password: true`.

The value is not withheld, because withholding it would be theatre rather than protection: the same
bytes are already reachable through [`pdf text`](text.md) and by any other reader of the file. The
flag is what a consumer needs in order to decide how to treat it — redacting it here would hide the
fact that the document contains it at all.

## XFA forms are named, not silently empty

An XFA form keeps its field values in an XML packet rather than in AcroForm objects, and that packet
is not read. Such a document reports `type: "xfa"` with no fields and `AP311`.

This is the `AP219` analogue: reporting an empty field list without saying why would be
indistinguishable from a document that carries no form at all, which is the one degradation this
repository refuses.

There is deliberately **no** finding for "declares a form with no fields". The parser reports that
identically to "carries no form", so a separate code would be a claim this cannot support.

## Examples

```bash
# Every field and its value
cairn pdf forms application.pdf

# Just the filled ones, as a table
cairn pdf forms application.pdf -fj |
  jq -r '.form.fields[] | select(.value != "" and .value != null) | [.name, .value] | @tsv'

# Is this form actually readable?
cairn pdf forms application.pdf -fj | jq '.form.type'
```

## Exit codes

| Condition                                           | Code | Stream |
| --------------------------------------------------- | ---- | ------ |
| Reported, including a document that carries no form | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF  | `1`  | stderr |
| Under `--strict`, a form this cannot fully read     | `2`  | stderr |

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf attachments`](attachments.md) — the other command that reads content out of a document
- [`cairn serve mcp`](../serve.md) — `list_pdf_form_fields`
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-embedded-files-and-forms)
