import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../../src/agent/parser.js";
import { testHasFindings } from "../../src/commands/agent-test.js";
import type { AgentDiagnostic, Artifact } from "../../src/agent/types.js";
import type { CaseExpectations, RenderedTree } from "../../src/agent/test/index.js";
import {
  TEST_FILE_SCHEMA_VERSION,
  contains,
  countAssertions,
  discoverTestFiles,
  evaluate,
  parseTestFile,
  runTests,
  treeDigest,
} from "../../src/agent/test/index.js";

const bundleRoot = path.resolve(
  fileURLToPath(new URL("../fixtures/agent/testcases/bundle", import.meta.url)),
);

const diagnostic = (severity: AgentDiagnostic["severity"]): AgentDiagnostic => ({
  code: "AB999",
  severity,
  message: "test",
  quality: "exact",
});

function artifact(file: string, content: string, mode = 0o644): Artifact {
  return { path: file, content: Buffer.from(content), mode };
}

function tree(artifacts: Artifact[], diagnostics: AgentDiagnostic[] = []): RenderedTree {
  return { target: "claude-code", profile: "plugin", artifacts, diagnostics };
}

function expectations(partial: Partial<CaseExpectations> = {}): CaseExpectations {
  return {
    paths: { present: [], absent: [] },
    files: [],
    json: [],
    ...partial,
  };
}

function testFile(cases: string): string {
  return `schemaVersion: '${TEST_FILE_SCHEMA_VERSION}'\ncases:\n${cases}`;
}

describe("parseTestFile", () => {
  it("parses a case and defaults its selection to every target and profile", () => {
    const parsed = parseTestFile(testFile("  - name: a case\n"), "tests/a.test.yaml");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0].targets).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "antigravity",
      "opencode",
    ]);
    expect(parsed.cases[0].profiles).toEqual(["plugin", "project"]);
    expect(parsed.cases[0].file).toBe("tests/a.test.yaml");
  });

  it("requires a schemaVersion and refuses one it does not read", () => {
    expect(parseTestFile("cases: []\n", "t.yaml").diagnostics[0].code).toBe("AB700");
    const future = parseTestFile("schemaVersion: '99'\ncases: []\n", "t.yaml");
    expect(future.diagnostics[0].message).toMatch(/Unsupported test schemaVersion '99'/);
  });

  it("reports a malformed case without hiding the others", () => {
    const parsed = parseTestFile(
      testFile("  - name: good\n  - targets: [claude-code]\n  - name: also good\n"),
      "t.yaml",
    );
    expect(parsed.cases.map((item) => item.name)).toEqual(["good", "also good"]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0].code).toBe("AB700");
    expect(parsed.diagnostics[0].severity).toBe("error");
    expect(parsed.diagnostics[0].message).toMatch(/cases\[1\]/);
  });

  it("rejects an unknown key, target, profile, severity, mode, and regular expression", () => {
    const reject = (body: string): string =>
      parseTestFile(testFile(body), "t.yaml").diagnostics[0]?.message ?? "";
    expect(reject("  - name: a\n    nope: 1\n")).toMatch(/Unknown cases\[0\] key: nope/);
    expect(reject("  - name: a\n    targets: [borg]\n")).toMatch(/Unknown cases\[0\].targets/);
    expect(reject("  - name: a\n    profiles: [both]\n")).toMatch(/Unknown cases\[0\].profiles/);
    expect(
      reject("  - name: a\n    expect:\n      diagnostics:\n        maxSeverity: fatal\n"),
    ).toMatch(/maxSeverity must be one of/);
    // Unquoted in YAML a mode is a number, so it fails as "must be a string"
    // before the octal check; the shape check is what catches a quoted one.
    expect(
      reject("  - name: a\n    expect:\n      files:\n        - path: p\n          mode: 644\n"),
    ).toMatch(/mode must be a string/);
    expect(
      reject("  - name: a\n    expect:\n      files:\n        - path: p\n          mode: '755'\n"),
    ).toMatch(/four-digit octal/);
    expect(
      reject(
        "  - name: a\n    expect:\n      files:\n        - path: p\n          matches: ['[']\n",
      ),
    ).toMatch(/invalid pattern/);
  });

  it("refuses a duplicate case name, which --case could not address", () => {
    const parsed = parseTestFile(testFile("  - name: same\n  - name: same\n"), "t.yaml");
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.diagnostics[0].message).toMatch(/Duplicate case name 'same'/);
  });
});

describe("discoverTestFiles", () => {
  it("finds the conventional directory in a stable order", () => {
    expect(discoverTestFiles(bundleRoot).map((file) => path.basename(file))).toEqual([
      "digest.test.yaml",
      "render.test.yaml",
    ]);
  });

  it("returns nothing when a bundle carries no tests directory", () => {
    expect(discoverTestFiles(path.join(bundleRoot, "skills"))).toEqual([]);
  });

  it("throws when an explicit path is missing, so a typo cannot read as 'no tests'", () => {
    expect(() => discoverTestFiles(bundleRoot, "nope")).toThrow(/does not exist/);
  });

  it("accepts an explicit file", () => {
    expect(discoverTestFiles(bundleRoot, "tests/render.test.yaml")).toHaveLength(1);
  });
});

describe("contains", () => {
  it("matches an object subset and an unordered array subset", () => {
    expect(contains({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(contains({ a: [1, 2, 3] }, { a: [3, 1] })).toBe(true);
    expect(contains({ a: [{ n: 1 }, { n: 2 }] }, { a: [{ n: 2 }] })).toBe(true);
  });

  it("rejects a missing key, a changed scalar, and a missing element", () => {
    expect(contains({ a: 1 }, { b: 1 })).toBe(false);
    expect(contains({ a: 1 }, { a: "1" })).toBe(false);
    expect(contains({ a: [1] }, { a: [2] })).toBe(false);
    expect(contains(undefined, { a: 1 })).toBe(false);
  });
});

describe("treeDigest", () => {
  it("is stable, order-independent, and sensitive to path, mode, and content", () => {
    const one = artifact("a.md", "one");
    const two = artifact("b.md", "two");
    const base = treeDigest([one, two]);
    expect(treeDigest([two, one])).toBe(base);
    expect(treeDigest([one, artifact("b.md", "changed")])).not.toBe(base);
    expect(treeDigest([one, artifact("b.md", "two", 0o755)])).not.toBe(base);
    expect(treeDigest([one, artifact("c.md", "two")])).not.toBe(base);
  });
});

describe("evaluate", () => {
  it("passes when every expectation holds", () => {
    expect(
      evaluate(
        expectations({
          paths: { present: ["skills/{name}/SKILL.md"], absent: ["hooks/**"] },
          files: [
            {
              path: "skills/greet/SKILL.md",
              mode: "0644",
              includes: ["hello"],
              excludes: ["goodbye"],
              matches: ["^hel"],
            },
          ],
        }),
        tree([artifact("skills/greet/SKILL.md", "hello")]),
      ),
    ).toEqual([]);
  });

  it("reports a missing path as AB710 and an unexpected one as AB711", () => {
    const failures = evaluate(
      expectations({ paths: { present: ["agents/{name}.md"], absent: ["skills/**"] } }),
      tree([artifact("skills/greet/SKILL.md", "hello")]),
    );
    expect(failures.map((item) => item.code)).toEqual(["AB710", "AB711"]);
    expect(failures[1].actual).toBe("skills/greet/SKILL.md");
  });

  it("reports every unmet file expectation as AB712", () => {
    const failures = evaluate(
      expectations({
        files: [
          {
            path: "skills/greet/SKILL.md",
            mode: "0755",
            includes: ["absent"],
            excludes: ["hello"],
            matches: ["^nope"],
          },
        ],
      }),
      tree([artifact("skills/greet/SKILL.md", "hello")]),
    );
    expect(failures.map((item) => item.assertion)).toEqual([
      "files[0].mode",
      "files[0].includes",
      "files[0].excludes",
      "files[0].matches",
    ]);
    expect(failures.every((item) => item.code === "AB712")).toBe(true);
  });

  it("reports a JSON fragment mismatch as AB713, with the actual value", () => {
    const failures = evaluate(
      expectations({ json: [{ path: "plugin.json", contains: { name: "other", version: "1" } }] }),
      tree([artifact("plugin.json", '{"name":"tested","version":"1"}')]),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe("AB713");
    expect(failures[0].actual).toBe('"tested"');
  });

  it("reports unparsable JSON rather than throwing", () => {
    const failures = evaluate(
      expectations({ json: [{ path: "plugin.json", contains: { name: "tested" } }] }),
      tree([artifact("plugin.json", "not json")]),
    );
    expect(failures[0].actual).toBe("unparsable");
  });

  it("checks diagnostic codes and the severity ceiling as AB714", () => {
    const failures = evaluate(
      expectations({
        diagnostics: { includes: ["AB100"], excludes: ["AB999"], maxSeverity: "notice" },
      }),
      tree([], [diagnostic("warning")]),
    );
    expect(failures.map((item) => item.assertion)).toEqual([
      "diagnostics.includes",
      "diagnostics.excludes",
      "diagnostics.maxSeverity",
    ]);
    expect(failures.every((item) => item.code === "AB714")).toBe(true);
  });

  it("reports a digest mismatch as AB715 carrying both values", () => {
    const one = artifact("a.md", "one");
    const failures = evaluate(
      expectations({ digest: { tree: "0".repeat(64), files: { "a.md": "1".repeat(64) } } }),
      tree([one]),
    );
    expect(failures.map((item) => item.code)).toEqual(["AB715", "AB715"]);
    expect(failures[0].expected).toBe("0".repeat(64));
    expect(failures[0].actual).toBe(treeDigest([one]));
  });

  it("reports a digest for a file that was never rendered", () => {
    const failures = evaluate(
      expectations({ digest: { files: { "gone.md": "0".repeat(64) } } }),
      tree([]),
    );
    expect(failures[0].actual).toBe("not rendered");
  });
});

describe("countAssertions", () => {
  it("counts every stated expectation once", () => {
    expect(
      countAssertions(
        expectations({
          paths: { present: ["a", "b"], absent: ["c"] },
          files: [{ path: "f", mode: "0644", includes: ["x"], excludes: [], matches: ["y"] }],
          json: [{ path: "j", contains: { a: 1, b: 2 } }],
          diagnostics: { includes: ["AB1"], excludes: [], maxSeverity: "warning" },
          digest: { tree: "d", files: { f: "e" } },
        }),
      ),
    ).toBe(12);
  });
});

describe("runTests", () => {
  const options = { targets: [], profiles: ["plugin", "project"] as const, cases: [] };

  it("evaluates the bundle's own tests", () => {
    const { report } = runTests(loadBundle(bundleRoot), {
      ...options,
      profiles: ["plugin", "project"],
    });
    expect(report.counts.failed).toBe(0);
    expect(report.counts.passed).toBe(report.counts.cases);
    expect(report.files).toEqual(["tests/digest.test.yaml", "tests/render.test.yaml"]);
    expect(report.native).toEqual([]);
    expect(report.schemaVersion).toBe(TEST_FILE_SCHEMA_VERSION);
  });

  it("skips a case no selected target reaches, counting no assertions for it", () => {
    const { report, diagnostics } = runTests(loadBundle(bundleRoot), {
      ...options,
      targets: ["codex"],
      profiles: ["plugin", "project"],
    });
    const skipped = report.cases.filter((item) => item.status === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((item) => item.assertions.total === 0)).toBe(true);
    expect(diagnostics.some((item) => item.code === "AB720")).toBe(true);
  });

  it("refuses an unknown --case name rather than selecting nothing", () => {
    expect(() =>
      runTests(loadBundle(bundleRoot), { ...options, profiles: ["plugin"], cases: ["nope"] }),
    ).toThrow(/Unknown --case name/);
  });

  it("warns when a bundle carries no test cases at all", () => {
    const minimal = path.resolve(
      fileURLToPath(new URL("../fixtures/agent/conformance/minimal/bundle", import.meta.url)),
    );
    const { report, diagnostics } = runTests(loadBundle(minimal), {
      ...options,
      profiles: ["plugin", "project"],
    });
    expect(report.counts.cases).toBe(0);
    const warning = diagnostics.find((item) => item.code === "AB701");
    expect(warning?.severity).toBe("warning");
  });

  it("forwards the render diagnostics of the trees it evaluated", () => {
    const { forwarded } = runTests(loadBundle(bundleRoot), {
      ...options,
      profiles: ["plugin", "project"],
    });
    expect(forwarded.some((item) => item.code === "AB302")).toBe(true);
  });
});

describe("testHasFindings", () => {
  it("blocks on an error, and on a warning only under --strict", () => {
    expect(testHasFindings([diagnostic("error")], false)).toBe(true);
    expect(testHasFindings([diagnostic("warning")], false)).toBe(false);
    expect(testHasFindings([diagnostic("warning")], true)).toBe(true);
    expect(testHasFindings([diagnostic("notice")], true)).toBe(false);
    expect(testHasFindings([], true)).toBe(false);
  });
});
