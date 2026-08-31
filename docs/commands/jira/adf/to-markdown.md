# `jira adf to-markdown`

## Synopsis

```text
cairn jira adf to-markdown <source> [options]
```

Converts an Atlassian Document Format document to Markdown. Deterministic and local: no
credentials, no network, no model.

## Arguments

| Argument | Required | Description                                |
| -------- | -------- | ------------------------------------------ |
| `source` | Yes      | Path to an ADF document, or `-` for stdin. |

## Options

Everything in [`jira adf` common behavior](common.md), plus:

| Option            | Default | Description                                        |
| ----------------- | ------- | -------------------------------------------------- |
| `--output <file>` | stdout  | Write the Markdown to this file instead of stdout. |
| `--strict`        | `false` | Treat approximations as blocking findings.         |

`--output` writes one file atomically — staged beside the destination, then renamed — and
suppresses the document on stdout, so the two never both carry it.

## It emits no frontmatter, ever

Not an option. An ADF document carries no title, issue key, status, or author, so there is
nothing to put in frontmatter. This falls out of the tool taking a bare document rather than a
REST response: a caller who wants frontmatter has the issue JSON in hand and can compose it with
`jq`.

## What survives

Headings, paragraphs, text, hard breaks, thematic breaks, block quotes, both list kinds, and
fenced code blocks with their language are `exact`.

Everything else is approximated, and each approximation reports a code so a consumer can suppress
precisely. The notable ones:

| ADF                                 | Markdown                                      | Code    |
| ----------------------------------- | --------------------------------------------- | ------- |
| `table`                             | A GFM table; cell blocks flatten to inline    | `AD200` |
| `taskList`                          | A GFM task list; `localId` is not represented | `AD201` |
| `panel`                             | A block quote led by the panel type in bold   | `AD202` |
| `expand`, `nestedExpand`            | A bold title, then the body                   | `AD203` |
| `media` (external)                  | An image                                      | `AD204` |
| `media` (attachment)                | A link carrying the media id                  | `AD205` |
| `layoutSection`                     | Columns collapse into sequential blocks       | `AD207` |
| `mention`, `status`, `date`         | Text, or inline code                          | `AD209` |
| `extension`, macros                 | Nothing                                       | `AD210` |
| `underline`, `subsup`, colour marks | Formatting dropped                            | `AD211` |

An attachment-only `media` node becomes a **link**, not an image:

```markdown
[attachment 9f2a-1c4e](media:9f2a-1c4e)
```

`attrs.id` is a media-services file id, and making it fetchable would need a site base and
Atlassian's URL shape — knowledge this tool deliberately does not have. A link renders as text
that says what it is, where an image with an unfetchable target renders as a broken-image icon
and reads as a converter bug. The `media:` scheme is classified as external by the reference
checker, so [`md lint`](../../md/lint.md) on the converted document stays clean.

Use [`jira adf inspect`](inspect.md) to see all of this for a specific document before converting.

## Output stability

The same input always produces the same bytes. Every `remark-stringify` option is pinned rather
than left at its default, so a dependency bump cannot silently reformat every document this
command has ever produced; anything sortable is sorted by byte comparison rather than
`localeCompare`, which is ICU-build dependent.

## Examples

```bash
# The common case: extract the field, convert, keep the findings on the terminal.
curl -s "$JIRA/rest/api/3/issue/PROJ-1" | jq .fields.description \
  | cairn jira adf to-markdown - > description.md

# Fail the build if anything was lost.
cairn jira adf to-markdown issue.json --strict --output description.md

# Machine-readable, document and findings together.
cairn jira adf to-markdown issue.json -fj | jq -r '.diagnostics[] | .code + " " + .message'
```

## Exit codes

| Condition                                        | Code | Stream |
| ------------------------------------------------ | ---- | ------ |
| Converted                                        | `0`  | stdout |
| Invocation or I/O error, or the input is not ADF | `1`  | stderr |
| An error, or any approximation under `--strict`  | `2`  | stderr |

Exit `0` does not mean lossless. See
[what `ok` means](common.md#exit-codes-and-what-ok-means).

## Related surfaces

- [`jira adf from-markdown`](from-markdown.md) is the reverse direction.
- [`jira adf inspect`](inspect.md) reports the cost before you pay it.
- [Diagnostics](../../../formats/diagnostic-codes.md#adf-to-markdown) catalogs every code above.
