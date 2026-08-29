# `md diff`

## Synopsis

```text
cairn md diff <a> <b> [options]
cairn md diff --since <revision> [directory] [options]
```

Summarizes Markdown changes by structure rather than by text: headings added, removed, moved,
or renamed; frontmatter keys; links whose resolved target changed; task state; code-block
language and body; and tables or diagrams appearing and disappearing.

This is a complement to `git diff`, not a replacement. It answers "what changed about this
document" rather than "which bytes changed."

## Arguments

| Argument | Required | Description                                                   |
| -------- | -------- | ------------------------------------------------------------- |
| `a`      | No¹      | First file, or the directory to scan when `--since` is given. |
| `b`      | No¹      | Second file. Omit when using `--since`.                       |

¹ Give either two paths or `--since`. Giving both, or neither, exits `1`.

## Options

| Option                       | Default         | Description                                       |
| ---------------------------- | --------------- | ------------------------------------------------- |
| `--format <fmt>`             | Project default | `llm`, `human`, or `json`.                        |
| `--paths <style>`            | Project default | `absolute` or `relative`.                         |
| `--since <revision>`         | None            | Compare the worktree against this Git revision.   |
| `--summary` / `--no-summary` | `false`         | Per-file totals only, without individual changes. |
| `--include <glob>`           | `files.include` | Repeatable include glob.                          |
| `--exclude <glob>`           | `files.exclude` | Repeatable exclude glob.                          |
| `-h`, `--help`               | —               | Show help.                                        |

`--since` names the **base of the comparison**. It is deliberately not spelled
`--changed-since`, which on `md lint`, `md audit`, and others merely _filters_ an input set.

Revision mode reads the base content with `git show` and never touches the worktree. A
revision git cannot resolve is an error — it is never treated as "every file is new".

## What is compared

| Class       | Reported                                                                      |
| ----------- | ----------------------------------------------------------------------------- |
| Headings    | `added`, `removed`, `moved`, `renamed`, plus `bodyChanged` on a matched pair. |
| Frontmatter | Per dotted key, plus a whole-block record when the parse status changes.      |
| Links       | Resolved-target changes, with `fragmentChanged` when only the anchor moved.   |
| Tasks       | Completion-state changes.                                                     |
| Code blocks | `langChanged` and `contentChanged`. Mermaid fences carry `mermaid: true`.     |
| Tables      | Added and removed, plus shape or header changes.                              |

Line numbers and slugs are retained on both sides, so a consumer can repair anchors from the
JSON payload without re-reading either revision.

## How headings are matched

Three passes, most certain first:

1. **Exact slug.** Slugs are unique within a document, so this is a reliable pairing.
2. **Exact normalized text.** Recovers a heading whose slug only shifted because a duplicate
   sibling appeared or vanished — GitHub's slugger appends `-1`, `-2` to later duplicates.
   Both `oldSlug` and `newSlug` are always recorded so anchor repair is still possible.
3. **Position.** Pairs a leftover removal with a leftover addition only when the depth, the
   parent heading path, and the position among siblings all agree.

Only the third pass produces a `renamed` verdict, and it is always marked `heuristic: true`
with `matchedBy: "position"`. `moved` is computed on heading **ordinal**, not line number, so
inserting a paragraph does not report every following heading as moved.

String similarity matching is deliberately not used. It is the classic source of confident
nonsense, and a wrong rename is worse than an honest removal plus addition.

## Known false positives

These follow from the matching rules above and are reported honestly rather than hidden:

- Two sibling sections swapped **and** both renamed reads as two renames.
- Deleting one section and adding an unrelated one at the same ordinal reads as a rename.
- A heading that changed text **and** moved reads as a removal plus an addition, because the
  positional pass requires the same ordinal. Conservative, and the right direction to err in.
- A task whose **text** was edited reads as a removal plus an addition; only state changes on
  an unchanged wording are reported as `changed`.
- Frontmatter arrays are compared as whole values. There is no element-wise array diff.

Headings inside a frontmatter block are ignored. `Workspace.document` parses without a
frontmatter extension, so `---\ntitle: X\n---` produces a phantom setext heading that would
otherwise be reported as a change every time frontmatter was edited.

## Exit codes

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| `0`  | Report written to stdout, whether or not anything changed.                     |
| `1`  | Both modes given or neither, a missing file, or a revision git cannot resolve. |

Differences never change the exit code. A diff describes two states; it does not judge them,
and exiting `2` for "there are differences" would fail every non-trivial pull request.
