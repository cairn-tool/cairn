---
name: cairn-qa-qa-run-record
description: The standard for a cairn qa run record — the `_report.md` sections and the `_results.md` Outcome block, the fixed attestations, the PASS/FAIL/UNVERIFIED verdict vocabulary, the artifact prefixes, and the exact shapes `cairn qa summary` parses out of them. Use when writing or judging a `_report.md` or `_results.md`, when embedding the record skeletons in a plan, when a case shows `??` or a wrong count in summary.md, or when deciding whether a finished run actually proves what it claims.
---

# The cairn qa run record

Read the two reference documents in full before writing or judging a record — they are the actual
specification, not this file.

- [`reference/run-record.md`](reference/run-record.md) — the two documents, section by section, plus
  the attestations, the verdict vocabulary and the artifact rules.
- [`reference/tracker-contract.md`](reference/tracker-contract.md) — every pattern
  `cairn qa summary` matches, and what each miss produces. Read it before changing any heading.

The plan that produced the record — and the §11 that embedded these skeletons in it — belongs to the
**qa-case-plan** skill in this same bundle. The CLI is **qa-runner**.

## Why the shapes are exact

`summary.md` is regenerated from the files on disk, not from anything the run reported. So the
headings are an interface. A `## 4. Verdict` section whose body says `Verdict: PASS` instead of
`**PASS**` produces a case tallied as `??` — not a warning, not a slightly worse row, but a verdict
the tracker cannot read at all.

That is the whole reason this standard is picky about things that look cosmetic. The list of what is
actually parsed is short, and it is in `tracker-contract.md`.

## The rule that outranks the shapes

**Never edit an expectation to match an observation.** The Expected values were quoted from a source
document by the plan's author; the record's job is to say what was observed and let the two
disagree in public. A record where every row agrees because the runner adjusted the expectations is
worse than a failing one, because nothing about it looks wrong.

**UNVERIFIED is a real, acceptable outcome.** A case blocked by a busy port, a missing fixture, or a
surface that does not expose what the source document describes is UNVERIFIED with the reason. Never
convert a blocked case into a PASS by narrowing what it claims.

## Scope: the shape applies everywhere, the destination does not

Apply every section of the standard **except where the record lives**. The `<runs-dir>/tc-<N>/` path
and the temp-folder promotion belong to the harness, not to the documents.

Everywhere else — a record drafted in conversation, a results table pasted into a ticket, a file the
user named — the section skeleton, the attestations, the verdict vocabulary and the citation rules
still apply, and the path rule does not. **Never invent an output path, and never create a file that
was not asked for**, to satisfy this standard.

One caveat with teeth: **never create a `tc-<N>/` folder by hand.** Its absence is what marks the
case as pending, and the harness creates it by promoting a successful run. Writing one removes the
case from the queue while leaving nothing that ran.

## What gets gotten wrong

1. **A verdict the tracker cannot read.** §4's body must contain a line _starting_ with `**PASS**`,
   `**FAIL**` or `**UNVERIFIED**`. `Verdict: **PASS**`, `**Passed**`, and a verdict stated only in
   the `## Outcome` block all tally as `??`.
2. **An unticked "n/a" attestation.** `- [ ]` counts as outstanding **anywhere in the file**, so a
   conditional item must be _ticked_ with its reason appended when it does not apply. An unticked
   n/a reads as an unmet obligation.
3. **Artifacts cited outside §1.** Only §1's body is scanned for citations. An artifact named only
   in §5, or only in `_report.md` §7, does not count as cited.
4. **A row verdict in the wrong cell.** Only the **last** cell of a `| N | … |` row is read. A ✅ in
   the Observed column with an empty Verdict column is no verdict.
5. **A `#` that is not a bare integer.** Rows match `^\| \d+ \|`. `1.` or `(1)` makes the row
   invisible and the tally wrong.
6. **`## Outcome` left with its placeholders.** The Verdict cell is read as the first run of capitals
   after the pipe, so `<PASS / FAIL / UNVERIFIED>` matches `PASS` and is compared against §4 as if it
   were the verdict.
7. **Verbatim output summarised.** The evidence section is where a sceptical reader goes, and a
   summary makes the record unfalsifiable. Trim by quoting a region and saying so; never paraphrase.

## Reading a queue's results

```bash
cairn qa summary --runs-dir <dir>     # rebuild summary.md from the records on disk
```

It reads only the files: a row cannot claim a verdict its `_results.md` does not carry. A case
tallied `??` is a record the tracker could not parse, not a case that failed — start with
`tracker-contract.md`, not with the run.
