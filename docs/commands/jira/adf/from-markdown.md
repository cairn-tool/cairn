# `jira adf from-markdown`

## Synopsis

```text
cairn jira adf from-markdown <source> [options]
```

Converts a Markdown document to Atlassian Document Format, ready to be placed in a Jira or
Confluence API call.

## Arguments

| Argument | Required | Description                                |
| -------- | -------- | ------------------------------------------ |
| `source` | Yes      | Path to a Markdown file, or `-` for stdin. |

## Options

Everything in [`jira adf` common behavior](common.md), plus:

| Option            | Default | Description                                        |
| ----------------- | ------- | -------------------------------------------------- |
| `--output <file>` | stdout  | Write the ADF JSON to this file instead of stdout. |
| `--strict`        | `false` | Treat approximations as blocking findings.         |

## `-fj` does not mean "the same output, in JSON"

The default format already emits pure ADF JSON. `--format json` wraps that document in the result
payload alongside the findings:

```bash
cairn jira adf from-markdown notes.md              # the ADF document, alone
cairn jira adf from-markdown notes.md -fj          # { command, ok, source, adf, diagnostics }
cairn jira adf from-markdown notes.md -fj | jq .adf   # the document again
```

A consumer that wants the bare document uses the default. Use `-fj` when the findings need to be
machine-readable too.

Key order in the emitted JSON is contract: `version`, `type`, `attrs`, `content`, `marks`, `text`,
with attribute keys in byte order. `JSON.stringify` follows insertion order, so a consumer diffing
converted ADF in Git would otherwise see spurious reorderings.

## The hard part is legality, not missing node types

ADF validates per-node content, and Markdown permits nestings ADF forbids. A heading inside a
list item, a table inside a block quote, a nested block quote — all are ordinary Markdown and all
are illegal ADF. So this is not a node-for-node walk: every emission is checked against the
content model, and an illegal pair is **flattened in place**.

| Markdown                          | ADF                                         | Code    |
| --------------------------------- | ------------------------------------------- | ------- |
| Heading in a list item or quote   | A paragraph in bold, in place               | `AD300` |
| Block quote in a list item        | Its contents lifted into the item           | `AD301` |
| Table in a list item or quote     | One paragraph per row, cells joined by `\|` | `AD302` |
| Thematic break in a list or quote | Omitted; it carries no content              | `AD304` |
| Multi-block task item             | One inline run joined by hard breaks        | `AD304` |
| Inline image                      | The paragraph split around a `mediaSingle`  | `AD305` |
| Raw HTML                          | Preserved verbatim in a code block          | `AD306` |
| Footnotes                         | Superscript marker; body after a rule       | `AD308` |
| YAML frontmatter                  | Dropped, with a finding                     | `AD309` |
| Table column alignment            | Dropped: an ADF cell has no alignment       | `AD310` |
| Mixed task and plain list         | Split into runs, in place                   | `AD311` |
| Dangling link reference           | Text kept, without the link                 | `AD312` |

**Never lifted.** Promoting a heading out of a list item would move it before or after the list,
so the text that followed it inside the item would sit under a different heading — output that is
legal, plausible, and says something the input did not. Flattening preserves reading order.

**Legal Markdown is never an error.** Only invalid input is. A caller who does want
refuse-by-default has `--strict`.

An inline image splits its paragraph rather than moving: ADF images are block-level, and
`mediaInline` cannot carry an external URL. Splitting preserves reading order exactly, because
nothing moves past anything else.

## Frontmatter is metadata, not content

Frontmatter is never inlined into the document body. It is dropped with `AD309` naming the
condition. Emitting it as a leading code block would put YAML in front of every Jira reader and
would not round-trip, since a genuine leading `yaml` fence is the same node.

## Round-trip behavior

`from-markdown` then `to-markdown` will not reproduce the input bytes on the first pass: the
serializer normalizes emphasis markers, heading style, and list markers. It is stable from the
second pass on. Two mappings are deliberately one-directional and will not survive a round trip:

- A footnote marker becomes a `subsup` mark, which has no Markdown form coming back.
- A task list downgraded inside a block quote keeps `[x]` as literal text, which the Markdown
  serializer escapes rather than re-parsing as a checkbox.

## Examples

```bash
# Build a Jira request body.
cairn jira adf from-markdown notes.md | jq '{fields: {description: .}}' > body.json

# Fail if anything degraded.
cairn jira adf from-markdown notes.md --strict --output body.json

# Read the findings machine-readably.
cairn jira adf from-markdown notes.md -fj | jq -r '.diagnostics[] | .code + " " + .location'
```

## Exit codes

| Condition                                       | Code | Stream |
| ----------------------------------------------- | ---- | ------ |
| Converted                                       | `0`  | stdout |
| Invocation or I/O error                         | `1`  | stderr |
| An error, or any approximation under `--strict` | `2`  | stderr |

## Related surfaces

- [`jira adf to-markdown`](to-markdown.md) is the reverse direction.
- [`jira adf validate`](validate.md) checks a document this command produced.
- [Diagnostics](../../../formats/diagnostic-codes.md#markdown-to-adf) catalogs every code above.
