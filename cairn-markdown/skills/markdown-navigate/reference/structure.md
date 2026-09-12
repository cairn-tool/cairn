# Structure commands in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats, exit codes, and config
discovery. Every command here takes a single `<file>`.

## Headings

| Command               | Output                                                        |
| --------------------- | ------------------------------------------------------------- |
| `md outline <file>`   | Nested outline. `--format json` gives a tree with `children`. |
| `md headers <file>`   | Flat list with depth, line number, and GitHub-compatible slug |
| `md structure <file>` | Headings, code blocks, math blocks, and lists, with ranges    |

Both `outline` and `headers` take `--max-depth <1-6>`.

Slugs come from `headers`, and they are what `md section` accepts and what `#anchor` links target.

## `md section <file> <heading>`

Extracts one section by heading text or anchor slug, case-insensitively.

| Option                 | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `--raw`                | Raw Markdown only, no metadata. **Ignores `--format`.** |
| `--no-include-heading` | Omit the heading line                                   |
| `--no-children`        | Omit nested subsections                                 |

Exit `1` when the file or heading is not found.

## `md stats <file>`

Word count, headings by depth, internal and external link counts, image counts, code blocks by
language, paragraphs, and lists. One call answers "how big is this and what is in it".

## `md code-blocks <file>`

| Option              | Meaning                                     |
| ------------------- | ------------------------------------------- |
| `--lang <language>` | Only blocks in that language                |
| `--content`         | Include the code; locations only by default |

## `md tables <file>`

| Option        | Meaning                                      |
| ------------- | -------------------------------------------- |
| `--content`   | Include table contents; locations by default |
| `--index <n>` | Extract only the nth table (1-based)         |

## `md tasks <file>`

GFM checkbox items with completion state.

| Option             | Meaning                          |
| ------------------ | -------------------------------- |
| `--status done`    | Only completed items             |
| `--status pending` | Only outstanding items           |
| `--summary`        | Counts only, no individual items |

## `md frontmatter <file>`

Parses YAML frontmatter. `--key <key>` extracts one value, dot notation for nesting
(`--key author.name`).

Exit `0` when frontmatter is present **or** absent; exit `1` when the file or the requested key
is not found.

## `md toc <file>`

Read-only unless given a mode flag — see the `markdown-refactor` skill before writing.

| Option            | Meaning                          |
| ----------------- | -------------------------------- |
| `--max-depth <n>` | Deepest heading level (1-6)      |
| `--min-depth <n>` | Shallowest heading level (1-6)   |
| `--ordered`       | Numbered list instead of bullets |

## `md refs-to <file> [directory]`

Every Markdown document referencing the given file. Searches the current directory by default.
`--include` and `--exclude` take globs.

Run it before renaming, moving, or deleting anything.
