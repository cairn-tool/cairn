import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { Workspace } from "../../src/workspace.js";
import { buildContextPack, selectSections, type ContextPack } from "../../src/context.js";
import { documentSections } from "../../src/sections.js";

let tmpDir: string;
let workspace: Workspace;

function write(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function pack(
  seeds: string[],
  overrides: Partial<Parameters<typeof buildContextPack>[0]> = {},
): ContextPack {
  return buildContextPack({
    workspace,
    seeds: seeds.map((file) => ({ file: path.join(tmpDir, file) })),
    files: workspace.markdownFiles(tmpDir),
    depth: 1,
    backlinks: false,
    frontmatter: false,
    budgetBytes: 0,
    path: (file) => path.relative(tmpDir, file),
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-context-")));
  workspace = new Workspace(loadConfig({ disabled: true }, tmpDir));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildContextPack traversal", () => {
  beforeEach(() => {
    write("a.md", "# A\nlead\n\n## A2\nbody\n\nSee [b](./b.md).\n");
    write("b.md", "# B\nbody\n\nSee [c](./c.md).\n");
    write("c.md", "# C\nbody\n");
    write("d.md", "# D\n\nSee [a](./a.md).\n");
  });

  it("emits only the seed at depth 0", () => {
    const result = pack(["a.md"], { depth: 0 });
    expect(result.files).toEqual(["a.md"]);
    expect(result.units.map((unit) => unit.id)).toEqual(["a.md#a", "a.md#a2"]);
  });

  it("follows forward references one hop per depth", () => {
    expect(pack(["a.md"], { depth: 1 }).files).toEqual(["a.md", "b.md"]);
    expect(pack(["a.md"], { depth: 2 }).files).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("follows references backwards only when asked", () => {
    expect(pack(["b.md"], { depth: 1 }).files).toEqual(["b.md", "c.md"]);
    expect(pack(["b.md"], { depth: 1, backlinks: true }).files).toEqual(["b.md", "c.md", "a.md"]);
  });

  it("records provenance, with a backlink's line belonging to the discovered document", () => {
    const result = pack(["b.md"], { depth: 1, backlinks: true });
    const forward = result.units.find((unit) => unit.file === "c.md")!.provenance;
    expect(forward).toMatchObject({ distance: 1, direction: "link", via: "b.md", viaLine: 4 });

    const backward = result.units.find((unit) => unit.file === "a.md")!.provenance;
    expect(backward).toMatchObject({ distance: 1, direction: "backlink", via: "b.md" });
    // Line 7 of a.md is the link to b.md, not a line in b.md.
    expect(backward.viaLine).toBe(7);
    expect(backward.reason).toContain("Links to b.md at line 7");
  });

  it("orders by distance, then discovery, then document order", () => {
    const result = pack(["a.md"], { depth: 2 });
    expect(result.units.map((unit) => unit.id)).toEqual(["a.md#a", "a.md#a2", "b.md#b", "c.md#c"]);
  });

  it("is deterministic across repeated runs", () => {
    const first = pack(["a.md"], { depth: 2, backlinks: true });
    const second = pack(["a.md"], { depth: 2, backlinks: true });
    expect(second.units.map((u) => u.id)).toEqual(first.units.map((u) => u.id));
  });

  it("reports broken dependencies of included documents without failing", () => {
    write("e.md", "# E\n\n[gone](./missing.md)\n");
    const result = pack(["e.md"], { depth: 0 });
    expect(result.broken).toEqual([
      { source: "e.md", target: "./missing.md", resolved: "missing.md", line: 3 },
    ]);
  });
});

describe("buildContextPack budget", () => {
  beforeEach(() => {
    write("a.md", `# One\n${"x".repeat(40)}\n\n# Two\n${"y".repeat(40)}\n\n# Three\nz\n`);
  });

  it("treats 0 as unlimited and reports a token estimate", () => {
    const result = pack(["a.md"], { depth: 0 });
    expect(result.budget.limitBytes).toBeNull();
    expect(result.budget.truncated).toBe(false);
    expect(result.budget.tokenEstimate).toBe(Math.ceil(result.budget.usedBytes / 4));
  });

  it("keeps a prefix of the ordered units and omits the rest", () => {
    const result = pack(["a.md"], { depth: 0, budgetBytes: 60 });
    expect(result.units.map((unit) => unit.heading)).toEqual(["One"]);
    expect(result.omitted.map((unit) => unit.heading)).toEqual(["Two", "Three"]);
    expect(result.budget.truncated).toBe(true);
    expect(result.budget.usedBytes).toBeLessThanOrEqual(60);
  });

  it("never splits a unit, and stops rather than skipping past an oversized one", () => {
    // "Three" would fit in the remaining budget, but the pack is a prefix: once
    // a unit is dropped, everything after it is too.
    const result = pack(["a.md"], { depth: 0, budgetBytes: 60 });
    expect(result.omitted.map((unit) => unit.heading)).toContain("Three");
    expect(result.budget.omittedBytes).toBe(
      result.omitted.reduce((total, unit) => total + unit.bytes, 0),
    );
  });

  it("counts UTF-8 bytes rather than characters", () => {
    write("u.md", "# Héllo ✅\n");
    const result = pack(["u.md"], { depth: 0 });
    expect(result.budget.usedBytes).toBe(Buffer.byteLength("# Héllo ✅\n", "utf8"));
    expect(result.budget.usedBytes).toBeGreaterThan("# Héllo ✅\n".length);
  });
});

describe("buildContextPack units", () => {
  it("emits frontmatter as its own unit only when asked, and never as a heading", () => {
    write("f.md", "---\ntitle: X\n---\n# Real\nbody\n");
    expect(pack(["f.md"], { depth: 0 }).units.map((unit) => unit.id)).toEqual(["f.md#real"]);

    const withFrontmatter = pack(["f.md"], { depth: 0, frontmatter: true });
    expect(withFrontmatter.units.map((unit) => unit.kind)).toEqual(["frontmatter", "section"]);
    expect(withFrontmatter.units[0].content).toBe("---\ntitle: X\n---");
  });

  it("emits pre-heading content as a preamble unit", () => {
    write("p.md", "intro text\n\n# Real\nbody\n");
    const result = pack(["p.md"], { depth: 0 });
    expect(result.units.map((unit) => [unit.kind, unit.id])).toEqual([
      ["preamble", "p.md#preamble"],
      ["section", "p.md#real"],
    ]);
  });

  it("keeps units disjoint, so a parent never repeats a child's bytes", () => {
    const content = "# One\na\n\n## Two\nb\n";
    write("n.md", content);
    const result = pack(["n.md"], { depth: 0 });
    expect(result.units[0].content).not.toContain("## Two");
    // Units are line slices, so rejoining them takes the line separator back.
    expect(result.units.map((unit) => unit.content).join("\n")).toBe(content);
    // The budget counts unit content only, so those separators are not charged.
    expect(result.budget.usedBytes).toBe(
      result.units.reduce((total, unit) => total + unit.bytes, 0),
    );
    expect(result.budget.usedBytes).toBe(Buffer.byteLength(content, "utf8") - 1);
  });
});

describe("selectSections", () => {
  it("selects one section, or a section and its descendants", () => {
    const file = write("s.md", "# One\na\n\n## Two\nb\n\n### Three\nc\n\n# Four\nd\n");
    const sections = documentSections(workspace.document(file));
    expect(selectSections(sections, "Two", false)).toEqual([1]);
    expect(selectSections(sections, "Two", true)).toEqual([1, 2]);
    expect(selectSections(sections, "One", true)).toEqual([0, 1, 2]);
    expect(selectSections(sections, "missing", true)).toEqual([]);
  });
});
