import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "vitest";
import { caseNameOf, loadCaseFiles } from "../../../src/qa/casefile.js";
import { MAX_PROMPT_BYTES } from "../../../src/qa/config.js";

function plansDir(files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tcf-")));
  const plans = join(root, "_plans");
  mkdirSync(plans, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(plans, name), body);
  return plans;
}

/** The scalar keys of a good tc-24.yaml, so a test can change exactly one of them. */
const GOOD_KEYS: Record<string, string> = {
  id: "id: TC-24",
  name: "name: The Ceiling and RoundingPoint cliffs",
  agent: "agent: cursor",
  model: "model: composer-2.5",
  parallel: "parallel: true",
};

const PLAN_BLOCK = ["plan: |", "  # TC-24", "", "  Do the thing.", ""];

/** A case file built from the good one, with keys replaced, dropped (null), or added. */
function tweak(patch: Record<string, string | null> = {}, extra: string[] = []): string {
  const lines: string[] = [];
  for (const [key, good] of Object.entries(GOOD_KEYS)) {
    if (!(key in patch)) {
      lines.push(good);
      continue;
    }
    const value = patch[key];
    if (typeof value === "string") lines.push(value);
  }
  lines.push(...extra);
  if (!("plan" in patch)) lines.push(...PLAN_BLOCK);
  else if (typeof patch["plan"] === "string") lines.push(patch["plan"]);
  return lines.join("\n");
}

const GOOD = tweak();

const only = (
  plans: string,
): { case_: ReturnType<typeof loadCaseFiles>["cases"][0] | undefined; errors: string[] } => {
  const loaded = loadCaseFiles(plans);
  return { case_: loaded.cases[0], errors: loaded.errors };
};

it("caseNameOf accepts tc-<digits> with either YAML extension", () => {
  assert.equal(caseNameOf("tc-24.yaml"), "tc-24");
  assert.equal(caseNameOf("tc-1.yml"), "tc-1");
  assert.equal(caseNameOf("tc-24.md"), null, "a bare .md is no longer a case");
  assert.equal(caseNameOf("tc-10a.yaml"), null);
  assert.equal(caseNameOf("tc-.yaml"), null);
  assert.equal(caseNameOf("notes.yaml"), null);
});

it("a well-formed case file round-trips every field", () => {
  const { case_, errors } = only(plansDir({ "tc-24.yaml": GOOD }));
  assert.deepEqual(errors, []);
  assert.equal(case_?.name, "tc-24");
  assert.equal(case_?.number, 24);
  assert.equal(case_?.id, "TC-24");
  assert.equal(case_?.title, "The Ceiling and RoundingPoint cliffs");
  assert.equal(case_?.agent, "cursor");
  assert.equal(case_?.model, "composer-2.5");
  assert.equal(case_?.parallel, true);
  assert.deepEqual(case_?.tags, []);
  assert.equal(case_?.plan, "# TC-24\n\nDo the thing.\n", "the block scalar, verbatim");
});

it("the optional keys default, and an absent model defers to --model", () => {
  const minimal = "id: TC-1\nname: A case\nplan: |\n  do it\n";
  const { case_, errors } = only(plansDir({ "tc-1.yaml": minimal }));
  assert.deepEqual(errors, []);
  assert.equal(case_?.agent, "cursor");
  assert.equal(case_?.model, null, 'null means "use the CLI default"');
  assert.equal(case_?.parallel, true);
  assert.deepEqual(case_?.tags, []);
});

it("tags load for a non-parallel case", () => {
  const body = tweak({ parallel: "parallel: false" }, ["tags: [build, db]"]);
  const { case_, errors } = only(plansDir({ "tc-24.yaml": body }));
  assert.deepEqual(errors, []);
  assert.equal(case_?.parallel, false);
  assert.deepEqual(case_?.tags, ["build", "db"]);
});

it("cases come back sorted numerically", () => {
  const files: Record<string, string> = {};
  for (const n of [10, 2, 1, 100]) {
    files[`tc-${n}.yaml`] = `id: TC-${n}\nname: c${n}\nplan: |\n  x\n`;
  }
  assert.deepEqual(
    loadCaseFiles(plansDir(files)).cases.map((c) => c.name),
    ["tc-1", "tc-2", "tc-10", "tc-100"],
  );
});

it("a missing _plans/ loads nothing rather than throwing", () => {
  assert.deepEqual(loadCaseFiles("/definitely/not/here"), { cases: [], errors: [] });
});

const REJECTED: [string, string, RegExp][] = [
  ["a missing id", tweak({ id: null }), /tc-24: `id` must be a string/],
  ["a missing name", tweak({ name: null }), /tc-24: `name` must be a string/],
  ["a missing plan", tweak({ plan: null }), /tc-24: `plan` must be a string/],
  ["an empty name", tweak({ name: 'name: "   "' }), /tc-24: `name` must not be empty/],
  ["a malformed id", tweak({ id: "id: 24" }), /`id` must be a string/],
  ["an id shaped wrong", tweak({ id: "id: TC24" }), /`id` must look like TC-24/],
  [
    "an id for another case",
    tweak({ id: "id: TC-25" }),
    /`id` is TC-25 but the file is named tc-24/,
  ],
  [
    "a non-boolean parallel",
    tweak({ parallel: "parallel: yes please" }),
    /`parallel` must be true or false/,
  ],
  ["an unsupported agent", tweak({ agent: "agent: claude" }), /`agent` must be one of cursor/],
  ["tags that are not a list", tweak({}, ["tags: build"]), /`tags` must be a list of strings/],
  [
    "a non-string tag",
    tweak({ parallel: "parallel: false" }, ["tags: [3]"]),
    /`tags\[0\]` must be a string/,
  ],
  [
    "tags on a parallel case",
    tweak({}, ["tags: [build]"]),
    /only constrains a case with `parallel: false`/,
  ],
  ["an unknown key", tweak({}, ["tag: build"]), /unknown key\(s\): tag/],
  ["a list at the top level", "- a\n- b\n", /expected a YAML mapping/],
];

for (const [what, body, expected] of REJECTED) {
  it(`${what} is rejected`, () => {
    const loaded = loadCaseFiles(plansDir({ "tc-24.yaml": body }));
    assert.deepEqual(loaded.cases, [], "the case is not loaded");
    assert.equal(loaded.errors.length >= 1, true, `expected an error, got ${loaded.errors}`);
    assert.match(loaded.errors.join("\n"), expected);
  });
}

it("a plan too large for the prompt argv is rejected by size", () => {
  const big = "x".repeat(MAX_PROMPT_BYTES + 1);
  const body = `id: TC-1\nname: big\nplan: |\n  ${big}\n`;
  const loaded = loadCaseFiles(plansDir({ "tc-1.yaml": body }));
  assert.deepEqual(loaded.cases, []);
  assert.match(loaded.errors.join("\n"), /`plan` is \d+ bytes; the limit is 262144/);
});

it("every problem in one file is reported, not just the first", () => {
  const body = "id: TC-99\nname: 3\nplan: |\n  x\nnope: 1\n";
  const errors = loadCaseFiles(plansDir({ "tc-1.yaml": body })).errors;
  assert.match(errors.join("\n"), /unknown key\(s\): nope/);
  assert.match(errors.join("\n"), /`name` must be a string/);
  assert.match(errors.join("\n"), /`id` is TC-99 but the file is named tc-1/);
});

it("every broken file is reported, and the good ones still load", () => {
  const loaded = loadCaseFiles(
    plansDir({
      "tc-1.yaml": "id: TC-1\nname: fine\nplan: |\n  x\n",
      "tc-2.yaml": "id: TC-9\nname: wrong id\nplan: |\n  x\n",
      "tc-3.yaml": "name: no id\nplan: |\n  x\n",
    }),
  );
  assert.deepEqual(
    loaded.cases.map((c) => c.name),
    ["tc-1"],
    "the good one survives",
  );
  assert.equal(loaded.errors.length, 2, "both bad ones are reported");
});

it("a YAML syntax error is reported with its position", () => {
  const body = "id: TC-1\nname: a\nplan: |\n  x\n  : : :\nname: dupe\n";
  const errors = loadCaseFiles(plansDir({ "tc-1.yaml": body })).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^tc-1\.yaml: \d+:\d+: /, "file, then line:col");
});

it("a case with both extensions is refused rather than guessed at", () => {
  const body = "id: TC-1\nname: a\nplan: |\n  x\n";
  const loaded = loadCaseFiles(plansDir({ "tc-1.yaml": body, "tc-1.yml": body }));
  assert.deepEqual(
    loaded.cases.map((c) => c.name),
    [],
  );
  assert.match(loaded.errors.join("\n"), /tc-1: both tc-1\.yaml and tc-1\.yml exist; keep one/);
});

it("a fully-keyed case file with a long plan body loads", () => {
  const plans = plansDir({
    "tc-24.yaml": [
      "id: TC-24",
      "name: The Ceiling and RoundingPoint cliffs",
      "agent: cursor",
      "model: composer-2.5",
      "parallel: true",
      "plan: |",
      "  # TC-24 — The XGBoost item shape",
      "",
      "  ## 13. Definition of done",
      "",
      "  Stop.",
      "",
    ].join("\n"),
  });
  const { case_, errors } = only(plans);
  assert.deepEqual(errors, []);
  assert.equal(case_?.id, "TC-24");
  assert.equal(case_?.model, "composer-2.5");
  assert.equal(case_?.parallel, true);
  assert.ok(case_!.plan.startsWith("# TC-24 —"), "the plan body survives the block scalar");
  assert.ok(case_!.plan.includes("## 13. Definition of done"), "all of it, to the last section");
});
