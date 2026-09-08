import assert from "node:assert/strict";
import { it } from "vitest";
import {
  consoleSummary,
  pyFloatMarker,
  pyJsonDumps,
  renderSessionLog,
  round1,
} from "../../../src/qa/reports.js";
import type { Rec, SessionInfo, SessionStats } from "../../../src/qa/reports.js";

const info: SessionInfo = {
  runId: "20260903-120000",
  pid: 4242,
  defaultModel: "cursor-grok-4.6-high",
  parallel: 8,
  repo: "/repo",
  runsDir: "/repo/runs",
  sessionLog: "/repo/runs/_runs/20260903-120000-4242.md",
  logRoot: "/pkg/logs/20260903-120000",
};

const rec = (over: Partial<Rec> = {}): Rec => ({
  name: "tc-11",
  model: "composer-2.5",
  status: "ok",
  exitCode: 0,
  startedS: 12.5,
  durationS: 271.44,
  durationIsInt: false,
  usage: {
    inputTokens: 1234,
    outputTokens: 340,
    cacheReadTokens: 5600,
    cacheWriteTokens: 0,
  },
  note: "",
  sessionId: "sess-1",
  logDir: "logs/20260903-120000/tc-11",
  tools: 87,
  ...over,
});

const stats: SessionStats = {
  ok: 1,
  fail: 1,
  skipped: 1,
  durationS: 271.44,
  tools: 87,
  usage: {
    inputTokens: 1234,
    outputTokens: 340,
    cacheReadTokens: 5600,
    cacheWriteTokens: 0,
  },
  wallS: 3661,
};

it("pyJsonDumps escapes non-ASCII the way ensure_ascii does", () => {
  assert.equal(pyJsonDumps({ outcome: "—" }), '{\n  "outcome": "\\u2014"\n}');
  assert.equal(pyJsonDumps({ s: "café" }), '{\n  "s": "caf\\u00e9"\n}');
  assert.ok(!pyJsonDumps({ s: "✅" }).includes("✅"), "no raw non-ASCII survives");
});

it("pyJsonDumps renders floats with Python repr, ints as ints", () => {
  const text = pyJsonDumps({
    float_whole: pyFloatMarker(2),
    float_frac: pyFloatMarker(271.4),
    plain_int: 0,
  });
  assert.match(text, /"float_whole": 2\.0/, "an integral float keeps its .0");
  assert.match(text, /"float_frac": 271\.4/);
  assert.match(text, /"plain_int": 0/, "a real int has no .0");
});

it("summary.json records when each case started and under which model", () => {
  const payload = pyJsonDumps({
    started_s: pyFloatMarker(round1(12.54)),
    model: "composer-2.5",
  });
  assert.match(payload, /"started_s": 12\.5/);
  assert.match(payload, /"model": "composer-2\.5"/);
});

it("round1 matches round(x, 1)", () => {
  assert.equal(round1(271.44), 271.4);
  assert.equal(round1(271.46), 271.5);
  assert.equal(round1(0), 0);
  assert.equal(round1(0.25), 0.2, "half-to-even");
  assert.equal(round1(0.35), 0.4, "half-to-even the other way");
});

it("the session log carries the header, totals and one row per record", () => {
  const md = renderSessionLog(
    info,
    [rec(), rec({ name: "tc-12", status: "timeout" })],
    stats,
    () => "Passed",
  );
  assert.match(md, /^# cairn qa 20260903-120000 {2}pid 4242$/m);
  assert.match(md, /- \*\*Launched:\*\* 20260903-120000 UTC/);
  assert.match(md, /- \*\*Wall clock:\*\* 1:01:01/);
  assert.match(md, /- \*\*ok \/ fail \/ skipped:\*\* 1 \/ 1 \/ 1/);
  assert.match(md, /- \*\*Default model:\*\* `cursor-grok-4\.6-high`/);
  assert.match(md, /- \*\*Tokens:\*\* in 1\.2k {2}out 340 {2}cache-r 5\.6k {2}cache-w 0/);
  assert.match(md, /in 1234 · out 340 · cache-r 5600 · cache-w 0/, "exact counts too");
  assert.match(
    md,
    /\| tc-11 \| composer-2\.5 \| ok \| Passed \| 04:31 \| 87 \| 1234 \| 340 \| 5600 \| 0 \| — \|/,
  );
  assert.match(md, /\| tc-12 \| composer-2\.5 \| timeout \|/);
  assert.ok(md.endsWith("\n"), "trailing newline");
});

it("pipes in a note are escaped so the table survives", () => {
  const md = renderSessionLog(info, [rec({ note: "a | b | c" })], stats, () => "Passed");
  assert.match(md, /\| a \\\| b \\\| c \|/);
});

it("a session with no records still renders a placeholder row", () => {
  const md = renderSessionLog(info, [], { ...stats, usage: null }, () => "—");
  assert.match(md, /\| — \| — \| — \| — \| — \| — \| — \| — \| — \| — \| no cases finished yet \|/);
  assert.match(md, /- \*\*Tokens:\*\* tokens —/);
});

it("the console summary lists the tracker line only when there is one", () => {
  const withTracker = consoleSummary(info, stats, "/repo/runs/summary.md");
  assert.match(withTracker, /^cairn qa 20260903-120000 {2}pid 4242$/m);
  assert.match(withTracker, /^1 ok \/ 1 fail \/ 1 skipped$/m);
  assert.match(withTracker, /elapsed 1:01:01 {2}case-time 04:31 {2}tools 87/);
  assert.match(withTracker, /^tracker {2}\/repo\/runs\/summary\.md$/m);

  const without = consoleSummary(info, { ...stats, usage: null }, null);
  assert.doesNotMatch(without, /tracker/);
  assert.match(without, /^tokens —$/m);
});
