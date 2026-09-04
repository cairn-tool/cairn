# `pdf outline`

## Synopsis

```text
cairn pdf outline <file> [options]
```

Reads the document outline — its bookmarks — as a heading tree, resolving each destination to a
page number.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

Only the [common options](common.md#options).

## What it reports, and what it does not

It reports the outline the document **declares**, never one inferred from its text. A document with
no `/Outlines` returns an empty tree and exits 0: that is an answer, not a failure.

An entry whose destination does not resolve to a page keeps its title with `page: null` and reports
`AP080`, rather than being dropped — the same rule that gives an unrecognized ADF node `AD100`.

```text
Chapter One (p. 1)
  Section 1.1 (p. 1)
Chapter Two (p. 2)
Dangling (p. —)
```

## URLs are recorded, never followed

An outline entry can carry a URL instead of a page destination. No request is made for it: no fetch,
no HEAD, no DNS.

An entry whose URL uses a scheme the parser refused carries **no `url` field at all**, rather than
presenting a `javascript:` or `file:` URI in a field named as though it were clickable. Bookmarks
carrying script actions are a real phishing vector, and reporting one as an ordinary link would be a
misrepresentation.

## Examples

```bash
# The tree
cairn pdf outline manual.pdf

# A table of contents in Markdown
cairn pdf outline manual.pdf -fj |
  jq -r '.. | objects | select(.title) | "  " * (.level - 1) + "- " + .title'

# Which bookmarks are broken?
cairn pdf outline manual.pdf -fj | jq '[.. | objects | select(.title and .page == null) | .title]'
```

## Exit codes

| Condition                                          | Code | Stream |
| -------------------------------------------------- | ---- | ------ |
| Outline written, possibly empty                    | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF | `1`  | stderr |
| An entry could not be resolved, under `--strict`   | `2`  | stderr |

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf to-markdown`](to-markdown.md) — uses the outline to pin heading levels
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-outline)
