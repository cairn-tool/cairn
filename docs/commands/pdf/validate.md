# `pdf validate`

## Synopsis

```text
cairn pdf validate <file> [options]
```

Checks a document's structural integrity without converting it, and is explicit about the large set
of things it does not check.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

Everything in [`pdf` common behavior](common.md#options), plus:

| Option     | Default | Description                                           |
| ---------- | ------- | ----------------------------------------------------- |
| `--strict` | off     | Treat an unsupported construct as a blocking finding. |

There is no `--pages`. A partial validation that reported `valid` would be a lie.

## What it checks

What the parser itself can see, walking every page:

| Check                                  | Code    |
| -------------------------------------- | ------- |
| The document parses at all             | `AP100` |
| The cross-reference table was rebuilt  | `AP101` |
| A page is reachable in the page tree   | `AP020` |
| A page's content stream decodes        | `AP021` |
| Fonts resolved, or were substituted    | `AP110` |
| Stream filters are supported           | `AP111` |
| Metadata is readable                   | `AP112` |
| Encryption opened on an empty password | `AP113` |
| A tagging claim has a tree behind it   | `AP114` |

A damaged cross-reference table that was successfully rebuilt reports `AP101` and **still parses**,
so a finding here does not mean the document is unreadable. Without `--strict` it exits 0.

## What it does not check, and will not claim to

This is deliberately **not** a PDF/A, PDF/UA, or PDF/X conformance checker. Full conformance
validation is veraPDF's job and is a Java program; claiming it here would be a lie. That is the same
line [`jira adf validate`](../jira/adf/validate.md) draws when it reports `AD100` for a node type it
does not model rather than pretending to be Atlassian's schema.

Also not checked, and not reported on:

- **Digital signature validity**, certificate chains, or timestamps.
- **Byte-level spec conformance** — object numbering, `/Length` mismatches, trailing garbage after
  `%%EOF`. The parser repairs these below the warning threshold.
- **Whether the document renders correctly.** Nothing here rasterizes. A page whose text extracts
  cleanly and draws as a black rectangle passes.
- **Font glyph coverage.** `AP110` reports fonts that failed to _load_, not glyphs that would fail
  to _draw_; the latter is only discoverable at render time.
- **Colour spaces, transparency groups, overprint, output intents.**
- **Accessibility beyond "a structure tree exists".** No alt-text completeness, no reading-order
  correctness, no contrast. Those are PDF/UA claims and this is not a PDF/UA checker.

## Some findings depend on the parser's own wording

Several checks exist only because the parser reports the condition in prose. That coupling is
contained rather than accepted: each pattern has a test driven by a deliberately damaged fixture, so
an upgrade that rewords a message fails the suite instead of quietly turning the check off. An
unmatched warning is **not** dropped — it is reported as `AP120` carrying the raw text, so a
reworded message degrades to "something was recovered here" rather than to silence.

## Examples

```bash
# Is this file structurally sound?
cairn pdf validate incoming.pdf

# Block a pipeline on anything the parser had to repair
cairn pdf validate incoming.pdf --strict

# What exactly was wrong?
cairn pdf validate incoming.pdf -fj | jq '.diagnostics[] | {code, severity, page, message}'
```

## Exit codes

| Condition                                              | Code | Stream |
| ------------------------------------------------------ | ---- | ------ |
| No structural errors                                   | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF     | `1`  | stderr |
| A structural error                                     | `2`  | stderr |
| A recovered or unsupported construct, under `--strict` | `2`  | stderr |

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf inspect`](inspect.md) — what the document _is_, rather than whether it is sound
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-structural-integrity)
