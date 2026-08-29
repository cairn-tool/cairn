# `md fix`

## Synopsis

```text
cairn md fix <inputs...> [options]
```

Turns deterministic findings into reviewable edits. Every fixer produces a _plan_ — byte
ranges, the exact text expected at each range, the replacement, and the diagnostic that asked
for it — and `--write` applies the whole plan as one transaction.

Only unambiguous transformations are in scope. Nothing here guesses.

## Arguments

| Argument    | Required | Description                                                     |
| ----------- | -------- | --------------------------------------------------------------- |
| `inputs...` | Yes      | Markdown files, directories, or globs. Stdin (`-`) is rejected. |

Stdin is rejected because `md fix` writes and stdin has no path to write back to.

## Options

| Option                  | Default             | Description                              |
| ----------------------- | ------------------- | ---------------------------------------- |
| `--format <fmt>`        | Project default     | `llm`, `human`, or `json`.               |
| `--paths <style>`       | Project default     | `absolute` or `relative`.                |
| `--rule <name>`         | Every default fixer | Fixer to run. Repeatable.                |
| `--check`               | **Default**         | Report pending fixes without writing.    |
| `--dry-run`             | Off                 | Print the full plan without writing.     |
| `--write`               | Off                 | Apply the plan as one transaction.       |
| `--include <glob>`      | `files.include`     | Repeatable include glob.                 |
| `--exclude <glob>`      | `files.exclude`     | Repeatable exclude glob.                 |
| `--changed-since <rev>` | None                | Only files changed since a Git revision. |
| `-h`, `--help`          | —                   | Show help.                               |

`--check`, `--dry-run`, and `--write` are mutually exclusive. **The mode cannot be set from
project configuration**: `check`, `write`, and `dryRun` are deliberately absent from
`commands.fix`, so a checked-in `.cairn.yml` can never turn `md fix` into a writer.
Setting one is a configuration error.

## Fixers

| Rule             | Default | What it does                                                               |
| ---------------- | ------- | -------------------------------------------------------------------------- |
| `markdownlint`   | Yes     | Applies markdownlint's own fix for a fixed allowlist of unambiguous rules. |
| `relative-links` | Yes     | Normalizes a local link's path without changing what it points at.         |
| `toc`            | Yes     | Replaces the content between an existing `cairn:toc` marker pair.          |
| `snippets`       | **No**  | Refreshes a fenced block from the source region its info string declares.  |

A rule that is not a default runs only when named with `--rule`. `snippets` is the only one
today, because it is the only fixer whose edits are decided by files other than the Markdown
being fixed — a broadly-run `md fix --write` must not silently acquire the reach to read
arbitrary source files.

### `snippets`

Refreshes fences carrying a `cairn:snippet=<path>[#<region>]` attribute, and nothing else.
The syntax, the comparison rule, and the cases where a fence cannot accept its refreshed body
are documented on the [`md check-snippets`](md-check-snippets.md) page, which shares this
engine and reports the same conditions with its own exit rule.

Drift with a usable write plan becomes an edit. Everything else — a missing source file, a
missing region, a malformed attribute, a fence the body would break out of — is reported under
`unfixable`, so one bad link cannot kill a whole-tree run. Note that `unfixable` entries never
change `md fix`'s exit code, while `md check-snippets` fails on exactly those conditions.

### `toc`

Only touches documents that already carry a marker pair, or the documents matched by
`toc.files` when that is configured. **Inserting markers is an authoring decision, not a fix**,
so a document without them is left alone. A malformed marker pair is reported under
`unfixable` rather than thrown, so one bad document cannot kill a whole-tree run.

A malformed marker pair is reported under `unfixable` rather than thrown, so one bad document
cannot kill a whole-tree run.

Markers inside a **fenced code block** do not count as a marker pair, so a document that only
_documents_ the syntax is left alone rather than having a table of contents written into its
code sample. That exclusion lives in marker synchronization itself, so `md toc` and `md audit`
apply it too.

### `relative-links`

Deliberately narrow, so it is idempotent and causes no churn on a first run:

- The path is recomputed in the original's own addressing mode, normalizing `a/../b.md`,
  `.//b.md`, and `docs/./api.md`.
- A `./` prefix is **preserved, never added and never removed.** Which spelling is canonical is
  a style opinion, and flipping it would rewrite every link in a repository.
- Percent-encoding is **preserved, never introduced.** Encoding a link that already renders is
  churn, and `encodeURI` double-encodes a literal `%`.
- Backslash separators become `/`, which is a genuine correctness fix.
- Query strings, fragments, and escaped parentheses are preserved.

Two properties hold over every rewrite, and are asserted in the test suite: the new target
resolves to the **same absolute path** as the old one, and a second pass produces no further
edits. A broken link therefore stays broken, just canonically spelled — this fixer never
changes which file a link points at.

External, anchor-only, and scheme-bearing targets such as `mailto:` are skipped, as is any
link whose source text does not delimit a plain target.

### `markdownlint`

Runs only these rules, all whitespace- or punctuation-local and rewriting at most one span per
line:

`MD009` `MD010` `MD012` `MD018` `MD019` `MD020` `MD021` `MD023` `MD027` `MD030` `MD037`
`MD038` `MD039` `MD047`

Excluded despite offering a fix: `MD004`, `MD029`, `MD035`, `MD048`, `MD049`, `MD050`
(config-dependent style _choices_ that rewrite prose markers); `MD044` (substring replacement
inside prose); `MD005`, `MD007` (list indentation, where fixes interact across lines); and
`MD034` (turning a bare URL into an autolink changes how it renders).

Each allowlisted rule's derived range is cross-checked in the test suite against markdownlint's
own `applyFix`. A rule that ever disagrees comes off the allowlist rather than getting a
special case.

## The transaction

`--write` applies every file's edits together, and **refuses to write at all** when:

- any two edits overlap, or two insertions land on the same offset (no overlap, but an
  undefined order);
- any input changed after the plan was built;
- any target resolves outside the containment root, including through a symlinked directory.

Conflicts are reported with **both** rule names so it is clear which `--rule` to leave out.

The containment root is the configured workspace root when a `.cairn.yml` exists.
Without one it is the directory containing the selected inputs, so
`cairn md fix /elsewhere/docs` works from anywhere while a fixer still cannot emit an
edit reaching beyond what was selected.

Before writing, every file is rechecked and every `expected` re-verified. A stale input
therefore costs zero writes. Each file is then staged beside itself and committed by rename,
which is atomic per file.

**The multi-file commit is not atomic.** A failure part way through restores already-committed
files by rewriting their original bytes, which is best-effort and not crash-safe. This is the
same guarantee `md rename-file` gives.

## Offsets

`start` and `end` are **UTF-16 code-unit indices** into the decoded file — what
`content.slice(start, end)` uses — not byte offsets. They differ for any document containing
astral-plane characters such as emoji.

`expected` is therefore mandatory rather than advisory. A consumer applying an edit itself
should verify it first; internally a mismatch aborts the transaction rather than corrupting
the document.

## Exit codes

| Mode        | Condition                                    | Code | Stream |
| ----------- | -------------------------------------------- | ---- | ------ |
| `--check`   | Pending edits, or a conflict                 | `2`  | stderr |
| `--check`   | Clean                                        | `0`  | stdout |
| `--dry-run` | No conflicts, whether or not there is a plan | `0`  | stdout |
| `--dry-run` | A conflict                                   | `2`  | stderr |
| `--write`   | Applied, or nothing to do                    | `0`  | stdout |
| `--write`   | A conflict, so nothing was written           | `2`  | stderr |
| any         | Bad invocation, unknown rule, or I/O error   | `1`  | stderr |

`--dry-run` exits `0` on a non-empty plan because seeing the plan is what was asked for —
matching `md toc --dry-run`, which also exits `0` on a stale table. A **conflict** still exits
`2` in dry-run, because it means `--write` could not succeed and
`md fix --dry-run && md fix --write` must not be a lie.

Entries under `unfixable` never change the exit code. They name findings with no automatic
fix available, and failing on them would permanently redden CI with nothing to do about it.

## Not in scope

- **No guessing at broken links.** A fixer never changes which file a link points at.
- **No file creation, deletion, or renaming.** Content edits inside existing files only.
- **No TOC marker insertion.**
- **No `jsonl` or `sarif`.** The payload is a plan, not a finding list.
