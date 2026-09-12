# Tracker Contract

`cairn qa summary --runs-dir <dir>` regenerates `<runs-dir>/summary.md` by re-deriving every column
from the files on disk. It is the reason the record shapes are exact rather than stylistic: a heading
in the wrong form does not look untidy, it makes a real verdict unreadable.

This file lists what is parsed, what each miss produces, and the one upstream document the tracker
also reads.

## 1. The columns

```text
| Case | Title | Priority | Verdict | Rows | Script | Attestations | Artifacts | 📋 | 📄 | 📊 |
```

The verdict tally underneath counts in a fixed order: `PASS`, `FAIL`, `UNVERIFIED`, `??`,
`— not run`. `??` means _a record exists and the tracker could not read its verdict_ — it is the
signal that a shape is wrong, not that a run went badly.

A row appears for every `tc-<N>.{yaml,yml}` **file present** in `_plans/`, scanned directly rather
than through the loader, so a case whose YAML is broken still earns a row and a note instead of
vanishing. A `tc-<N>/` folder with no case file also earns a row.

## 2. `_report.md`

| Parsed   | Rule                                                                      |
| -------- | ------------------------------------------------------------------------- |
| Sections | The first seven matches of `^## (\d+)\. ` must be exactly `1 2 3 4 5 6 7` |

Note when it is not: `` `_report.md` does not carry its seven sections: ['1', '2', '4'] ``

The pattern requires `## `, digits, a period, **and a space**. `## 1.Case` and `##1. Case` do not
match; a section headed `## 1. Case` does.

## 3. `_results.md`

| Parsed             | Rule                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Sections           | The first five matches of `^## (\d+)\. ` must be exactly `1 2 3 4 5`                                         |
| Outcome block      | The literal string `## Outcome` must appear                                                                  |
| Verdict            | In the body between `## 4.` and `## 5.`: a line **starting** with `**PASS**`, `**FAIL**` or `**UNVERIFIED**` |
| Rows               | In the body between `## 1.` and `## 2.`: lines matching `^\| \d+ \|`                                         |
| Row verdict        | The **last cell** of such a row: containing `✅` counts as passed, `❌` as failed                            |
| Attestations       | Occurrences of `- [x]` and `- [ ]` **anywhere in the file**                                                  |
| Artifact citations | In the §1 body: `` `NN-<name>` `` or `` `input-<name>` `` in backticks                                       |

Notes produced:

- `` `_results.md` does not carry its five sections: [...] ``
- `` `_results.md` carries no `## Outcome` block — the verdict is buried ``
- `` `_results.md` §4 states no verdict this script can read `` — and the case tallies as `??`
- `` `_results.md` §1 carries no expected-result rows ``
- `leaves N attestation(s) unticked — see its §5`
- `cites artifacts that are not on disk: <names>`

Three consequences worth holding precisely:

1. **Attestations are counted file-wide**, not within §3. Any `- [ ]` anywhere in `_results.md` — a
   leftover checklist, an unticked "n/a" item — is counted as outstanding. Tick what is satisfied,
   including items that are satisfied vacuously, and explain in §5 anything left unticked.
2. **Only §1 is scanned for artifact citations.** An artifact named only in §5 or in `_report.md` §7
   is not treated as cited, which is what the "every row in §1 cites an artifact" attestation is
   about. Citations ending in `.md` are ignored, and a trailing slash is stripped.
3. **The row verdict comes from the last cell only.** A `✅` in the Observed column and an empty
   Verdict column reads as no verdict at all.

## 4. The `## Outcome` cross-checks

The block is everything between `## Outcome` and the first `## 1.`. Three of its rows are compared
against the body:

| Row | Compared against     | Note when it disagrees |
| --- | -------------------- | ---------------------- |
| `   | **Verdict**          | PASS`                  | §4's verdict      | `` `## Outcome` claims **PASS** but §4 states **FAIL** ``        |
| `   | **Expected results** | <p> of <t>`            | §1's passed/total | `` `## Outcome` claims 8 of 10 confirmed but §1 shows 7 of 10 `` |
| `   | **Failures**         | None                   | `                 | §1's ❌ count                                                    | `` `## Outcome` says no failures but §1 carries 2 ❌ row(s) `` |

The Verdict cell is read as the first run of capitals after the pipe, so a placeholder left in place
(`<PASS / FAIL / UNVERIFIED>`) matches `PASS` and will be compared as if it were the verdict.

## 5. The upstream QA index

Titles and the Priority column fall back to `<runs-dir>/../qa-testing.md`, parsed with:

```js
/^- (?:⚠️ )?\*\*TC-(\d+)\*\* — (.+?) — \*\*([^*]+)\*\* — /gm;
```

So an index line must be exactly this shape — group 2 is the title, group 3 is the priority:

```markdown
- **TC-1** — Key absent versus key set, end to end — **🔴 Mandatory** — **📋 Scenario Based** — _AC-1(a)(1)_
- ⚠️ **TC-3** — The strict parse rejects non-boolean values — **🟠 High** — **📋 Scenario Based** — _AC-1(a)(3)_
```

The trailing `— ` is required, so at least one more `—`-separated field must follow the priority.
Cairn does not author that index and nothing requires one; this contract only describes what
`src/qa/tracker.ts` reads out of it when it is there.

Titles prefer the case file's `name:` and fall back to the index. Priority comes from the index
alone — the case file has no priority key — which is why a case with no index line has no priority.

## 6. The Script column

For each `input-script-s<N>.txt` artifact in a run folder, the tracker compares it byte for byte
against the `## Script S<N>` fenced block in `<runs-dir>/../qa-test-steps/01-scenario-scripts.md` and
reports `identical`, `differs`, or `n/a`. That is what catches a script trimmed down before running —
the single most effective way to make a scenario case prove less than it claims.

## 7. Other notes the tracker emits

- `has a `tc-<N>/`folder but no`_plans/tc-<N>.md` — a run with no execution plan`. The message says
  `.md`; the file it actually looks for is the `.yaml`. Read it as "no case file".
- `has `_report.md`but no`_results.md` — an incomplete run record` (and the mirror image).

## 8. Using this contract

When a case shows `??`, or a count that looks wrong, the cause is in this file rather than in the
run. Work down it in order: the five section headings, the `## Outcome` string, the `**VERDICT**`
line in §4, the `| N |` row prefixes, the last-cell marks. One of them will be the answer.
