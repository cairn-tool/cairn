# Refactor commands in full

The five commands that write. See [`cli-basics.md`](../../../assets/cli-basics.md) for formats,
exit codes, and config discovery.

## Mode flags at a glance

| Command             | Default mode | Preview                | Write     |
| ------------------- | ------------ | ---------------------- | --------- |
| `md fix`            | `--check`    | `--check`, `--dry-run` | `--write` |
| `md toc`            | print only   | `--check`, `--dry-run` | `--write` |
| `md check-snippets` | `--check`    | `--check`, `--dry-run` | `--write` |
| `md rename-heading` | **writes**   | `--dry-run`            | default   |
| `md rename-file`    | **writes**   | `--dry-run`            | default   |

## `md fix <inputs...>`

| Option                       | Meaning                                        |
| ---------------------------- | ---------------------------------------------- |
| `--rule <name>`              | Run one fixer (repeatable); default is the set |
| `--check`                    | Report pending fixes without writing (default) |
| `--dry-run`                  | Print the full plan without writing            |
| `--write`                    | Apply the plan as one transaction              |
| `--include` / `--exclude`    | Globs                                          |
| `--changed-since <revision>` | Only files changed since a Git revision        |

### The fixers

| Name             | Fixes                                                 | In the default set |
| ---------------- | ----------------------------------------------------- | ------------------ |
| `markdownlint`   | markdownlint rules with an unambiguous repair         | yes                |
| `relative-links` | Local link paths, without changing what they point at | yes                |
| `toc`            | The generated block between TOC markers               | yes                |
| `snippets`       | Fenced blocks declaring a source file and region      | **no**             |

`snippets` is excluded from the default set on purpose: it is the only fixer whose edits are
decided by files _other than_ the Markdown being fixed, and a broadly-run `md fix --write` must
not silently acquire that reach. Ask for it by name, or use `md check-snippets --write`.

An unknown `--rule` name is a usage error, not a silent no-op — so
`md fix --rule typo --check` can never exit 0 and look like a pass.

**The mode cannot be set from project configuration.** A checked-in `.cairn.yml` can never turn
`md fix` into a writer.

### Transaction guarantees on `--write`

Every file's edits apply as one transaction. It refuses to write **at all** if:

- any input changed after planning,
- any two edits overlap, or
- any target resolves outside the workspace root.

Exit `2` means `--check` found pending fixes, or any mode found a conflict.

## `md toc <file>`

| Option            | Meaning                                    |
| ----------------- | ------------------------------------------ |
| `--max-depth <n>` | Deepest heading level to include (1-6)     |
| `--min-depth <n>` | Shallowest heading level to include (1-6)  |
| `--ordered`       | Numbered list instead of bullets           |
| `--check`         | Report whether the marker block is current |
| `--dry-run`       | Print the proposed block without writing   |
| `--write`         | Update the content between the markers     |

With no mode flag it prints a TOC and writes nothing.

Markers are `<!-- cairn:toc:start -->` / `<!-- cairn:toc:end -->`. The pre-rename
`claude-cli:toc` spelling is still read, and a document carrying it **keeps** it — migrating
markers would report every legacy document as stale for a change that alters no table of
contents. A _mixed_ pair (one spelling opening, the other closing) is malformed.

## `md rename-heading <file> <old> <new>`

| Option              | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `--directory <dir>` | Also update references in other files under this directory |
| `--dry-run`         | Show what would change without modifying anything          |
| `--no-dry-run`      | Apply changes (the default)                                |

The old heading matches case-insensitively. Without `--directory`, only anchors inside the same
file are updated — cross-document `#anchor` links elsewhere will break silently.

Exit `1` if the heading is not found, or if the new slug already exists in that document.

## `md rename-file <source> <destination>`

Moves a Markdown document or a referenced asset, rewriting every Markdown reference to it.

| Option         | Meaning                              |
| -------------- | ------------------------------------ |
| `--dry-run`    | Show changes without modifying files |
| `--no-dry-run` | Apply changes (the default)          |

The destination's parent directory must already exist.

## `md check-snippets [inputs...]`

Compares fenced code blocks against the source regions they declare. Only a fence whose info
string carries `cairn:snippet=<path>[#<region>]` is considered — the syntax lives in the info
string precisely so a fenced example _documenting_ the syntax is unreachable rather than merely
guarded.

A snippet is never executed; the source file is only read.

| Option         | Meaning                                  |
| -------------- | ---------------------------------------- |
| `--check`      | Report drift without writing (default)   |
| `--dry-run`    | Print the full plan without writing      |
| `--write`      | Refresh linked blocks as one transaction |
| `--include-ok` | Report up-to-date snippets too           |

Reads and writes are bounded by **different** roots: sources may be read anywhere under the
workspace root (a document under `docs/` legitimately points at `../src`), while writes are
confined to the inputs you named. That is why `md check-snippets docs --write` will not write
outside `docs/`.

The pre-rename `claude-cli:snippet=` attribute is still read and is never rewritten.
