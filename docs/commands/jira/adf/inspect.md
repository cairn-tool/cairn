# `jira adf inspect`

## Synopsis

```text
cairn jira adf inspect <source> [options]
```

Lists every node and mark type in an ADF document, with a count and a fidelity rating for each.
The question it answers is what a conversion will cost, asked before paying it.

## Arguments

| Argument | Required | Description                                |
| -------- | -------- | ------------------------------------------ |
| `source` | Yes      | Path to an ADF document, or `-` for stdin. |

## Options

Only the [common options](common.md#options). There is no `--strict`: this command reports no
findings of its own.

## What it reports

One row per type, nodes before marks, each sorted by byte comparison of the type name:

```text
paragraph  node     4  exact        A paragraph.
panel      node     1  approximate  A block quote led by the panel type.
table      node     1  approximate  A GFM table. Cell blocks and spans flatten.
text       node    17  exact        Text, with its marks mapped separately.
strong     mark     3  exact        Strong emphasis.
underline  mark     1  unsupported  Markdown has no underline.
```

| Quality       | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `exact`       | Markdown has a direct equivalent.                              |
| `approximate` | Something equivalent is emitted, but it is not the same thing. |
| `unsupported` | Nothing is emitted for this construct.                         |

A type the content model does not recognize is listed as `unsupported` with a note saying so,
rather than omitted. An inventory that quietly skips what it does not recognize is worse than no
inventory.

## Examples

```bash
# What will I lose converting this?
cairn jira adf inspect issue.json

# Just the lossy constructs.
cairn jira adf inspect issue.json -fj \
  | jq -r '.inventory[] | select(.quality != "exact") | "\(.count)\t\(.type)\t\(.note)"'

# Does this document use anything this cairn does not know?
cairn jira adf inspect issue.json -fj | jq '[.inventory[] | select(.note | test("Unrecognized"))]'
```

## Exit codes

| Condition                                    | Code | Stream |
| -------------------------------------------- | ---- | ------ |
| Inventory written                            | `0`  | stdout |
| Invocation or I/O error, or input is not ADF | `1`  | stderr |

It never exits `2`.

## Related surfaces

- [`jira adf to-markdown`](to-markdown.md) performs the conversion this command prices.
- [`jira adf validate`](validate.md) answers whether a document is legal, rather than what it holds.
