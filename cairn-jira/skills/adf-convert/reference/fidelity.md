# What survives a conversion

Every construct, in both directions, with the diagnostic code it reports. Use this to answer
"what will I lose", to explain a specific finding, or to decide whether `--strict` is
appropriate for a task.

`quality` is one of:

| Quality       | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `exact`       | A direct equivalent exists. Nothing is reported.                |
| `approximate` | Something equivalent was emitted, but it is not the same thing. |
| `unsupported` | Nothing was emitted for this construct.                         |

## ADF to Markdown

### Exact

`doc`, `paragraph`, `text`, `heading` (levels 1-6), `hardBreak`, `rule`, `blockquote`,
`bulletList`, `orderedList` (keeping its start number), `listItem`, and `codeBlock` (keeping its
language).

Marks: `strong`, `em`, `code`, `strike`, and `link` (keeping its title).

### Approximate

| ADF                                    | Markdown                                        | Code    |
| -------------------------------------- | ----------------------------------------------- | ------- |
| `table`, and its row/cell nodes        | A GFM table; cell blocks flatten to inline text | `AD200` |
| A cell with `colspan`/`rowspan`        | The span is dropped                             | `AD200` |
| `taskList`, `taskItem`                 | GFM checkboxes; `localId` is not represented    | `AD201` |
| `panel`                                | A block quote led by the panel type in bold     | `AD202` |
| `expand`, `nestedExpand`               | The title in bold, then the body                | `AD203` |
| `mediaSingle` with external media      | An image                                        | `AD204` |
| `mediaGroup`                           | A list of links                                 | `AD204` |
| `media` with only an attachment id     | `[attachment <id>](media:<id>)`                 | `AD205` |
| `mediaInline`                          | A link carrying the attachment id               | `AD205` |
| `decisionList`, `decisionItem`         | A plain list; decision state is not represented | `AD206` |
| `layoutSection`, `layoutColumn`        | Columns collapse into sequential blocks         | `AD207` |
| `inlineCard`, `blockCard`, `embedCard` | A link to the URL                               | `AD208` |
| `mention`                              | The mention text, or `@<id>`                    | `AD209` |
| `emoji`                                | The emoji character, or its short name          | `AD209` |
| `status`                               | Inline code; the colour is lost                 | `AD209` |
| `date`                                 | An ISO-8601 UTC date, e.g. `2023-11-14`         | `AD209` |

### Unsupported

| ADF                                                                                                                          | Code    |
| ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| `extension`, `bodiedExtension`, `inlineExtension`, `multiBodiedExtension`, `extensionFrame`                                  | `AD210` |
| `placeholder`                                                                                                                | `AD210` |
| Marks: `underline`, `subsup`, `textColor`, `backgroundColor`, `alignment`, `indentation`, `breakout`, `border`, `annotation` | `AD211` |

A node or mark type cairn does not model reports `AD100` or `AD101` and is **not** silently
dropped. If you see one, the document uses something newer than the installed cairn.

## Markdown to ADF

The hard direction, and not because of missing node types. ADF validates per-node content, and
Markdown permits nestings ADF forbids. Those are **flattened in place, never lifted**: promoting
a heading out of a list item would move it past the text that followed it, producing output that
is legal, plausible, and says something the input did not.

Legal Markdown is never an error — only invalid input is.

| Markdown                                         | ADF                                           | Code    |
| ------------------------------------------------ | --------------------------------------------- | ------- |
| Heading in a list item or block quote            | A paragraph in bold, in place                 | `AD300` |
| Block quote in a list item                       | Its contents lifted into the item             | `AD301` |
| Nested block quote                               | Merged into one level                         | `AD301` |
| Table in a list item or block quote              | One paragraph per row, cells joined by `\|`   | `AD302` |
| Thematic break in a list or quote                | Omitted; it carries no content                | `AD304` |
| A task item with several blocks                  | One inline run joined by hard breaks          | `AD304` |
| An empty list, or a list whose items all dropped | The list is dropped                           | `AD304` |
| Inline image                                     | The paragraph split around a `mediaSingle`    | `AD305` |
| Image inside a table cell                        | A link to its source                          | `AD305` |
| Raw HTML block                                   | Preserved verbatim in a code block            | `AD306` |
| Inline HTML                                      | Preserved as inline code                      | `AD306` |
| Footnote reference                               | Superscript text                              | `AD308` |
| Footnote definition                              | Moved to the end, after a rule                | `AD308` |
| YAML frontmatter                                 | Dropped; it is metadata, not content          | `AD309` |
| Table column alignment                           | Dropped; an ADF cell has no alignment         | `AD310` |
| A list mixing task and plain items               | Split into runs, in place                     | `AD311` |
| A task list inside a block quote                 | A bulleted list keeping `[x]` as literal text | `AD311` |

Everything else maps exactly: headings, paragraphs, thematic breaks, code blocks with their
language, block quotes, both list kinds, tables, task lists, the four inline marks, and links —
including reference links, which are resolved through their definitions.

### Two things that are not round-trippable

1. **A footnote** becomes a `subsup` mark, which has no Markdown form coming back, so a second
   conversion yields plain text.
2. **A task list downgraded inside a block quote** keeps `[x]` as visible text, but converting
   back escapes the bracket rather than re-parsing it as a checkbox.

Both are declared rather than accidental. Do not describe either as a lossless round trip.

### Empty containers

ADF requires content where Markdown does not, and the common case is ordinary:

| Node                        | ADF requires | What cairn emits          |
| --------------------------- | ------------ | ------------------------- |
| `tableCell`, `tableHeader`  | One block    | An empty paragraph        |
| `listItem`                  | One block    | An empty paragraph        |
| `bulletList`, `orderedList` | One item     | The list is dropped       |
| `table`                     | One row      | The table is dropped      |
| `doc`                       | Nothing      | An empty document is fine |

An empty table cell is the one that bites: `"content": []` in a cell is invalid ADF, so a
hand-assembled document usually fails `jira adf validate` there first.

## Reading a finding

```json
{
  "code": "AD300",
  "severity": "warning",
  "quality": "approximate",
  "message": "ADF does not allow heading inside listItem; it became a paragraph in bold, in place",
  "node": "heading",
  "location": "doc/bulletList/listItem"
}
```

`node` is what the finding is about; `location` is the ancestor path to where it happened. A
`severity` of `error` always fails the command; `warning` fails only under `--strict`.
