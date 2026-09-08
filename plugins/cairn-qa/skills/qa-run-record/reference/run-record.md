# Run Record Standards

The two documents a run leaves behind, `_report.md` and `_results.md`. A plan embeds both as
pre-filled skeletons in its §11; a runner fills them in; the tracker reads them. All three uses share
this one specification.

## 1. The one rule that matters

**The expected values come from the source document. The agent never supplies them.**

An agent asked to "check the factor is right" will recompute it from the formula, agree with itself,
and produce a record that looks immaculate. Every Expected value in §1 of `_results.md` is therefore
a quotation carrying its citation, pre-seeded by the plan author, and the runner's job is to
**verify each against the cited source, then fill in the observation** — not to re-derive the
expectation, and not to trust the plan blindly either.

Where an observation disagrees with an expectation, that is a finding for §5. It is never a reason to
adjust the expectation, and never a reason to go back to the source document looking for a friendlier
wording.

## 2. Where the record lives

Deliverables belong in `<runs-dir>/tc-<N>/`, alongside the artifacts. The agent creates that folder
itself — its absence is what marked the case as pending.

Under `cairn qa` the agent is told to write `tc-<N>-temp/` and the harness renames it to
`tc-<N>/` only on a successful run. The plan and the record both name the **final** folder; the
promotion is the harness's business.

**A run is complete only when both files exist.** The harness refuses to promote a folder carrying
one and not the other, and the tracker reports the pair as _an incomplete run record_.

## 3. `_report.md` — what happened

Seven numbered sections, `## 1.` through `## 7.`, in order. What the run did and what it saw; no
verdict, no argument.

```markdown
# TC-<N> — <title> — run record

Results and verdict: [`_results.md`](./_results.md). Execution plan: [`tc-<N>.md`](../_plans/tc-<N>.md).

## 1. Case

## 2. Run

## 3. Setup

## 4. Steps executed

## 5. Inputs

## 6. Outputs

## 7. Artifacts
```

| Section               | Holds                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Case**           | The plan's §1 identity table, pasted. Case, Priority, Tools, Verifies, Source of truth, whether the index marks it ⚠️                           |
| **2. Run**            | Date, who ran it (agent and model), the surface and route actually used, and the build under test                                               |
| **3. Setup**          | The procedure followed; **Precondition checks** with the observed anchor values; deviations from the documented setup; deviations from the plan |
| **4. Steps executed** | What was actually run, in order, each citing the artifact it produced                                                                           |
| **5. Inputs**         | The input verbatim, or trimmed with a note saying where                                                                                         |
| **6. Outputs**        | **Verbatim output, not a summary.** Say where you trimmed                                                                                       |
| **7. Artifacts**      | The plan's §10 table, as delivered                                                                                                              |

**§2's build sentence is load-bearing.** A run against uncommitted work says so — "working tree at
`<sha>` plus uncommitted modifications; `<path>` is untracked, so this run is not reproducible from
the bare commit" is a good answer. A bare commit hash that does not describe the tree is not.

**§3's deviations are two separate fields.** A deviation from the _documented setup_ is a route
difference — the plan knew about it and said what to do instead. A deviation from _the plan_ is
something the runner decided, and every one of those is also raised in `_results.md` §5.

**§6 is verbatim.** It is the section a reader goes to when they disbelieve the verdict, and a
summary there makes the whole record unfalsifiable. Trim by quoting a region and saying so; never
paraphrase.

## 4. `_results.md` — what it means

`## Outcome`, then five numbered sections. The verdict is at the top, never at the bottom.

```markdown
# TC-<N> — <title> — results

Run record: [`_report.md`](./_report.md). Execution plan: [`tc-<N>.md`](../_plans/tc-<N>.md).

## Outcome

## 1. Expected versus observed

## 2. Why these outputs prove the case

## 3. Attestations

## 4. Verdict

## 5. Anomalies
```

### The `## Outcome` block

```markdown
## Outcome

|                            |                                                                             |
| -------------------------- | --------------------------------------------------------------------------- |
| **Verdict**                | <PASS / FAIL / UNVERIFIED>                                                  |
| **Expected results**       | <p> of <t> confirmed                                                        |
| **Failures**               | <one line per ❌ row, naming the row number and the divergence — or "None"> |
| **Anomalies and findings** | <one line each, or "None">                                                  |
| **Attestations**           | <t> of <t+u>; unticked: <which, or "none">                                  |
```

Every one of those five rows is cross-checked against the body. The Verdict must equal §4's, the
tally must equal §1's, and claiming `None` for Failures while §1 carries a ❌ row is reported.

The block sits **between the H1 and `## 1.`**. Anything after `## 1.` is not part of it.

### §1 — Expected versus observed

The plan's §9 table, filled in:

```markdown
| #   | Half         | Expected (quoted from § TC-<N>) | Observed                      | From                     | Verdict |
| --- | ------------ | ------------------------------- | ----------------------------- | ------------------------ | ------- |
| 1   | S3a (absent) | "All three green."              | every mark ✅; `PASS - S3a …` | `04-assertion-marks.txt` | ✅      |
```

- The `#` column is a **bare integer**. It is how rows are counted.
- The **last cell** carries the row verdict, `✅` or `❌`. Nothing else is read as a verdict.
- The **From** column cites the artifact the observation came from, in backticks. Those citations are
  extracted and checked against the files actually on disk.
- Every row gets an Observed value, a From citation and a Verdict. A row that could not be observed
  is `⚠️` with the reason, and drives the case toward UNVERIFIED — it is never deleted.

### §2 — Why these outputs prove the case

The argument. Not a restatement of §1: the case for why these particular observations bear on the
claim, and why a false pass is ruled out.

Two shapes that need explicit treatment:

- **A negative case** — asserting that something did _not_ happen — must show that a real change was
  available and was withheld. Name the paired positive observation that proves the mechanism was
  live. Without it, the negative half passed because nothing could have failed.
- **A guarded code path** — where several guards could each produce the same outcome — must say which
  guard fired and how that was established. Where the surface prints no such signal, say the guard is
  argued from the observable values rather than read off, and qualify the claim.

### §3 — Attestations

Ten items, verbatim. They are a fixed list; paraphrasing one changes what is being attested.

```markdown
- [ ] Every Expected value is quoted from the source document; none was derived, recomputed or recalled.
- [ ] Every expected result in the source document has a row in §1; none was dropped.
- [ ] `_report.md` §6 is verbatim output, not a summary.
- [ ] The run exercised the build named in `_report.md` §2.
- [ ] No expectation was edited to match an observation.
- [ ] Where the case names a panel, scenario or control, the one observed carries that same name.
- [ ] Every row in §1 cites an artifact in `_report.md` §7, and every artifact there is cited.
- [ ] Artifacts were captured during the run, not reconstructed afterwards.
- [ ] Screenshots only: each is paired with the extracted text for anything asserted from it.
- [ ] Negative case only: a real change was available and is evidenced in §2.
```

The last two are conditional. When the case has no screenshots, or is not a negative case, **tick the
item and append the reason** — `— n/a, no screenshots on the CLI route.` An `- [ ]` left unticked is
counted as an outstanding attestation wherever it appears in the file, so an unticked "n/a" reads as
an unmet obligation. A plan may pre-write the `— n/a` suffix when it can answer the question in
advance; the runner still ticks it.

Leave an item unticked only when it genuinely was not satisfied — and then **say why in §5**. An
unticked attestation under a PASS verdict is one of the strongest signals that a record is not what
it appears to be.

### §4 — Verdict

One line, the word alone, bold, at the start of a line:

```markdown
**PASS**
```

`PASS`, `FAIL` or `UNVERIFIED` and nothing else. Any other wording — `**PASS** (with caveats)` is
fine, but `Verdict: PASS` or `**Passed**` is not — makes the verdict unreadable and the case is
tallied as `??`.

|                |                                                         |
| -------------- | ------------------------------------------------------- |
| **PASS**       | Every expected result was observed and matched          |
| **FAIL**       | Something was observed and did not match. A real result |
| **UNVERIFIED** | Something could not be observed. Also a real result     |

**UNVERIFIED is never a failure to report.** A case blocked by a busy port, a missing build, or a
surface that does not expose what the source document describes is UNVERIFIED with the reason. The one
forbidden move is narrowing what the case claims until it goes green.

### §5 — Anomalies

Route differences and what was observed instead; deviations from the plan and why; anything true that
the sections above did not cover; and the reason for any unticked attestation.

A finding that the source document itself is wrong goes here. It is **not** a correction to make
silently, and it is not a reason to change an expectation.

## 5. Artifacts

Two prefixes, and they are a contract rather than a convention:

- **`NN-<name>.<ext>`** — output of §7 step `NN` of the plan. The prefix is what ties an artifact to
  the step that produced it.
- **`input-<name>.<ext>`** — everything that is not step output: a copy of the fixture, a
  configuration export, the build identity capture.

Anything cited in §1 that does not match one of those two shapes is not recognised as a citation.
Anything cited that is not on disk is reported by name.

**Artifacts are captured during the run and never edited afterwards.** Trim by quoting a region in
the record and leaving the file whole. A screenshot is never retouched, cropped, or re-taken to look
tidier.

## 6. What "a complete set of artifacts" means

Enough that someone who does not trust the verdict can check it without re-running the case:

- the input as executed, and the numbers proving the extraction was faithful;
- the exact command or route, captured rather than remembered;
- the raw output, whole;
- the shape check that proves the run went where it was supposed to go and was not truncated;
- the specific extraction each §1 row was read from;
- for a visual surface, the screenshot **and** the extracted text for anything asserted from it — a
  screenshot alone never establishes a containment or a value.
