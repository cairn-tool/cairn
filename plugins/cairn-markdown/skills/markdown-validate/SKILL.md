---
name: markdown-validate
description: Lint and validate Markdown with the cairn md toolset. Use when checking a Markdown file or docs tree for broken internal links, invalid Mermaid diagrams, invalid KaTeX math, style violations, unreachable URLs, or frontmatter that does not match its schema.
---

# Validating Markdown with cairn

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something. **Exit 2 is the answer, not a
failure** — do not retry it.

Longer conventions, config discovery, and install notes:
[`${BUNDLE_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## Pick the command by scope

| Scope                    | Command                                         |
| ------------------------ | ----------------------------------------------- |
| One or a few named files | `cairn md lint <files...>`                      |
| A whole directory        | `cairn md lint-dir <dir> --summary`             |
| Everything, one pass     | `cairn md audit <dir>`                          |
| Only what changed        | add `--changed-since <ref>` to any of the three |

Reach for `lint-dir` over looping `lint` per file: it runs concurrently and reports one summary.

## `md lint` and `md lint-dir`

Four checks, each independently toggleable with a `--x` / `--no-x` pair:

| Check        | Default | What it catches                                          |
| ------------ | ------- | -------------------------------------------------------- |
| `references` | on      | internal links and images whose target does not exist    |
| `mermaid`    | on      | Mermaid blocks that do not parse                         |
| `katex`      | on      | KaTeX expressions that do not parse                      |
| `style`      | **off** | markdownlint rules — pass `-s`/`--style` to include them |

Style is off by default because it is opinionated and noisy on documents nobody has linted
before. Turn it on deliberately, and mention that you did.

```bash
cairn md lint README.md docs/guide.md          # the three correctness checks
cairn md lint README.md --style                # add markdownlint
cairn md lint-dir docs --style --summary       # one line per file
cairn md lint-dir . --changed-since origin/main   # only what this branch touched
```

`--summary` on `lint-dir` gives a pass/fail line per file instead of every finding — use it first
on an unfamiliar tree, then drill into the failures.

## `md audit` runs everything at once

`audit` composes the lint checks with URL reachability, frontmatter schemas, graph checks, TOC
drift, and source-linked snippets. It is the right command for a pre-commit or CI gate, and the
wrong one for a quick look at a single file.

```bash
cairn md audit docs --summary                  # per-check and per-file counts
cairn md audit docs --external                 # also verify external URLs (slow, networked)
cairn md audit docs --no-graph --no-toc        # narrow it
```

Every check is a `--x`/`--no-x` pair, so narrow rather than falling back to `lint`. `--external`
makes real network requests; leave it off unless reachability is the question.

`--summary` is a genuinely different payload here, not just a shorter one. Ask for what you need.

## Reading the output

Use `-fj` whenever you plan to filter:

```bash
cairn md lint-dir docs -fj | jq '.issues[] | select(.rule == "reference")'
cairn md lint-dir docs -fj | jq -r '.files[] | select(.issues > 0) | .path'
```

For CI that reports into a code-scanning UI, `--format sarif` is available on every diagnostic
command. `--format jsonl` streams one finding per line from `lint` and `lint-dir`.

## Working through findings

1. Run the broadest command that fits the scope, with `--summary`.
2. Fix the highest-count file first — one bad link target often explains many findings.
3. Re-run on **just that file** with `md lint` rather than repeating the whole sweep.
4. Finish with the original broad command to confirm.

Do not "fix" a style finding by adding a markdownlint disable comment unless the user asks. If a
rule is wrong for the project, the fix is `.markdownlintrc`, not a comment per occurrence.

## More commands

URL checking, frontmatter schemas, reference and link listing, orphan detection, snippet
verification, and structural diffs are in
[`reference/validation.md`](reference/validation.md).
