# `md context`

## Synopsis

```text
cairn md context [seeds...] [options]
```

Assembles a reproducible context pack: ordered Markdown content with source and line
provenance, plus a manifest explaining why each piece was included. Starting from one or more
seed documents, it walks the workspace reference graph a bounded number of hops and emits the
documents it reaches, split into units.

Everything is deterministic and local. There are no embeddings, no ranking model, and no
network access.

## Arguments

| Argument   | Required | Description                                                                       |
| ---------- | -------- | --------------------------------------------------------------------------------- |
| `seeds...` | No¹      | Markdown files, directories, or globs to start from. Stdin (`-`) is not accepted. |

¹ Required unless `--target` is given. With neither, the command exits `1`.

## Options

| Option                               | Default         | Description                                             |
| ------------------------------------ | --------------- | ------------------------------------------------------- |
| `--format <fmt>`                     | Project default | `llm`, `human`, or `json`.                              |
| `--paths <style>`                    | Project default | `absolute` or `relative`.                               |
| `--depth <n>`                        | `1`             | Graph hops to follow from the seeds, `0`–`6`.           |
| `--section <heading>`                | None            | Restrict seeds to this heading. Repeatable.             |
| `--target <path>`                    | None            | Seed with documents referencing this `path[#fragment]`. |
| `--budget <bytes>`                   | `0`             | Maximum UTF-8 bytes of unit content. `0` is unlimited.  |
| `--backlinks` / `--no-backlinks`     | `false`         | Also follow references backwards.                       |
| `--children` / `--no-children`       | `true`          | Expand `--section` through its subsections.             |
| `--frontmatter` / `--no-frontmatter` | `false`         | Emit each document's frontmatter as its own unit.       |
| `--include <glob>`                   | `files.include` | Repeatable include glob.                                |
| `--exclude <glob>`                   | `files.exclude` | Repeatable exclude glob.                                |
| `-h`, `--help`                       | —               | Show help.                                              |

## Units

The atomic unit is a **flat heading section**: every heading owns the lines up to the next
heading of any depth. The partition is non-overlapping and exhaustive, which is what makes
byte accounting exact — a nested view would charge every ancestor for its children's bytes.

Three kinds are emitted:

| Kind          | Covers                                               | `id`                 |
| ------------- | ---------------------------------------------------- | -------------------- |
| `frontmatter` | The frontmatter block, only with `--frontmatter`.    | `<file>#frontmatter` |
| `preamble`    | Content before the first heading, when there is any. | `<file>#preamble`    |
| `section`     | One heading and the lines it owns.                   | `<file>#<slug>`      |

`--children` affects **seed selection only**. `--section "Release process" --children` selects
the named section plus each of its descendants as separate units — the same bytes as a nested
extraction, with nothing counted twice.

## Ordering

Units are emitted in a total order with no ties:

1. Graph distance from the nearest seed, ascending.
2. The order the document entered the traversal. At distance 0 that is the seed order —
   positional seeds first, then `--target` matches. At each later hop the frontier is extended
   in edge order, forward references before backward ones.
3. Document order within each document.

Every input to that is a sorted list, so the same workspace bytes always produce the same pack.

## Budget

`--budget` counts UTF-8 bytes of unit **content** only. It does not count JSON scaffolding,
provenance comments, or the separators between units.

Truncation is by whole units — a unit is never split. **The pack is a prefix of the ordered
units:** the first unit that would exceed the budget stops inclusion, and every later unit is
reported under `omitted` with `reason: "budget"`. A large unit early in the order can therefore
starve everything after it. That is deliberate: skipping an oversized unit and continuing would
make the pack non-contiguous and make its contents shift unpredictably under small edits.

`budget.tokenEstimate` is `ceil(usedBytes / 4)`. It is a size signal, not a model tokenizer, and
it never affects which units are included — only bytes do. Exact model-specific tokenization
would compromise the provider-neutral design.

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| `0`  | Pack written to stdout, whether or not it was truncated.                  |
| `1`  | No seeds and no `--target`, a `--section` matching nothing, or bad input. |

Broken dependencies among the included documents are reported in `broken` and **do not change
the exit code**. `md context` composes analysis; use `md links` or `md audit` to fail on a
broken reference. Budget truncation is a requested outcome, not a finding, so it does not
change the exit code either.

## Notes and limitations

- **`--depth` is graph hops, not relevance.** A seed that links to a hub pulls that hub's whole
  neighbourhood in at depth 2. The default of `1` is deliberately conservative.
- **Frontmatter headings are filtered out.** `Workspace.document` parses without a frontmatter
  extension, so a short frontmatter block such as `---\ntitle: X\n---` produces a phantom setext
  heading. `md context` drops headings at or before the closing fence rather than emitting a
  bogus unit. `md headers`, `md outline`, and `md section` still show the phantom, since their
  output is published.
- `--backlinks` provenance reads the other way round: `viaLine` is a line in the **discovered**
  document, because that is where the link lives.
