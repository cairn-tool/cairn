---
name: markdown-refactor
description: Modify Markdown files with the cairn md toolset — apply deterministic fixes, sync a table of contents, rename a heading or a file with every reference updated, and refresh source-linked snippets. Use when changing Markdown content or moving documents, not when only reading them.
---

# Changing Markdown with cairn

**These five commands write to files.** Everything else in the `md` toolset only reads.

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`${PLUGIN_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## Preview first, always

Every writing command defaults to a non-writing mode, and every one takes a preview flag. Use it,
show the user what will change, and only then write.

| Command             | Preview                          | Write     |
| ------------------- | -------------------------------- | --------- |
| `md fix`            | `--check` (default), `--dry-run` | `--write` |
| `md toc`            | `--check`, `--dry-run`           | `--write` |
| `md check-snippets` | `--check` (default), `--dry-run` | `--write` |
| `md rename-heading` | `--dry-run`                      | (default) |
| `md rename-file`    | `--dry-run`                      | (default) |

Note the asymmetry: the two `rename-*` commands **write by default** and need `--dry-run` to hold
back. The other three do the opposite. Getting this backwards is the easiest mistake here.

For `fix`, `toc`, and `check-snippets`, `--check`, `--dry-run`, and `--write` are mutually
exclusive.

## `md fix` — deterministic fixes

```bash
cairn md fix docs                          # what is pending? (--check is the default)
cairn md fix docs --dry-run                # the full plan, file by file
cairn md fix docs --write                  # apply it
cairn md fix docs --rule <name>            # one fixer only (repeatable)
cairn md fix docs --changed-since origin/main
```

`--write` applies every file's edits as **one transaction**, and refuses entirely if any input
changed after planning, any two edits overlap, or any target resolves outside the workspace root.
A partial application is not a state it can end in.

Without `--rule`, it runs the default fixer set. That set deliberately **excludes the `snippets`
fixer**, because that one's edits are decided by files other than the Markdown being fixed — a
broad `md fix --write` must not quietly acquire that reach. Run `md check-snippets --write`
explicitly when you want it.

## `md toc` — synchronize a table of contents

```bash
cairn md toc README.md --check    # is the marker block current?
cairn md toc README.md --write    # update it
```

Only content **between the document's TOC markers** is touched. A document with no markers is not
modified; `md toc <file>` with no mode just prints a TOC for you to paste.

A document carrying the pre-rename `claude-cli:toc` markers keeps them. That is not drift, and
migrating them would report every legacy document as stale for a change that alters no output.

## `md rename-heading` — rename and fix the anchors

```bash
cairn md rename-heading doc.md "Old Title" "New Title" --dry-run
cairn md rename-heading doc.md "Old Title" "New Title"
cairn md rename-heading doc.md "Old" "New" --directory docs   # update other files too
```

Renaming a heading changes its slug, which breaks every `#anchor` link pointing at it. This
updates them. Without `--directory` it only fixes anchors **within the same file** — pass it
whenever other documents might link to that heading.

Check first with `cairn md refs-to doc.md docs` to see who links to the document at all.

## `md rename-file` — move a document and fix the links

```bash
cairn md rename-file docs/old.md docs/new.md --dry-run
cairn md rename-file docs/old.md docs/new.md
```

Moves the file and rewrites every Markdown reference to it. Also works for referenced assets, not
just documents. **The destination's parent directory must already exist.**

Use this instead of `git mv` or `mv` for anything referenced by Markdown — a plain move leaves
every link broken and silently so.

## `md check-snippets --write` — refresh linked code blocks

```bash
cairn md check-snippets docs             # report drift
cairn md check-snippets docs --dry-run   # the plan
cairn md check-snippets docs --write     # refresh
```

Only a fence whose info string carries `cairn:snippet=<path>[#<region>]` is considered. Nothing is
executed; the source file is only read. `--write` copies file contents into tracked documents, so
read the plan before running it.

## After writing

Re-run `cairn md lint` on what you changed. A rename that updates references can still leave a
document that does not lint, and confirming is cheap.

## More

Every fixer's name and behavior, and the full flag tables, are in
[`reference/refactor.md`](reference/refactor.md).
