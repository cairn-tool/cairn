import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "vitest";
import { Case } from "../../../src/qa/cases.js";
import {
  classify,
  outcomeLabel,
  readVerdict,
  usageCells,
  usageFragment,
  usageMd,
  usageTotal,
} from "../../../src/qa/outcome.js";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "tco-")));

function results(body: string): string {
  const dir = join(tmp(), "case");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_results.md"), body);
  return dir;
}

it("readVerdict prefers the §4 body", () => {
  assert.equal(readVerdict(results("## 4. Verdict\n\n**PASS**\n\n## 5. x\n")), "PASS");
  assert.equal(readVerdict(results("## 4. Verdict\n\n**FAIL**\n\n## 5. x\n")), "FAIL");
  assert.equal(readVerdict(results("## 4.\n\n**UNVERIFIED**\n")), "UNVERIFIED");
});

it("readVerdict does not read a verdict from beyond §5", () => {
  assert.equal(
    readVerdict(results("## 4. Verdict\n\nnothing\n\n## 5. Notes\n\n**PASS**\n")),
    "—",
    "the PASS sits in §5, not §4",
  );
});

it("readVerdict falls back to the Outcome table", () => {
  assert.equal(readVerdict(results("| **Verdict** | PASS |\n")), "PASS");
  assert.equal(readVerdict(results("| **Verdict** | **FAIL** |\n")), "FAIL", "bold is stripped");
  assert.equal(readVerdict(results("| **Verdict** | MAYBE |\n")), "—", "unknown word rejected");
  // strip("*") only strips the ends, so the trailing ** stays glued to the first word.
  assert.equal(readVerdict(results("| **Verdict** | **FAIL** something |\n")), "—");
});

it("readVerdict returns an em dash when the file is missing", () => {
  assert.equal(readVerdict(join(tmp(), "nope")), "—");
});

it('usageTotal distinguishes "no usage at all" from "zeros"', () => {
  assert.equal(usageTotal([null, undefined]), null, "never saw a usage object");
  assert.deepEqual(usageTotal([{}]), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(usageTotal([{ inputTokens: 2 }, null, { inputTokens: 3, outputTokens: 1 }]), {
    inputTokens: 5,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

it("usage renderers format counts and em dashes", () => {
  const usage = {
    inputTokens: 1234,
    outputTokens: 340,
    cacheReadTokens: 5600,
    cacheWriteTokens: 0,
  };
  assert.equal(usageFragment(usage), "in 1.2k  out 340  cache-r 5.6k  cache-w 0");
  assert.deepEqual(usageCells(usage), {
    inn: "1.2k",
    out: "340",
    cache_r: "5.6k",
    cache_w: "0",
  });
  assert.deepEqual(usageMd(usage), {
    inn: "1234",
    out: "340",
    cache_r: "5600",
    cache_w: "0",
  });
  assert.deepEqual(usageCells(null), { inn: "—", out: "—", cache_r: "—", cache_w: "—" });
});

it("outcomeLabel maps the three verdicts and passes anything else through", () => {
  assert.equal(outcomeLabel("PASS"), "Passed");
  assert.equal(outcomeLabel("FAIL"), "Failed");
  assert.equal(outcomeLabel("UNVERIFIED"), "Unverified");
  assert.equal(outcomeLabel("—"), "—");
});

function scenario(): { kase: Case; runs: string } {
  const repo = tmp();
  const runs = join(repo, "runs");
  mkdirSync(runs, { recursive: true });
  const kase = new Case(
    {
      name: "tc-1",
      number: 1,
      file: join(runs, "_plans/tc-1.yaml"),
      id: "TC-1",
      title: "A case",
      agent: "cursor",
      model: null,
      parallel: true,
      tags: [],
      plan: "# plan\n",
    },
    join(runs, "tc-1"),
    repo,
    "model-x",
  );
  return { kase, runs };
}

function fillTemp(kase: Case, { report = true, res = true } = {}): void {
  mkdirSync(kase.tempDir, { recursive: true });
  if (report) writeFileSync(join(kase.tempDir, "_report.md"), "r");
  if (res) writeFileSync(join(kase.tempDir, "_results.md"), "r");
}

it("classify: timeout beats everything", () => {
  const { kase } = scenario();
  fillTemp(kase);
  assert.deepEqual(classify(kase, 0, true), ["timeout", ""]);
  assert.ok(existsSync(kase.tempDir), "no promotion on timeout");
});

it("classify: a non-zero exit is an error, but null is treated as success", () => {
  const { kase } = scenario();
  fillTemp(kase);
  assert.deepEqual(classify(kase, 3, false), ["error", ""]);
  assert.equal(classify(kase, null, false)[0], "ok", "null exit code promotes");
});

it("classify: a signal death must not be mistaken for success", () => {
  const { kase } = scenario();
  fillTemp(kase);
  assert.deepEqual(classify(kase, -9, false), ["error", ""], "SIGKILL maps to -9, not null");
});

it("classify: missing temp folder and missing records", () => {
  const a = scenario();
  assert.deepEqual(classify(a.kase, 0, false), [
    "no-folder",
    "agent never created the temp folder",
  ]);

  const b = scenario();
  fillTemp(b.kase, { report: false });
  assert.deepEqual(classify(b.kase, 0, false), [
    "no-output",
    "temp folder is missing _report.md or _results.md",
  ]);

  const c = scenario();
  fillTemp(c.kase, { res: false });
  assert.equal(classify(c.kase, 0, false)[0], "no-output");
});

it("classify: a clean run renames temp to final", () => {
  const { kase } = scenario();
  fillTemp(kase);
  assert.deepEqual(classify(kase, 0, false), ["ok", ""]);
  assert.ok(existsSync(kase.outDir), "promoted");
  assert.ok(!existsSync(kase.tempDir), "temp folder consumed");
});

it("classify: a pre-existing out dir blocks promotion and keeps the temp folder", () => {
  const { kase } = scenario();
  fillTemp(kase);
  mkdirSync(kase.outDir, { recursive: true });
  const [status, note] = classify(kase, 0, false);
  assert.equal(status, "error");
  assert.equal(note, "tc-1/ already exists; left tc-1-temp/ in place");
  assert.ok(existsSync(kase.tempDir), "temp folder preserved for inspection");
});
