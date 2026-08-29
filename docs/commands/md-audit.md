# `md audit`

## Synopsis

```text
cairn md audit [directory] [options]
```

Runs a bounded workspace audit combining enabled lint, external URL, frontmatter, graph,
generated-TOC, and source-linked snippet checks. Graph and snippet checking are enabled by
default. Frontmatter and TOC checks run when configured; external URL requests remain disabled
unless enabled.

## Arguments

| Argument    | Required | Description                                                    |
| ----------- | -------- | -------------------------------------------------------------- |
| `directory` | No       | Directory to audit. Defaults to the configured workspace root. |

## Options

| Option                               | Default                       | Description                                         |
| ------------------------------------ | ----------------------------- | --------------------------------------------------- |
| `--format <fmt>`                     | Project default               | `llm`, `human`, `json`, `jsonl`, or `sarif`.        |
| `--paths <style>`                    | Project default               | `absolute` or `relative`.                           |
| `--stdin-name <path>`                | None                          | Shared option; audits normally use directory input. |
| `--summary` / `--no-summary`         | `false`                       | Select summarized or detailed findings.             |
| `--external` / `--no-external`       | `checks.external` (`false`)   | Toggle external URL checking.                       |
| `--frontmatter` / `--no-frontmatter` | `checks.frontmatter` (`true`) | Toggle configured frontmatter checks.               |
| `--graph` / `--no-graph`             | `checks.graph` (`true`)       | Toggle graph checks.                                |
| `--toc` / `--no-toc`                 | `checks.toc` (`true`)         | Toggle TOC synchronization checks for `toc.files`.  |
| `--snippets` / `--no-snippets`       | `checks.snippets` (`true`)    | Toggle source-linked snippet checks.                |
| `-s`, `--style` / `--no-style`       | `checks.markdownlint`         | Toggle markdownlint.                                |
| `--mermaid` / `--no-mermaid`         | `checks.mermaid`              | Toggle Mermaid checks.                              |
| `--katex` / `--no-katex`             | `checks.katex`                | Toggle KaTeX checks.                                |
| `--references` / `--no-references`   | `checks.references`           | Toggle reference checks.                            |
| `--concurrency <n>`                  | CPU count, clamped to 1–8     | Positive maximum concurrent checks.                 |
| `--timeout <ms>`                     | `5000`                        | Positive external URL timeout.                      |
| `--retry <n>`                        | `1`                           | Non-negative external URL retry count.              |
| `--changed-since <revision>`         | None                          | Restrict selected Markdown inputs to Git changes.   |
| `--entry <file>`                     | `files.entryPoints`           | Repeatable graph reachability entry point.          |
| `--baseline <file>`                  | None                          | Suppress findings a baseline already records.       |
| `--write-baseline <file>`            | None                          | Record the current findings and exit `0`.           |
| `--include <glob>`                   | `files.include`               | Repeatable include glob.                            |
| `--exclude <glob>`                   | `files.exclude`               | Repeatable exclude glob.                            |
| `-h`, `--help`                       | —                             | Show help.                                          |

## Snippet checks

Reports fenced code blocks that have drifted from the source region their info string declares.
The syntax and the comparison rule are documented on the
[`md check-snippets`](md-check-snippets.md) page; audit only reports, and never refreshes.

| Checker           | Condition                                                              |
| ----------------- | ---------------------------------------------------------------------- |
| `snippets/drift`  | The documented body no longer matches the source.                      |
| `snippets/source` | The source file is missing, outside the workspace root, or unreadable. |
| `snippets/region` | The named region is missing, duplicated, or malformed.                 |
| `snippets/meta`   | The fence attribute itself is malformed.                               |

On by default, and effectively free: a document with no linked fence costs one substring test
per code block and can never produce a finding. Messages carry the target as the author wrote
it, with no line number and no absolute path, so `--baseline` entries stay portable.

## Baselines

A baseline records findings that are already known, so an audit fails only on **new** ones.
That makes it possible to adopt a check on a large existing workspace without either a
flag-day cleanup or a permanently red build.

```bash
cairn md audit docs --write-baseline .audit-baseline.json   # record, exit 0
cairn md audit docs --baseline .audit-baseline.json         # exit 2 on regressions only
```

Recording is deliberately a separate act from checking, and the two flags cannot be combined:
writing the file a run is simultaneously being judged against has no meaning. Because the
baseline is a small sorted JSON document committed to the repository, every change to it shows
up as a reviewable diff rather than as an invisible suppression.

### What identifies a finding

An entry is keyed on **checker, workspace-relative path, and message — not line number**.

| Change                                        | Effect                   |
| --------------------------------------------- | ------------------------ |
| Prose inserted above a known finding          | Still suppressed         |
| A _second_ identical finding in the same file | Reported as a regression |
| The same finding in a different file          | Reported                 |
| A baselined finding that no longer occurs     | Reported as `stale`      |

Line numbers are excluded on purpose: a finding does not become a different finding because
something unrelated moved above it, and a line-sensitive key would force a baseline refresh on
commits that fixed nothing. The cost is that two identical findings in one file collapse to one
entry, so each entry carries a `count` and the second occurrence is still reported.

Paths are stored workspace-relative with `/` separators, independent of `--paths`, so the file
keeps working after a checkout into a different directory — the normal case in CI.

### Stale entries and foreign documents

A `stale` entry means the finding it recorded no longer occurs, which is usually a fix. It is
reported in the payload and in the text output but **never** changes the exit code; prune it
by re-running `--write-baseline`.

A document that is not a `cairn-md-audit-baseline` becomes a `baseline` **finding** rather
than a silent no-op or a crash, because trusting another tool's schema would produce
suppression nobody can verify. A missing or unparseable file exits `1`.

### Output

```jsonc
"baseline": { "path": ".audit-baseline.json", "suppressed": 4,
              "stale": [{ "checker": "toc", "file": "docs/a.md", "message": "…", "count": 1 }] }
```

The block is present only when `--baseline` was given. Suppressed findings are removed from
`findings`, from `totals`, and from the `jsonl` and `sarif` forms, so every count agrees with
the exit code. `--baseline` is settable from project configuration; `--write-baseline` is not,
on the same rule as `md fix` — a checked-in config must never turn a checker into a writer.

## Exit codes

JSON output is one object containing enabled/skipped checks, totals, normalized findings, and
graph metrics. Exit `0` means the audit passed or a baseline was written, `1` is an operational
error, and `2` means actionable findings were found.
