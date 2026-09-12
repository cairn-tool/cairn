# Validation commands in full

Everything `markdown-validate` mentions, plus the commands it does not lead with. See
[`cli-basics.md`](../../../assets/cli-basics.md) for formats, exit codes, and config discovery.

## `md check-urls <inputs...>`

Verifies external URLs are reachable. Makes real network requests, so it is slow and can fail for
reasons that have nothing to do with the document.

| Option                    | Meaning                                             |
| ------------------------- | --------------------------------------------------- |
| `--timeout <ms>`          | Per-URL request timeout                             |
| `--concurrency <n>`       | Maximum simultaneous requests                       |
| `--retry <n>`             | Retries before reporting a URL as broken            |
| `--include-ok`            | Report reachable URLs too; failures only by default |
| `--ignore <glob>`         | Skip matching URLs (repeatable)                     |
| `--ignore-domain <host>`  | Skip a domain and its subdomains (repeatable)       |
| `--allowed-status <code>` | Treat an HTTP status as success (repeatable)        |
| `--cache`                 | Reuse cached results instead of re-requesting       |

Sites that block automated requests produce false failures. `--allowed-status 403` and
`--ignore-domain` exist for exactly that; prefer them to deleting a working link. Use `--cache`
when iterating so you are not re-requesting the same hundred URLs.

## `md validate-frontmatter <paths...>`

Checks YAML frontmatter against a JSON or YAML Schema and the workspace's own configured rules.

```bash
cairn md validate-frontmatter docs --schema schemas/doc.json
```

Without `--schema` it applies only what `.cairn.yml` configures. Exit `1` means the schema itself
is wrong; exit `2` means a document is.

## `md refs <file>` and `md links <file>`

Both list references out of one document. `refs` is reference-centric and reports whether each
target resolves; `links` is presentation-centric and groups by type with surrounding context.

```bash
cairn md refs doc.md --external --anchors --images   # widen from internal-only
cairn md links doc.md --broken-only                  # just what is broken
cairn md links doc.md --type internal
```

Both default to internal, non-anchor, non-image references. If a link you expect is missing from
the output, you probably need to widen the flags rather than conclude it is absent.

## `md refs-to <file> [directory]`

The inverse: which documents point **at** this file. Run it before renaming or deleting anything
to see the blast radius. `md rename-file` updates those references for you — see the
`markdown-refactor` skill.

## `md orphans [directory]`

Markdown files nothing links to.

```bash
cairn md orphans docs --entry README.md --entry docs/index.md
```

Name every genuine entry point with `--entry`, or they report as orphans — a top-level README is
reachable by convention, not by a link. `--ignore <glob>` skips paths wholesale.

An orphan is a question, not a defect. Templates, changelogs, and generated pages are legitimately
unreferenced.

## `md check-snippets [inputs...]`

Compares fenced code blocks against the source regions they declare, so an example in the docs
cannot silently drift from the code it quotes.

Only a fence whose info string carries `cairn:snippet=<path>[#<region>]` is considered. Nothing is
executed; the source file is only read.

```bash
cairn md check-snippets docs        # report drift (the default)
cairn md check-snippets docs --dry-run   # the full plan, still no writes
cairn md check-snippets docs --write     # refresh every linked block
```

`--check`, `--dry-run`, and `--write` are mutually exclusive. `--write` copies file contents into
tracked documents, so read the plan before running it.

## `md diff <a> <b>` / `md diff --since <rev> [dir]`

Summarizes what changed **structurally** — headings, sections, code blocks — rather than by line.
Useful for answering "what did this branch actually do to the docs?" without reading a text diff.

```bash
cairn md diff old.md new.md
cairn md diff --since origin/main docs --summary
```

Two paths and `--since` together is an error, as is neither.

> `--since` names the **base** of a comparison. `--changed-since`, on the lint commands, selects
> which files to check. They are different options that read similarly.

## Streaming and CI formats

`--format sarif` is available on the five diagnostic commands (`lint`, `lint-dir`, `audit`,
`check-urls`, `validate-frontmatter`) for code-scanning UIs. `--format jsonl` streams one finding
per line from `lint` and `lint-dir`, which is what to use on a tree too large to buffer.
