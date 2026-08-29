import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyEdits,
  applyPlan,
  buildPlan,
  snapshot,
  temporarySibling,
  type FileSnapshot,
  type PlannedEdit,
} from "../../src/edit-plan.js";

let tmpDir: string;

function write(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function edit(
  file: string,
  start: number,
  end: number,
  expected: string,
  replacement: string,
  rule = "test",
): PlannedEdit {
  return {
    file,
    start,
    end,
    expected,
    replacement,
    value: replacement,
    diagnostic: { rule, line: 1, message: `${rule} fix` },
  };
}

function snapshots(...files: string[]): Map<string, FileSnapshot> {
  return new Map(files.map((file) => [file, snapshot(file)]));
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-edit-")));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("applyEdits", () => {
  it("applies back to front so earlier offsets stay valid", () => {
    expect(
      applyEdits("abcdef", [
        { start: 0, end: 1, value: "AAA" },
        { start: 4, end: 6, value: "Z" },
      ]),
    ).toBe("AAAbcdZ");
  });

  it("handles adjacent edits, insertions, and length changes", () => {
    expect(
      applyEdits("abcd", [
        { start: 1, end: 2, value: "" },
        { start: 2, end: 3, value: "XY" },
      ]),
    ).toBe("aXYd");
    expect(applyEdits("abc", [{ start: 1, end: 1, value: "-" }])).toBe("a-bc");
  });
});

describe("temporarySibling", () => {
  it("allocates an unused sibling path", () => {
    const file = write("a.md", "x");
    const temporary = temporarySibling(file);
    expect(path.dirname(temporary)).toBe(path.dirname(file));
    expect(path.basename(temporary)).toMatch(/^\.a\.md\.cairn-\d+-0\.tmp$/);
  });
});

describe("buildPlan conflicts", () => {
  it("records overlapping edits with both rule names", () => {
    const file = write("a.md", "hello world");
    const plan = buildPlan(
      tmpDir,
      [edit(file, 0, 5, "hello", "HELLO", "alpha"), edit(file, 3, 8, "lo wo", "XXXXX", "beta")],
      snapshots(file),
    );
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ kind: "overlap", file });
    expect(plan.conflicts[0].rules).toEqual(["alpha", "beta"]);
  });

  it("treats two insertions at the same offset as ambiguous", () => {
    const file = write("a.md", "abc");
    const plan = buildPlan(
      tmpDir,
      [edit(file, 1, 1, "", "X", "alpha"), edit(file, 1, 1, "", "Y", "beta")],
      snapshots(file),
    );
    expect(plan.conflicts.map((conflict) => conflict.kind)).toEqual(["overlap"]);
  });

  it("allows adjacent, non-overlapping edits", () => {
    const file = write("a.md", "abcd");
    const plan = buildPlan(
      tmpDir,
      [edit(file, 0, 2, "ab", "X"), edit(file, 2, 4, "cd", "Y")],
      snapshots(file),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.files[0].edits).toHaveLength(2);
  });

  it("rejects a target outside the workspace root", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-out-")));
    try {
      const file = path.join(outside, "a.md");
      fs.writeFileSync(file, "abc");
      const plan = buildPlan(tmpDir, [edit(file, 0, 1, "a", "X")], snapshots(file));
      expect(plan.conflicts[0]).toMatchObject({ kind: "outside-workspace" });
      expect(plan.files).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a target reachable only through a symlinked directory", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-link-")));
    try {
      fs.writeFileSync(path.join(outside, "a.md"), "abc");
      fs.symlinkSync(outside, path.join(tmpDir, "escape"));
      const file = path.join(tmpDir, "escape", "a.md");
      // Lexically inside the root; only realpath reveals the escape.
      const plan = buildPlan(tmpDir, [edit(file, 0, 1, "a", "X")], snapshots(file));
      expect(plan.conflicts[0]).toMatchObject({ kind: "outside-workspace" });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an edit whose expected text does not match", () => {
    const file = write("a.md", "hello");
    const plan = buildPlan(tmpDir, [edit(file, 0, 5, "HELLO", "x")], snapshots(file));
    expect(plan.conflicts[0]).toMatchObject({ kind: "expectation-mismatch" });
  });

  it("never throws, so check and dry-run can report every conflict", () => {
    const file = write("a.md", "hello");
    expect(() => buildPlan(tmpDir, [edit(file, 0, 5, "WRONG", "x")], new Map())).not.toThrow();
  });

  it("sorts files by path and edits by offset", () => {
    const b = write("b.md", "abcd");
    const a = write("a.md", "abcd");
    const plan = buildPlan(
      tmpDir,
      [edit(b, 2, 3, "c", "C"), edit(a, 2, 3, "c", "C"), edit(a, 0, 1, "a", "A")],
      snapshots(a, b),
    );
    expect(plan.files.map((file) => path.basename(file.file))).toEqual(["a.md", "b.md"]);
    expect(plan.files[0].edits.map((item) => item.start)).toEqual([0, 2]);
  });
});

describe("applyPlan", () => {
  it("writes every file in one transaction and preserves mode", () => {
    const a = write("a.md", "hello");
    const b = write("b.md", "world");
    fs.chmodSync(a, 0o600);
    const plan = buildPlan(
      tmpDir,
      [edit(a, 0, 5, "hello", "HELLO"), edit(b, 0, 5, "world", "WORLD")],
      snapshots(a, b),
    );

    const applied = applyPlan(plan);
    expect(applied.edits).toBe(2);
    expect(applied.files.every((file) => file.changed)).toBe(true);
    expect(fs.readFileSync(a, "utf-8")).toBe("HELLO");
    expect(fs.readFileSync(b, "utf-8")).toBe("WORLD");
    expect(fs.statSync(a).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tmpDir).filter((name) => name.includes("cairn-"))).toEqual([]);
  });

  it("refuses to write anything when the plan has a conflict", () => {
    const file = write("a.md", "hello world");
    const plan = buildPlan(
      tmpDir,
      [edit(file, 0, 5, "hello", "HELLO", "alpha"), edit(file, 3, 8, "lo wo", "X", "beta")],
      snapshots(file),
    );
    expect(() => applyPlan(plan)).toThrow(/Refusing to write/);
    expect(fs.readFileSync(file, "utf-8")).toBe("hello world");
    expect(fs.readdirSync(tmpDir)).toEqual(["a.md"]);
  });

  it("aborts without writing when an input changed after planning", () => {
    const a = write("a.md", "hello");
    const b = write("b.md", "world");
    const plan = buildPlan(
      tmpDir,
      [edit(a, 0, 5, "hello", "HELLO"), edit(b, 0, 5, "world", "WORLD")],
      snapshots(a, b),
    );

    fs.writeFileSync(a, "changed underneath");
    expect(() => applyPlan(plan)).toThrow(/changed after the plan was built/);
    // Every file is rechecked before any file is staged, so b is untouched too.
    expect(fs.readFileSync(a, "utf-8")).toBe("changed underneath");
    expect(fs.readFileSync(b, "utf-8")).toBe("world");
    expect(fs.readdirSync(tmpDir).filter((name) => name.includes("cairn-"))).toEqual([]);
  });

  it("rolls committed files back when a later rename fails", () => {
    const a = write("a.md", "hello");
    const b = write("b.md", "world");
    const plan = buildPlan(
      tmpDir,
      [edit(a, 0, 5, "hello", "HELLO"), edit(b, 0, 5, "world", "WORLD")],
      snapshots(a, b),
    );

    const invalidated: string[] = [];
    const realRename = fs.renameSync;
    let renames = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++renames === 2) throw new Error("simulated rename failure");
      return realRename(from as string, to as string);
    });

    expect(() => applyPlan(plan, { invalidate: (file) => invalidated.push(file) })).toThrow(
      /simulated rename failure/,
    );
    vi.restoreAllMocks();

    expect(fs.readFileSync(a, "utf-8")).toBe("hello");
    expect(fs.readFileSync(b, "utf-8")).toBe("world");
    expect(fs.readdirSync(tmpDir).filter((name) => name.includes("cairn-"))).toEqual([]);
    // The rolled-back file must be invalidated too, or a stale cache survives.
    expect(invalidated).toContain(a);
  });

  it("leaves a file untouched when its edits collapse to a no-op", () => {
    const file = write("a.md", "hello");
    const before = fs.statSync(file).mtimeMs;
    const plan = buildPlan(tmpDir, [edit(file, 0, 5, "hello", "hello")], snapshots(file));

    const invalidated: string[] = [];
    const applied = applyPlan(plan, { invalidate: (name) => invalidated.push(name) });
    expect(applied.files[0].changed).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(invalidated).toEqual([]);
  });
});

describe("snapshot", () => {
  it("captures content with a fingerprint", () => {
    const file = write("a.md", "hello");
    const result = snapshot(file);
    expect(result.content).toBe("hello");
    expect(result.fingerprint.size).toBe(5);
  });
});
