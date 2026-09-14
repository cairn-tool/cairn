# Plan Standards

The document inside `plan:`. It is read by an agent that has no other context: no conversation, no
skills, no memory of the QA plan it came from. Everything it needs to run the case correctly and
record it honestly is in this one string, or it does not have it.

That constraint shapes every rule below. A plan is not a summary of a test — it is the whole
briefing, written so that following it literally produces a correct record and deviating from it
produces a visible anomaly rather than a quiet one.

## 1. The frame

```markdown
# TC-<N> — <Title> — test case plan

You are running **one** test case: <what, on which surface, through which route>. Follow this plan
literally; every command is copy-pasteable and every expected value is already quoted for you.

Deliverables: `_report.md`, `_results.md`, and every artifact listed in §10, all inside
`<runs-dir>/tc-<N>/`.
```

The H1 uses em dashes (U+2014), and `<Title>` is exactly the case file's `name:`.

Between the orientation paragraph and the Deliverables line, a case with one dominant trap may carry
a `⚠️` callout naming it. Use it when a single misunderstanding would invalidate the whole run —
"placement is a DOM containment claim, not a visual one" — and not as a place to list every caution.
§12 is where the full list belongs.

The plan names the **final** folder `tc-<N>/` throughout, never the temp folder. The harness's own
prompt already instructs the agent about `tc-<N>-temp/`; a plan that repeats it produces an agent
reasoning about two destinations.

## 2. The fourteen sections

Every plan carries §0 through §13, in order, as `##` headings. The numbering is part of the contract:
§13's checklist cites §10, the record skeletons cite §9, and a runner told to "see §8" needs §8 to be
where §8 is. Only §4's title varies with the surface — "Command family and CLI reference", "Command
families and CLI reference", "Surface and tooling reference".

Nesting is flat. The only `###` headings in a plan are the two inside §11.

## 3. §0 — Rules that override everything else

Opens with the location paragraph, which establishes the one folder the run may write to:

> **Where this plan lives, and where your output goes.** This plan is `<runs-dir>/_plans/tc-<N>.md`,
> an input you never edit. Every deliverable belongs in `<runs-dir>/tc-<N>/`, which does **not**
> exist yet: create it before you write anything. Below, `tc-<N>/` always means that folder.

Then a numbered list. The **environment rules come first**, and they come from the repository under
test rather than from this standard — a `TC-HARNESS.md` profile at its root where one exists,
otherwise its existing plans and its contributor docs: what must never be built and why, the one
sanctioned way to launch the surface, any exclusive resource this case owns, and any tool that is the only acceptable way to
observe something. These are the rules that differ per repository and per surface, and inventing them
is how a plan tells an agent to do something the project forbids.

The concurrency sentence belongs to the launch rule, because it is the reason for it:

> Other agents are running other test cases against this same working tree at the same time. A build
> started by any one of them replaces the binary underneath every run in flight and invalidates their
> results. If a command appears to need a build, stop and record the case as UNVERIFIED with that
> reason — do not build.

Then four rules that close every plan, in this order, because they are what keeps a record honest
regardless of surface:

1. **Read-only outside this case's own folder.** Write only inside `tc-<N>/`. Never edit a step
   document, a script, a fixture, this plan, or any product source.
2. **Never change an expected value.** Every Expected in §9 is a quotation from the source document. If
   what you observe disagrees with it, that is a **finding** for `_results.md` §5 — not an
   expectation to adjust, and not a reason to re-read the document looking for a friendlier wording.
3. **UNVERIFIED is a real, acceptable outcome.** If something cannot be observed, say so with the
   reason. Never convert a blocked case into a PASS by narrowing what it claims.
4. **Do not edit an artifact after capturing it.** Trim by quoting a region in the record; leave the
   file whole.

A case that legitimately writes outside its folder — clearing a browser storage key to establish a
known start state — states the exception on the rule itself and says where it is undone.

**A tagged case explains its tag here.** Which resource it owns, for how long, how to check the
resource is free before starting, that finding it busy is UNVERIFIED rather than a reason to work
around it, and where in §7 it is released.

## 4. §1 — Case identity

Opens `Paste this straight into `_report.md` §1.`, then a two-column borderless table with exactly
these rows:

| Row                         | Content                                      |
| --------------------------- | -------------------------------------------- |
| **Case**                    | `TC-<N>, <title>`                            |
| **Priority**                | The icon and word from the QA index line     |
| **Tools**                   | The tooling axis values, joined with `+`     |
| **Verifies**                | The `AC-` references                         |
| **Source of truth**         | `qa-test-steps/NN-<suite>.md § TC-<N>`       |
| **⚠️ marked in the index?** | Yes or No, and when Yes, why it matters here |

Every value is read from the source documents. None is inferred.

## 5. §2 — What this case proves, and how a false pass would look

Two jobs. First, what the case establishes and why this route establishes it — the argument that the
observations in §9 actually bear on the claim.

Second, and required, a bolded paragraph **"What a false pass looks like here."** enumerating the
shapes a silent green could take: an assertion that passes because nothing was available to fail, a
guard credited with an outcome that a guard above it produced, an observation read from the wrong
panel, a report that exits `0` while being a stub.

**A plan that cannot say how it would falsely pass is not finished.** That paragraph is the single
most valuable thing in the document, because every other section is machinery for producing evidence
and this is the section that says what the evidence has to rule out.

## 6. §3 — Required reading

A three-column table, `| Path | Why you need it | What to take from it |`. It always cites:

- The **source document** — labelled the oracle, because every Expected in §9 is quoted from it.
- The **setup document** — the procedure this case is the equivalent of.
- The **record template** — whose skeletons §11 has pre-filled.
- Any **syntax or DSL reference** the case's assertions are written in.

Close with `Reference the documents; do not paste them into the record.` where the case is likely to
tempt a runner into quoting a whole file.

## 7. §4 — Command family and surface reference

The exact route: the command and its alias, or the URL and the control. Then the part that earns the
section: **what going wrong looks like**. Where a neighbouring command family, a wrong flag, or a
wrong route would produce output that looks plausible, name it and say how it differs — a wrong
family exiting `0` and writing a stub report is precisely the failure the report-shape check in §7
exists to catch.

Flag semantics and exit-code semantics belong here too, especially where an exit code is broader than
the case: a script-wide exit code across ten scenarios belonging to six cases means `0` does not mean
this case passed.

## 8. §5 — Build identity

The command that captures what is actually under test — commit, branch, working-tree state — and the
sentence that must be written into `_report.md` §2. A case run against uncommitted work says so;
"working tree at `<sha>` plus uncommitted modifications" is a legitimate and useful answer, and
pretending the commit alone describes the build is not.

## 9. §6 — Inputs

Either the command that extracts the input, or the fixture verbatim. **Extract by heading, never by
line number** — a line range silently reads the wrong thing the moment the source document grows.

Then a self-check table, `| Check | Expected |`, with the counts that prove the extraction was
faithful: block counts, byte counts, the number of records. This is what catches a truncated input
before it becomes a wrong result.

## 10. §7 — Procedure

Numbered steps, written as fenced blocks whose step numbers match the `NN-` prefixes of the artifacts
they produce, so `# Step 3` writes `03-*.txt`. Between the blocks, bolded **"What to look for"**
paragraphs that say which §9 row each observation feeds.

Every command is copy-pasteable as written. A step that requires the runner to substitute a value
names where the value comes from.

A case holding an exclusive resource releases it in the last step, whatever the verdict.

## 11. §8 — Locating the result

How to be certain an observation came from the thing the case is about: which panel, which section,
which DOM node, which row. Where several candidates look alike, give a disambiguation that does not
depend on position alone — a name corroborated by an ordinal and a fingerprint.

This section exists because "I read the number off the screen" is the most common way a run produces
a confident wrong answer.

## 12. §9 — Expected results

The table the runner copies into `_results.md` §1:

```markdown
| #   | Half                  | Expected (quoted from § TC-<N>) | Observed | From | Verdict |
| --- | --------------------- | ------------------------------- | -------- | ---- | ------- |
| 1   | <which half or panel> | "<quotation>"                   |          |      |         |
```

Rules, each load-bearing:

- **The `#` column is a bare integer.** The tracker counts expected-result rows by matching
  `/^\| \d+ \|/`; `1.` or `(1)` makes the row invisible to it and the case's tally wrong.
- **Every Expected cell is a quotation** from the source document, carrying its citation. The plan
  states which section of which file, and instructs the runner to verify each quotation against that
  file before filling in an observation. The author pre-seeds them; the runner never derives them.
- **Every expected result in the source document gets a row.** One bullet stating three things becomes
  three rows. Dropping one is how a case passes without proving what it claimed.
- **Observed and Verdict are left blank.** They are the run's, and a pre-filled Observed is an
  invitation to confirm rather than to look.
- **From may be pre-filled**, and often should be: naming the artifact each row is to be read from
  turns the "How to observe each" list into a column the runner cannot skip past. It is a pointer,
  not an observation. Both shapes are in use — a blank From with the prose list carrying the
  detail, or a pre-filled From naming the artifact and the region within it.
- A row the plan knows is only half-observable on this route is pre-marked `⚠️` and explained. It is
  never deleted: a route difference is something to record, not something to make disappear.

Two hazards in this table are worth stating on their own, because both survive into `_results.md`
§1 and corrupt the tracker's count there rather than in the plan:

- **Only the expected-results table is copied into §1.** §9 may carry a second, supplementary table —
  "How to observe each" is sometimes written as `| # | Where to look | What satisfies it |` rather
  than as a list. That is fine here, and it is keyed by the same row numbers on purpose. But it
  matches `^\| \d+ \|` exactly as the real rows do, so if it travels into §1 the tracker counts its
  rows as expected results and every tally is wrong. Say in §11 which table is copied.
- **Escape a `|` inside a cell**, as `\|`, even inside backticks. Markdown splits the cell anyway, so
  an unescaped pipe adds a column — and since a row's verdict is read from its **last** cell, a row
  with an extra column has its verdict read from the wrong place.

Follow the table with a **How to observe each** list, saying for every row what specifically to read
and from which artifact. Where the route cannot show what the source document describes — no such
alert exists on this surface — say what the equivalent observation is, and say that the difference
must be named in `_results.md` §5.

Values that are anchors rather than expectations — fidelity counts, report-shape counts, index
mappings — are called out as belonging in `_report.md` §3 `Precondition checks`, not as §9 rows.

## 13. §10 — Artifacts to produce

A three-column table, `| File | What it is | Evidences |`, naming every file the run must leave
behind and which §9 row or record section it supports.

Naming is a contract with the tracker, which extracts cited artifacts by matching `NN-<name>.<ext>`
and `input-<name>.<ext>`:

- **`NN-` prefixed** — step output, where `NN` is the §7 step that produced it. This is what ties an
  artifact to the step that made it.
- **`input-` prefixed** — anything that is not step output: a copy of the fixture, a configuration
  export, the build identity capture.

Every artifact listed must end up cited in §9 or §5, and every artifact cited must exist. The
attestation "every row in §1 cites an artifact in `_report.md` §7, and every artifact there is cited"
is the runner's confirmation of exactly that, and the tracker checks it independently.

**Some artifacts cannot take either prefix**, because the tool that writes them dictates the name — a
directory of state snapshots a `--out-state` flag produced, a file whose extension the reader
requires. Keep the tool's name; renaming it breaks the thing that consumes it. But such a file is
invisible to the tracker's citation regex, so **pair it with a prefixed sibling that evidences it** —
a `04-state-snapshot-listing.txt` recording which snapshots were produced, cited alongside the
snapshot itself. The pairing is what keeps the row's provenance checkable.

## 14. §11 — Filling in the record

Opens with the sentence that fixes where the verdict goes:

> **`_results.md` opens with the `## Outcome` block, and any failure or anomaly is named there** —
> the verdict is never left for the reader to find at the bottom.

Then `### `_report.md`` and `### `_results.md``, each embedding the skeleton **pre-filled for this
case** — the §1 identity table already populated, the artifact table already listing §10's files, the
`<placeholders>` marking only what the run itself supplies.

Fence the skeletons with **four** backticks. They contain triple-fenced blocks of their own, and a
triple fence terminates at the first inner fence, truncating the skeleton at the point the runner
most needs it.

The shapes themselves are the **run-record** skill's, not this one's. Read `run-record-standards.md`
there before writing this section; §11 is a transcription of that standard with this case's values
filled in, and a plan that invents a section heading produces a record the tracker cannot read.

Close with a `**Only you can supply:**` paragraph listing what is genuinely the runner's — the date
and model, the observations, the argument, the verdict, the anomalies. It tells the runner that
everything _else_ in the skeleton is already decided.

## 15. §12 — Known traps for this case

Bullets, the sharpest marked `⚠️ **`. Traps are specific to this case: the thing that looks like a
failure and is not, the thing that looks like a pass and is not, the near-identical panels, the
exit code that means less than it appears to, the flag that does not exist in this family.

A trap that applies to every case in the project belongs in §0 or in the profile, not repeated here.

## 16. §13 — Definition of done

A `- [ ]` checklist the runner can walk mechanically. It cites §10's artifacts by name and the record
sections by number, and it ends with the two items every plan carries:

```markdown
- [ ] No build was run — only <the sanctioned launch route>.
- [ ] Nothing outside `tc-<N>/` was created, modified or deleted.
```

Items are checkable by looking, not by remembering. "The report is complete" is not an item;
"`_results.md` carries `## Outcome` and §1–§5" is.

## 17. Length

Real plans run 540–1015 lines of markdown. That is not padding — roughly a third of it is the §11
skeletons and the §0 rules, which are repeated in every case precisely because the running agent has
nothing else. A plan much shorter than that has usually left the record shapes implicit, and the
resulting record is the kind the tracker reports as `??`.

The ceiling that matters is the case file's: 256 KiB of `plan`, which no honest plan approaches.
