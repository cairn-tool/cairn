---
name: markdown-query
description: Query a whole Markdown workspace with the cairn md toolset instead of grepping. Use when a question spans many documents — find every page linking to a file, every pending task by owner, duplicate titles, unused assets, pages missing an H1 — or when assembling a context pack from the reference graph.
---

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
