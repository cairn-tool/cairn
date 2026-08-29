import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { Workspace } from "../../src/workspace.js";
import { buildPlan } from "../../src/query/plan.js";
import { executePlan, type QueryResult } from "../../src/query/execute.js";

let tmpDir: string;
let workspace: Workspace;

function write(name: string, content: string): void {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function run(
  kind: string,
  where: string[] = [],
  select: string[] = [],
  groupBy?: string,
): QueryResult {
  const plan = buildPlan({ kind, where, select, ...(groupBy ? { groupBy } : {}) });
  return executePlan(plan, {
    workspace,
    files: workspace.markdownFiles(tmpDir),
    displayPath: (file) => path.relative(tmpDir, file),
  });
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-query-")));
  workspace = new Workspace(loadConfig({ disabled: true }, tmpDir));
  write(
    "a.md",
    "---\nowner: alice\ntags: [api, cli]\ncount: 5\n---\n# A\n\n## Sub\n\n- [ ] one\n- [x] two\n\n[G](./b.md)\n\n```ts\ncode();\n```\n",
  );
  write("b.md", "---\nowner: bob\n---\n## No H1\n\n- [ ] three\n\n[E](https://example.com)\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("predicates", () => {
  it("conjoins repeated --where", () => {
    expect(run("documents", ["has:h1"]).rows.map((r) => r.file)).toEqual(["a.md"]);
    expect(run("documents", ["has:h1", "words>0"]).rows).toHaveLength(1);
    expect(run("documents", ["has:h1", "words>10000"]).rows).toEqual([]);
  });

  it("applies has: uniformly to booleans, counts, and dynamic keys", () => {
    expect(run("documents", ["has:h1"]).rows.map((r) => r.file)).toEqual(["a.md"]);
    expect(run("documents", ["has:tasks"]).rows).toHaveLength(2);
    expect(run("documents", ["has:frontmatter.tags"]).rows.map((r) => r.file)).toEqual(["a.md"]);
    expect(run("documents", ["!has:frontmatter.tags"]).rows.map((r) => r.file)).toEqual(["b.md"]);
  });

  it("makes !has:h1 agree with the missing-h1 shortcut", () => {
    expect(run("documents", ["!has:h1"]).rows.map((r) => r.file)).toEqual(["b.md"]);
  });

  it("resolves links-to on both documents and links", () => {
    const target = path.join(tmpDir, "b.md");
    const documents = buildPlan({ kind: "documents", where: [`links-to:${target}`], select: [] });
    expect(
      executePlan(documents, {
        workspace,
        files: workspace.markdownFiles(tmpDir),
        displayPath: (file) => path.relative(tmpDir, file),
      }).rows.map((r) => r.file),
    ).toEqual(["a.md"]);

    const links = buildPlan({
      kind: "links",
      where: [`links-to:${target}`],
      select: ["file", "linkText"],
    });
    expect(
      executePlan(links, {
        workspace,
        files: workspace.markdownFiles(tmpDir),
        displayPath: (file) => path.relative(tmpDir, file),
      }).rows,
    ).toEqual([{ file: "a.md", linkText: "G" }]);
  });

  it("matches array frontmatter existentially", () => {
    expect(run("documents", ["frontmatter.tags=api"]).rows.map((r) => r.file)).toEqual(["a.md"]);
    expect(run("documents", ["frontmatter.tags=nope"]).rows).toEqual([]);
    // "no element equals" — b.md has no tags at all, so it matches too.
    expect(run("documents", ["frontmatter.tags!=api"]).rows.map((r) => r.file)).toEqual(["b.md"]);
  });

  it("never matches a missing value with =, ~, or an ordering, but does with !=", () => {
    expect(run("documents", ["frontmatter.missing=x"]).rows).toEqual([]);
    expect(run("documents", ["frontmatter.missing~x"]).rows).toEqual([]);
    expect(run("documents", ["frontmatter.count>1"]).rows.map((r) => r.file)).toEqual(["a.md"]);
    expect(run("documents", ["frontmatter.missing!=x"]).rows).toHaveLength(2);
  });

  it("makes ~ case-insensitive and = case-sensitive", () => {
    expect(run("headings", ["text=sub"]).rows).toEqual([]);
    expect(run("headings", ["text~sub"]).rows).toHaveLength(1);
  });

  it("compares numbers as numbers", () => {
    expect(run("headings", ["depth>=2"]).rows.map((r) => r.text)).toEqual(["Sub", "No H1"]);
  });
});

describe("projection", () => {
  it("emits exactly the selected keys, in order", () => {
    const result = run("headings", ["depth=1"], ["slug", "file"]);
    expect(result.fields).toEqual(["slug", "file"]);
    expect(Object.keys(result.rows[0])).toEqual(["slug", "file"]);
  });

  it("emits a dynamic frontmatter field under the token as typed", () => {
    const result = run("tasks", ["status=pending"], ["file", "frontmatter.owner"]);
    expect(result.rows).toEqual([
      { file: "a.md", "frontmatter.owner": "alice" },
      { file: "b.md", "frontmatter.owner": "bob" },
    ]);
  });

  it("renders paths through the display function", () => {
    expect(run("documents").rows.every((row) => !String(row.file).startsWith("/"))).toBe(true);
  });
});

describe("grouping", () => {
  it("groups by a frontmatter key with a matched summary", () => {
    const result = run("tasks", ["status=pending"], [], "frontmatter.owner");
    expect(result.groups?.map((g) => [g.key, g.count])).toEqual([
      ["alice", 1],
      ["bob", 1],
    ]);
    expect(result.matched).toBe(2);
  });

  it("fans out an array key, so group counts can exceed matched", () => {
    const result = run("documents", [], ["file"], "frontmatter.tags");
    expect(result.groups?.map((g) => g.key)).toEqual(["api", "cli", null]);
    const total = result.groups!.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBeGreaterThan(result.matched);
  });

  it("sorts group keys by byte order with missing keys last", () => {
    write("z.md", "---\nowner: Zed\n---\n# Z\n");
    write("y.md", "---\nowner: alice\n---\n# Y\n");
    write("x.md", "# X\n");
    const result = run("documents", [], ["file"], "frontmatter.owner");
    // "Zed" before "alice" is byte order; localeCompare would invert it.
    expect(result.groups?.map((g) => g.key)).toEqual(["Zed", "alice", "bob", null]);
  });
});

describe("entities", () => {
  it("produces rows in file order, then source order", () => {
    expect(run("headings").rows.map((r) => r.text)).toEqual(["A", "Sub", "No H1"]);
  });

  it("exposes code blocks and frontmatter entries as rows", () => {
    expect(run("code-blocks").rows).toEqual([
      { file: "a.md", line: 15, endLine: 17, language: "ts" },
    ]);
    expect(run("frontmatter", ["key=owner"]).rows).toEqual([
      { file: "a.md", key: "owner", value: "alice", type: "string" },
      { file: "b.md", key: "owner", value: "bob", type: "string" },
    ]);
  });

  it("gives tasks both checked and status", () => {
    expect(run("tasks", ["checked=true"]).rows.map((r) => r.text)).toEqual(["two"]);
    expect(run("tasks", ["status=done"]).rows.map((r) => r.text)).toEqual(["two"]);
  });
});
