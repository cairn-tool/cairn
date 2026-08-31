# `jira adf validate`

## Synopsis

```text
cairn jira adf validate <source> [options]
```

Checks an ADF document's structure without converting it: node nesting, required content, and
attribute constraints.

## Arguments

| Argument | Required | Description                                |
| -------- | -------- | ------------------------------------------ |
| `source` | Yes      | Path to an ADF document, or `-` for stdin. |

## Options

Everything in [`jira adf` common behavior](common.md), plus:

| Option     | Default | Description                                                    |
| ---------- | ------- | -------------------------------------------------------------- |
| `--strict` | `false` | Treat an unrecognized node or mark type as a blocking finding. |

## It is not a wrapper around Atlassian's schema

This checks against **cairn's own content model**, and the distinction is deliberate rather than a
shortcut. Atlassian's published JSON Schema is a development dependency read only by the unit test
that proves the two agree — in both directions, so the model can neither permit something illegal
nor needlessly reject something legal. Nothing is vendored, generated, or shipped.

The consequence is honest rather than hidden: a node type the model does not know reports
[`AD100`](../../../formats/diagnostic-codes.md#adf-source-validation) instead of being judged. That is the same
line [`agent test`](../../agent/test.md) draws by leaving `--native` unimplemented and having
[`agent specs`](../../agent/specs.md) publish each target's validator command to run yourself.

## What it checks

| Check                 | Code             | Example                                                          |
| --------------------- | ---------------- | ---------------------------------------------------------------- |
| Node nesting          | `AD110`          | A `heading` inside a `listItem`.                                 |
| Required content      | `AD111`          | A `tableCell` with no blocks; a `bulletList` with no items.      |
| Attribute values      | `AD112`          | `heading` level 9; an unlisted `panelType`; a missing `localId`. |
| Marks in a code block | `AD110`          | ADF forbids marks on text inside `codeBlock`.                    |
| Unknown node or mark  | `AD100`, `AD101` | Reported, not judged.                                            |

The required-content checks matter more than they look. An empty table cell is ordinary Markdown,
and `"content": []` in a cell is invalid ADF — so a hand-built document, or one from another
converter, fails here rather than at the API.

## Examples

```bash
# Check something another tool produced before sending it to Jira.
cairn jira adf validate body.json

# In CI: also fail on anything this tool cannot vouch for.
cairn jira adf validate body.json --strict

# Which node types are unrecognized?
cairn jira adf validate body.json -fj \
  | jq -r '.diagnostics[] | select(.code == "AD100") | .node'
```

## Exit codes

| Condition                                      | Code | Stream |
| ---------------------------------------------- | ---- | ------ |
| No structural errors                           | `0`  | stdout |
| Invocation or I/O error, or input is not ADF   | `1`  | stderr |
| Invalid structure, or `AD100` under `--strict` | `2`  | stderr |

## Related surfaces

- [`jira adf inspect`](inspect.md) answers what a document contains, rather than whether it is legal.
- [`jira adf from-markdown`](from-markdown.md) produces documents this command accepts by construction.
- [Diagnostics](../../../formats/diagnostic-codes.md#adf-source-validation) catalogs every code above.
