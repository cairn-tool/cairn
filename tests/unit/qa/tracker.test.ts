import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  indexRow,
  rowVerdict,
  section,
  todayIso,
  writeCaseTracker,
} from "../../../src/qa/tracker.js";
import { caseYaml } from "./helpers.js";

function makeRuns(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tct-")));
  const runs = join(root, "runs");
  mkdirSync(join(runs, "_plans"), { recursive: true });
  return runs;
}

const plan = (runs: string, n: number, title?: string): void =>
  writeFileSync(
    join(runs, "_plans", `tc-${n}.yaml`),
    caseYaml(`tc-${n}`, title === undefined ? {} : { title }),
  );

function report(runs: string, n: number, sections = [1, 2, 3, 4, 5, 6, 7]): void {
  const dir = join(runs, `tc-${n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_report.md"), sections.map((s) => `## ${s}. Section ${s}\n`).join("\n"));
}

interface ResultsOpts {
  verdict?: string;
  rows?: string[];
  attest?: string[];
  outcomeVerdict?: string;
  outcomeTally?: string;
  outcomeFailures?: string;
  cites?: string;
  omitOutcome?: boolean;
}

function results(runs: string, n: number, o: ResultsOpts = {}): void {
  const dir = join(runs, `tc-${n}`);
  mkdirSync(dir, { recursive: true });
  const verdict = o.verdict ?? "PASS";
  const rows = o.rows ?? ["| 1 | a | a | ✅ |"];
  const attest = o.attest ?? ["- [x] done"];
  const body: string[] = [];
  if (!o.omitOutcome) {
    body.push(
      "## Outcome",
      "",
      `| **Verdict** | ${o.outcomeVerdict ?? verdict} |`,
      `| **Expected results** | ${o.outcomeTally ?? `${rows.length} of ${rows.length} confirmed`} |`,
      `| **Failures** | ${o.outcomeFailures ?? "None"} |`,
      "",
    );
  }
  body.push(
    "## 1. Expected versus observed",
    "",
    "| # | Expected | Observed | Verdict |",
    ...rows,
    "",
    o.cites ?? "",
    "",
    "## 2. Deviations",
    "## 3. Evidence",
    "## 4. Verdict",
    "",
    `**${verdict}**`,
    "",
    "## 5. Attestations",
    "",
    ...attest,
    "",
  );
  writeFileSync(join(dir, "_results.md"), body.join("\n"));
}

const read = (runs: string): string => readFileSync(join(runs, "summary.md"), "utf8");

it("a clean case produces no flags", () => {
  const runs = makeRuns();
  plan(runs, 1);
  report(runs, 1);
  results(runs, 1);
  const out = writeCaseTracker(runs);
  assert.equal(out.planned, 1);
  assert.equal(out.run, 1);
  const text = read(runs);
  assert.match(text, /\*\*TC-1\*\*.*✅ PASS.*1\/1/);
  assert.match(text, /- None\. Every case carries a plan/, "no flags");
});

it('a planned but unrun case is "— not run" with em dashes', () => {
  const runs = makeRuns();
  plan(runs, 1);
  const out = writeCaseTracker(runs);
  assert.equal(out.run, 0);
  const line = read(runs)
    .split("\n")
    .find((l) => l.includes("**TC-1**"))!;
  assert.match(line, /— not run/);
  assert.match(line, /\| — \| n\/a \| — \| — \|/, "rows, attestations, artifacts blank");
  assert.match(read(runs), /- \*\*Not yet run:\*\* 1/);
});

it("an orphan folder with no plan still earns a row and a flag", () => {
  const runs = makeRuns();
  report(runs, 99);
  results(runs, 99);
  writeCaseTracker(runs);
  const text = read(runs);
  assert.match(text, /\*\*TC-99\*\*/);
  assert.match(text, /has a `tc-99\/` folder but no `_plans\/tc-99\.yaml`/);
});

it("an incomplete run record is flagged in both directions", () => {
  const a = makeRuns();
  plan(a, 1);
  report(a, 1);
  writeCaseTracker(a);
  assert.match(read(a), /has `_report\.md` but no `_results\.md`/);

  const b = makeRuns();
  plan(b, 1);
  results(b, 1);
  writeCaseTracker(b);
  assert.match(read(b), /has `_results\.md` but no `_report\.md`/);
});

it("wrong section lists are reported with Python list repr", () => {
  const runs = makeRuns();
  plan(runs, 1);
  report(runs, 1, [1, 2, 3]);
  results(runs, 1);
  writeCaseTracker(runs);
  assert.match(read(runs), /does not carry its seven sections: \['1', '2', '3'\]/);
});

it("unticked attestations are counted and flagged", () => {
  const runs = makeRuns();
  plan(runs, 1);
  report(runs, 1);
  results(runs, 1, { attest: ["- [x] one", "- [ ] two", "- [ ] three"] });
  writeCaseTracker(runs);
  const text = read(runs);
  assert.match(text, /leaves 2 attestation\(s\) unticked/);
  assert.match(text, /1\/3 ⚠️/);
});

it("failed rows are counted from the Verdict column only", () => {
  const runs = makeRuns();
  plan(runs, 1);
  report(runs, 1);
  results(runs, 1, {
    verdict: "FAIL",
    rows: ["| 1 | a | a | ✅ |", "| 2 | ✅ mentioned in prose | b | ❌ |"],
    outcomeTally: "1 of 2 confirmed",
    outcomeFailures: "1 row",
  });
  writeCaseTracker(runs);
  assert.match(read(runs), /❌ FAIL \| 1\/2 \(1 failed\)/);
});

it("Outcome disagreements are each flagged", () => {
  const runs = makeRuns();
  plan(runs, 1);
  report(runs, 1);
  results(runs, 1, {
    verdict: "FAIL",
    rows: ["| 1 | a | a | ✅ |", "| 2 | b | c | ❌ |"],
    outcomeVerdict: "PASS",
    outcomeTally: "3 of 3 confirmed",
    outcomeFailures: "None",
  });
  writeCaseTracker(runs);
  const text = read(runs);
  assert.match(text, /claims \*\*PASS\*\* but §4 states \*\*FAIL\*\*/);
  assert.match(text, /claims 3 of 3 confirmed but §1 shows 1 of 2/);
  assert.match(text, /says no failures but §1 carries 1 ❌ row\(s\)/);
});

it("cited artifacts that are absent are flagged; .md citations are ignored", () => {
  const runs = makeRuns();
  plan(runs, 1);
  report(runs, 1);
  results(runs, 1, { cites: "See `01-present.txt`, `02-absent.txt` and `03-notes.md`." });
  writeFileSync(join(runs, "tc-1", "01-present.txt"), "x");
  writeCaseTracker(runs);
  const text = read(runs);
  assert.match(text, /cites artifacts that are not on disk: 02-absent\.txt/);
  assert.doesNotMatch(text, /03-notes\.md/);
});

it("an unreadable verdict becomes ?? and is flagged", () => {
  const runs = makeRuns();
  plan(runs, 1);
  report(runs, 1);
  mkdirSync(join(runs, "tc-1"), { recursive: true });
  writeFileSync(
    join(runs, "tc-1", "_results.md"),
    "## 1. x\n\n## 2. x\n## 3. x\n## 4. Verdict\n\nnothing readable\n\n## 5. x\n",
  );
  writeCaseTracker(runs);
  const text = read(runs);
  assert.match(text, /§4 states no verdict this script can read/);
  assert.match(text, /§1 carries no expected-result rows/);
  assert.match(text, /- \*\*\?\?:\*\* 1/);
});

it("titles come from the case file, priorities from ../qa-testing.md", () => {
  const runs = makeRuns();
  plan(runs, 1, "Login with a valid account");
  plan(runs, 2, "Password reset");
  writeFileSync(
    join(runs, "..", "qa-testing.md"),
    [
      "- **TC-1** — Login with a valid account — **P1** — smoke",
      "- ⚠️ **TC-2** — Password reset — **P2** — regression",
      "",
    ].join("\n"),
  );
  writeCaseTracker(runs);
  const text = read(runs);
  assert.match(text, /\*\*TC-1\*\* \| Login with a valid account \| P1 \|/);
  assert.match(text, /\*\*TC-2\*\* \| Password reset \| P2 \|/, "the warning prefix is optional");
});

it("a title falls back to the index when the case file has none to give", () => {
  const runs = makeRuns();
  writeFileSync(join(runs, "_plans", "tc-1.yaml"), "id: TC-1\nname:\nplan: |\n  x\n");
  writeFileSync(
    join(runs, "..", "qa-testing.md"),
    "- **TC-1** — Login with a valid account — **P1** — smoke\n",
  );
  const out = writeCaseTracker(runs);
  assert.equal(out.planned, 1, "a broken case file is still a planned case");
  const text = read(runs);
  assert.match(text, /\*\*TC-1\*\* \| Login with a valid account \| P1 \|/);
  assert.match(text, /tc-1: `name` must be a string/, "and the breakage is flagged");
});

it("cases sort numerically and the tally is ordered", () => {
  const runs = makeRuns();
  for (const n of [10, 2, 1, 100]) plan(runs, n);
  writeCaseTracker(runs);
  const order = [...read(runs).matchAll(/\*\*TC-(\d+)\*\*/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 2, 10, 100]);
});

it("the generated date is local, not UTC", () => {
  const runs = makeRuns();
  plan(runs, 1);
  writeCaseTracker(runs);
  assert.match(read(runs), new RegExp(`Generated ${todayIso()} — `));
});

it("helpers behave like their Python originals", () => {
  assert.equal(section("## 1. a\nbody\n## 2. b\n", "1", "2"), " a\nbody\n");
  assert.equal(section("no headings", "1", "2"), "");
  assert.equal(rowVerdict("| 1 | ✅ in prose | b | ❌ |"), "❌", "last cell only");
  assert.deepEqual(indexRow(5, ""), ["", ""]);
  assert.deepEqual(indexRow(5, "- **TC-9** — x — **P1** — y"), ["", ""], "no match");
});
