import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASELINE_FORMAT,
  applyBaseline,
  buildBaseline,
  readBaseline,
  writeBaseline,
} from "../../src/audit-baseline.js";
import type { Issue } from "../../src/types.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-baseline-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const generator = { name: "@bstockus/cairn", version: "9.9.9" };
const issue = (file: string, line: number, checker: string, message: string): Issue => ({
  file: path.join(root, file),
  line,
  checker,
  message,
});

describe("buildBaseline", () => {
  it("stores workspace-relative paths so a different checkout still matches", () => {
    const document = buildBaseline([issue("docs/a.md", 4, "toc", "stale")], root, generator);
    expect(document.entries).toEqual([
      { checker: "toc", file: "docs/a.md", message: "stale", count: 1 },
    ]);
    expect(document.baselineFormat).toBe(BASELINE_FORMAT);
    expect(document.generator).toEqual(generator);
  });

  it("collapses identical findings into a count", () => {
    const document = buildBaseline(
      [issue("a.md", 1, "katex", "bad"), issue("a.md", 9, "katex", "bad")],
      root,
      generator,
    );
    expect(document.entries).toEqual([
      { checker: "katex", file: "a.md", message: "bad", count: 2 },
    ]);
  });

  it("sorts entries by byte comparison, not locale", () => {
    const document = buildBaseline(
      [
        issue("b.md", 1, "mermaid", "z"),
        issue("a.md", 1, "mermaid", "y"),
        issue("a.md", 1, "katex", "x"),
      ],
      root,
      generator,
    );
    expect(document.entries?.map((entry) => [entry.checker, entry.file])).toEqual([
      ["katex", "a.md"],
      ["mermaid", "a.md"],
      ["mermaid", "b.md"],
    ]);
  });
});

describe("applyBaseline", () => {
  const baselineOf = (findings: Issue[]) => buildBaseline(findings, root, generator);

  it("suppresses a finding whose line moved", () => {
    const document = baselineOf([issue("a.md", 3, "toc", "stale")]);
    const applied = applyBaseline([issue("a.md", 42, "toc", "stale")], document, root);
    expect(applied.kept).toEqual([]);
    expect(applied.suppressed).toBe(1);
    expect(applied.stale).toEqual([]);
  });

  it("reports a second identical finding as a regression", () => {
    const document = baselineOf([issue("a.md", 1, "katex", "bad")]);
    const applied = applyBaseline(
      [issue("a.md", 1, "katex", "bad"), issue("a.md", 7, "katex", "bad")],
      document,
      root,
    );
    expect(applied.suppressed).toBe(1);
    expect(applied.kept).toHaveLength(1);
    expect(applied.kept[0].line).toBe(7);
  });

  it("keeps a finding the baseline never recorded", () => {
    const document = baselineOf([issue("a.md", 1, "toc", "stale")]);
    const applied = applyBaseline([issue("b.md", 1, "toc", "stale")], document, root);
    expect(applied.kept).toHaveLength(1);
    expect(applied.suppressed).toBe(0);
  });

  it("reports an entry that matched nothing as stale with the unmatched count", () => {
    const document = baselineOf([
      issue("a.md", 1, "katex", "bad"),
      issue("a.md", 2, "katex", "bad"),
    ]);
    const applied = applyBaseline([issue("a.md", 1, "katex", "bad")], document, root);
    expect(applied.suppressed).toBe(1);
    expect(applied.stale).toEqual([{ checker: "katex", file: "a.md", message: "bad", count: 1 }]);
  });

  it("suppresses nothing and flags a foreign document rather than guessing", () => {
    const findings = [issue("a.md", 1, "toc", "stale")];
    const applied = applyBaseline(findings, { entries: [] }, root);
    expect(applied.foreign).toBe(true);
    expect(applied.kept).toEqual(findings);
    expect(applied.suppressed).toBe(0);
  });
});

describe("readBaseline", () => {
  it("throws on a missing file", () => {
    expect(() => readBaseline(path.join(root, "nope.json"))).toThrow("does not exist");
  });

  it("throws on invalid JSON and on a non-object document", () => {
    const bad = path.join(root, "bad.json");
    fs.writeFileSync(bad, "{oops");
    expect(() => readBaseline(bad)).toThrow("not valid JSON");
    fs.writeFileSync(bad, "[]");
    expect(() => readBaseline(bad)).toThrow("not a baseline document");
  });

  it("round-trips a written document", () => {
    const file = path.join(root, "nested", "base.json");
    const document = buildBaseline([issue("a.md", 1, "toc", "stale")], root, generator);
    writeBaseline(file, document);
    expect(readBaseline(file)).toEqual(document);
    // Written atomically; no staging file may survive.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["base.json"]);
  });
});
