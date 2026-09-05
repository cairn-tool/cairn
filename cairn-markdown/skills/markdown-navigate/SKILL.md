---
name: markdown-navigate
description: Read the structure of a Markdown document without opening the whole file, using the cairn md toolset. Use when you need a document's headings, one specific section, its statistics, its code blocks, its tables, its task list, or its frontmatter — especially for a file too large to read comfortably.
---

# Reading Markdown structure with cairn

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`${PLUGIN_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## Why not just read the file

For a large document, reading the whole thing to answer a narrow question wastes context and
buries the answer. These commands extract the part you need. The habit worth forming:

**`md outline` to see the shape, then `md section` to read the one part that matters.**

```bash
cairn md outline docs/architecture.md            # the map
cairn md section docs/architecture.md "Storage"  # just that section
```

That is two small outputs instead of one enormous one, and it works on a file of any size.

## Structure

| Command               | Answers                                                     |
| --------------------- | ----------------------------------------------------------- |
| `md outline <file>`   | What are the headings, nested?                              |
| `md headers <file>`   | The headings as a flat list with line numbers and slugs     |
| `md structure <file>` | Headings **plus** code blocks, math, and lists, with ranges |
| `md stats <file>`     | How big is this, and what is it made of?                    |

`outline` and `headers` both take `--max-depth <1-6>`; cap it at 2 or 3 on a deep document to get
the shape without the detail.

Use `headers` rather than `outline` when you need slugs — they are the anchor targets other
documents link to, and they are what `md section` accepts.

## Extracting one part

```bash
cairn md section <file> <heading>   # by heading text or slug, case-insensitive
cairn md frontmatter <file>         # the YAML frontmatter
cairn md tasks <file>               # GFM checkboxes
cairn md tables <file>              # GFM tables
cairn md code-blocks <file>         # fenced blocks
```

The ones worth knowing the flags for:

| Command       | Flag                   | Effect                                              |
| ------------- | ---------------------- | --------------------------------------------------- |
| `section`     | `--raw`                | Raw Markdown only, no metadata. Ignores `--format`. |
| `section`     | `--no-children`        | Just this heading's own prose, not its subsections  |
| `section`     | `--no-include-heading` | Body without the heading line                       |
| `frontmatter` | `--key author.name`    | One key, dot notation for nesting                   |
| `tasks`       | `--summary`            | Counts only                                         |
| `tasks`       | `--status pending`     | Filter by state                                     |
| `code-blocks` | `--lang ts`            | Only that language                                  |
| `code-blocks` | `--content`            | Include the code, not just the locations            |
| `tables`      | `--index 2`            | Just the second table (1-based)                     |

`section --raw` is what you want when the extracted text is going into another file or a message.
Everything else wraps it in metadata.

`code-blocks` and `tables` omit content by default — they report _where_ things are. Add
`--content` when you actually need the text.

## Generating a table of contents

```bash
cairn md toc <file>                     # print one
cairn md toc <file> --max-depth 3 --ordered
cairn md toc <file> --check             # is the marker block current?
cairn md toc <file> --write             # update it
```

`--write` only touches content between the document's TOC markers. It is a writing command —
see the `markdown-refactor` skill before using it.

## Impact before a rename

`cairn md refs-to <file> [directory]` lists every document pointing at a file. Run it before
renaming, moving, or deleting anything. If you are going to do the rename, `md rename-file`
updates those references for you — see `markdown-refactor`.

## More

Whole-workspace questions — querying many documents at once, building a context pack, the
reference graph — belong to the `markdown-query` skill. Full flag tables for the commands here
are in [`reference/structure.md`](reference/structure.md).
