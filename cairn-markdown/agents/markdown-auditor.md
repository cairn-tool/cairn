---
name: markdown-auditor
description: Audits a Markdown documentation tree with cairn and reports prioritized findings. Use when a whole docs directory needs checking and the individual findings would otherwise flood the conversation.
model: inherit
---

# Markdown auditor

You audit a Markdown tree with the `cairn` CLI and return a prioritized report. You **do not
edit files** — you have no write access, and that is deliberate: the value here is a judgment
about what matters, not a pile of automated edits.

## Procedure

1. Confirm `cairn` is available: `command -v cairn`. If it is missing, say so and stop.
2. Get the shape of the problem before the detail:

   ```bash
   cairn md audit <dir> --summary
   ```

3. Pull the full findings as JSON so you can group them yourself:

   ```bash
   cairn md audit <dir> -fj
   ```

4. Where a count looks suspicious, drill in with a targeted query rather than re-running the
   audit — `cairn md query links --where links-to:<path>` will often show that twenty findings
   share one cause.

Leave `--external` off unless URL reachability is what you were asked about: it makes real
network requests, is slow, and produces false failures on sites that block automated traffic.

## What to report

Return prose, not a dump. The caller can re-run the command themselves if they want raw output.

- **Lead with causes, not counts.** "`docs/api.md` was moved and eleven pages still point at the
  old path" is worth more than "11 reference errors".
- **Rank by whether a reader is harmed.** A broken internal link beats a style violation.
- **Say what you would not change.** Orphaned templates and unreferenced changelogs are normal;
  flagging them as defects wastes the caller's time.
- **Give the exact command** that fixes each cluster, and say whether it writes.

Finish with a one-line verdict: is this tree healthy, and what is the single highest-value fix?

# Validating Markdown with cairn

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something. **Exit 2 is the answer, not a
failure** — do not retry it.

Longer conventions, config discovery, and install notes:
[`./assets/cli-basics.md`](../../assets/cli-basics.md).

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

# Querying a Markdown workspace with cairn

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`./assets/cli-basics.md`](../../assets/cli-basics.md).

## When this beats grep

`grep` searches text. `md query` searches **parsed structure**, so it can answer things a regex
cannot: which links actually resolve, which headings are duplicated, which tasks are pending and
who owns them. It also will not match inside a fenced code block that merely _shows_ a link.

Reach for it whenever the question is about many documents at once and phrased in Markdown's own
terms — headings, links, tasks, frontmatter, code blocks.

## Two modes, one command

**Shortcut kinds** answer a fixed question:

```bash
cairn md query links-to docs --target docs/api.md   # who links here
cairn md query duplicates docs --field title        # colliding titles
cairn md query missing-h1 docs                      # pages with no H1
cairn md query unused-assets docs                   # images nothing references
cairn md query frontmatter-keys docs                # which keys are in use
cairn md query tasks docs --status pending
cairn md query code-blocks docs --lang bash
```

**Predicate mode** turns the same argument into an entity to filter. It activates as soon as you
pass `--where`, `--select`, or `--group-by`:

```bash
cairn md query documents --where has:h1 --select file,title
cairn md query links --where links-to:docs/api.md --select file,line
cairn md query tasks --where status=pending --group-by frontmatter.owner
cairn md query headings --where depth=1 --select file,text
```

Entities are `documents`, `headings`, `links`, `tasks`, `code-blocks`, and `frontmatter`.

Predicates are `<field><op><value>` with `=`, `!=`, `~`, `>`, `>=`, `<`, `<=`, plus `has:<field>`
and `links-to:<path>`. A leading `!` negates. Repeating `--where` ANDs them. `frontmatter.<key>`
is a field on every entity.

**An unknown field, predicate, or operator exits 1 rather than matching nothing.** That is
deliberate — a typo is an error, never a quiet empty result. If you get exit 1, re-read the field
name; do not conclude there were no matches.

Query matches themselves are informational and exit `0`.

## Building a context pack

`md context` walks the reference graph from seed documents and assembles what they connect to —
for handing a coherent slice of a docs tree to someone, or to another agent.

```bash
cairn md context docs/architecture.md --depth 2
cairn md context docs/api.md --backlinks --depth 1        # also what points here
cairn md context docs --section "Configuration" --children
cairn md context docs/guide.md --depth 3 --budget 100000  # cap the size
```

`--depth` is graph hops (0-6). `--backlinks` follows references backwards as well as forwards.
`--budget <bytes>` caps total content, which matters because depth 3 on a well-linked tree can
pull in most of it. Units come back ordered by graph distance, so a truncated pack still leads
with the most relevant material.

## The reference graph

```bash
cairn md graph docs                                # a report
cairn md graph docs --output mermaid               # a diagram
cairn md graph docs --entry README.md              # reachability from entry points
cairn md graph docs --focus docs/api.md --depth 2  # one neighborhood
```

`--output` is `report` (default), `mermaid`, or `dot`. Use `--focus` on any tree big enough that
a whole-graph diagram would be unreadable.

## The index

`md query`, `md context`, and `md graph` read a persistent workspace index.

```bash
cairn md index status docs   # is it current?
cairn md index build docs    # build or refresh it
cairn md index clear docs    # discard it
```

You rarely need these — the index maintains itself. Reach for `build` if a query returns results
that look stale, and `clear` if they look wrong.

## More

The full predicate grammar with worked examples, every shortcut kind's options, and the graph and
context flags are in [`reference/query-grammar.md`](reference/query-grammar.md).
