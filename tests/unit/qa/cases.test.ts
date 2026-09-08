import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  Case,
  agentCommand,
  caseNumber,
  catalog,
  discover,
  elidedCommand,
  shellJoin,
  shellQuote,
  stillEligible,
} from "../../../src/qa/cases.js";
import type { CaseFile } from "../../../src/qa/casefile.js";
import { parseOnly } from "../../../src/qa/config.js";
import { caseYaml } from "./helpers.js";

const DEFAULT_MODEL = "default-model";

function fixture(planNames: string[], ranNames: string[] = []): { repo: string; runs: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tcc-")));
  const runs = join(repo, "runs");
  mkdirSync(join(runs, "_plans"), { recursive: true });
  for (const n of planNames) {
    const stem = n.replace(/\.(yaml|yml|md)$/, "");
    // Non-case names still need *some* content; caseYaml only knows how to name tc-N.
    const body = /^tc-\d+$/.test(stem) ? caseYaml(stem) : "# not a case\n";
    writeFileSync(join(runs, "_plans", n), body);
  }
  for (const n of ranNames) mkdirSync(join(runs, n), { recursive: true });
  return { repo, runs };
}

const names = (runs: string, repo: string): string[] =>
  catalog(runs, repo, DEFAULT_MODEL).cases.map((c) => c.name);

/** A CaseFile with everything defaulted, for constructing a Case directly. */
const spec = (over: Partial<CaseFile> = {}): CaseFile => ({
  name: "tc-11",
  number: 11,
  file: "/repo/runs/_plans/tc-11.yaml",
  id: "TC-11",
  title: "A title",
  agent: "cursor",
  model: null,
  parallel: true,
  tags: [],
  plan: "# the plan\n",
  ...over,
});

it("catalog sorts numerically, not lexicographically", () => {
  const { repo, runs } = fixture([
    "tc-1.yaml",
    "tc-2.yaml",
    "tc-10.yaml",
    "tc-100.yaml",
    "tc-11.yaml",
  ]);
  assert.deepEqual(names(runs, repo), ["tc-1", "tc-2", "tc-10", "tc-11", "tc-100"]);
});

it("catalog accepts only tc-<digits>.yaml", () => {
  const { repo, runs } = fixture([
    "tc-1.yaml",
    "tc-10a.yaml",
    "tc-abc.yaml",
    "tc-.yaml",
    "notes.yaml",
    "tc-3.md",
    "tc-2.yml",
  ]);
  assert.deepEqual(names(runs, repo), ["tc-1", "tc-2"], ".yml counts, .md no longer does");
});

it("catalog on a missing _plans/ returns nothing rather than throwing", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tcc-")));
  assert.deepEqual(catalog(join(repo, "nope"), repo, DEFAULT_MODEL), { cases: [], errors: [] });
});

it("discover drops cases that already have a run folder", () => {
  const { repo, runs } = fixture(["tc-1.yaml", "tc-2.yaml", "tc-3.yaml"], ["tc-2"]);
  const all = catalog(runs, repo, DEFAULT_MODEL).cases;
  assert.deepEqual(
    discover(all).map((c) => c.name),
    ["tc-1", "tc-3"],
  );
});

it("discover applies --only then --limit, in that order", () => {
  const { repo, runs } = fixture(["tc-1.yaml", "tc-2.yaml", "tc-3.yaml", "tc-4.yaml"]);
  const all = catalog(runs, repo, DEFAULT_MODEL).cases;
  const only = parseOnly("tc-2,3,tc-4");
  assert.deepEqual(
    discover(all, only, 2).map((c) => c.name),
    ["tc-2", "tc-3"],
  );
  assert.deepEqual(discover(all, null, 0), []);
});

it("a case inherits --model only when its YAML omits one", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tcc-")));
  const runs = join(repo, "runs");
  mkdirSync(join(runs, "_plans"), { recursive: true });
  writeFileSync(join(runs, "_plans", "tc-1.yaml"), caseYaml("tc-1"));
  writeFileSync(join(runs, "_plans", "tc-2.yaml"), caseYaml("tc-2", { model: "composer-2.5" }));
  const all = catalog(runs, repo, DEFAULT_MODEL).cases;
  assert.equal(all[0]?.model, DEFAULT_MODEL);
  assert.equal(all[1]?.model, "composer-2.5");
});

it("a case carries its scheduling metadata through catalog", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tcc-")));
  const runs = join(repo, "runs");
  mkdirSync(join(runs, "_plans"), { recursive: true });
  writeFileSync(
    join(runs, "_plans", "tc-1.yaml"),
    caseYaml("tc-1", { parallel: false, tags: ["build", "db"], title: "Shared tree" }),
  );
  const [kase] = catalog(runs, repo, DEFAULT_MODEL).cases;
  assert.equal(kase?.parallel, false);
  assert.deepEqual(kase?.tags, ["build", "db"]);
  assert.equal(kase?.title, "Shared tree");
  assert.equal(kase?.constraint, "tags build, db");
});

it("constraint names each scheduling shape", () => {
  const at = (over: Partial<CaseFile>): string =>
    new Case(spec(over), "/repo/tc-11", "/repo", DEFAULT_MODEL).constraint;
  assert.equal(at({ parallel: true }), "parallel");
  assert.equal(at({ parallel: false, tags: [] }), "exclusive");
  assert.equal(at({ parallel: false, tags: ["db"] }), "tags db");
});

it("parseOnly normalises bare numbers and tolerates stray commas", () => {
  assert.deepEqual([...(parseOnly("27, tc-28, 100 ,") ?? [])].sort(), ["tc-100", "tc-27", "tc-28"]);
  assert.equal(parseOnly(""), null);
  assert.equal(parseOnly(null), null);
});

it("stillEligible re-checks the case file and the folder at dispatch time", () => {
  const { repo, runs } = fixture(["tc-1.yaml"]);
  const [kase] = catalog(runs, repo, DEFAULT_MODEL).cases;
  assert.equal(stillEligible(kase!), true);
  mkdirSync(join(runs, "tc-1"), { recursive: true });
  assert.equal(stillEligible(kase!), false, "a folder appearing mid-run disqualifies the case");
});

it("Case derives repo-relative paths, falling back to absolute when outside the repo", () => {
  const inside = new Case(spec(), "/repo/runs/tc-11", "/repo", DEFAULT_MODEL);
  assert.equal(inside.fileRel, "runs/_plans/tc-11.yaml");
  assert.equal(inside.outRel, "runs/tc-11/");
  assert.equal(inside.tempDir, "/repo/runs/tc-11-temp");
  assert.equal(inside.tempRel, "runs/tc-11-temp/");

  const outside = new Case(
    spec({ name: "tc-1", number: 1, file: "/elsewhere/_plans/tc-1.yaml" }),
    "/elsewhere/tc-1",
    "/repo",
    DEFAULT_MODEL,
  );
  assert.equal(outside.fileRel, "/elsewhere/_plans/tc-1.yaml", "no ../ escapes");
  assert.equal(outside.outRel, "/elsewhere/tc-1/");
});

it("the prompt states the write rule first, then carries the plan verbatim", () => {
  const plan = "# TC-11\n\nDo the thing.\n";
  const kase = new Case(spec({ plan }), "/repo/runs/tc-11", "/repo", DEFAULT_MODEL);
  assert.equal(
    kase.prompt,
    "Perform the test-case plan below. Write every deliverable to runs/tc-11-temp/, " +
      "creating that folder yourself. Do not write to runs/tc-11/ — the harness " +
      "renames the temp folder there only after this run succeeds.\n\n---\n\n" +
      plan,
  );
  assert.ok(kase.prompt.includes("—"), "the dash is an em dash");
  assert.ok(kase.prompt.endsWith(plan), "the plan is the tail, unmodified");
});

it("agentCommand keeps the exact argv order and uses the case model", () => {
  const kase = new Case(
    spec({ name: "tc-1", number: 1, model: "model-x" }),
    "/repo/tc-1",
    "/repo",
    DEFAULT_MODEL,
  );
  assert.deepEqual(agentCommand("/bin/agent", kase), [
    "/bin/agent",
    "-p",
    "--output-format",
    "stream-json",
    "--force",
    "--trust",
    "--workspace",
    "/repo",
    "--model",
    "model-x",
    kase.prompt,
  ]);
});

it("agentCommand for claude-code uses --verbose and --dangerously-skip-permissions, not --workspace", () => {
  const kase = new Case(
    spec({ name: "tc-1", number: 1, agent: "claude-code", model: "sonnet" }),
    "/repo/tc-1",
    "/repo",
    DEFAULT_MODEL,
  );
  const argv = agentCommand("/bin/claude", kase);
  assert.deepEqual(argv.slice(0, -1), [
    "/bin/claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
  ]);
  assert.equal(argv[argv.length - 1], kase.prompt);
  assert.ok(!argv.includes("--workspace"));
});

it("elidedCommand keeps the argv but replaces the plan with its size", () => {
  const plan = "x".repeat(5000);
  const kase = new Case(spec({ plan }), "/repo/runs/tc-11", "/repo", DEFAULT_MODEL);
  const argv = elidedCommand("/bin/agent", kase);
  assert.equal(argv.length, agentCommand("/bin/agent", kase).length);
  const prompt = argv[argv.length - 1]!;
  assert.ok(!prompt.includes(plan), "the plan body is gone");
  assert.ok(prompt.startsWith("Perform the test-case plan below."));
  assert.match(prompt, /…\[\+5,000 chars of plan\]…$/);
});

it("caseNumber takes the first digit run", () => {
  assert.equal(caseNumber("tc-11"), 11);
  assert.equal(caseNumber("tc-007"), 7);
});

it("shellQuote matches shlex.quote", () => {
  assert.equal(shellQuote("plain"), "plain");
  assert.equal(shellQuote("a/b-c_d.e"), "a/b-c_d.e");
  assert.equal(shellQuote(""), "''", "empty string is quoted");
  assert.equal(shellQuote("two words"), "'two words'");
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  assert.equal(shellQuote("em — dash"), "'em — dash'", "non-ASCII is not shell-safe");
  assert.equal(shellJoin(["a", "b c", ""]), "a 'b c' ''");
});
