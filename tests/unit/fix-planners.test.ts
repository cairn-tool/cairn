import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFix } from "markdownlint";
import { loadConfig } from "../../src/config.js";
import { initializeRuntime, resetRuntime } from "../../src/runtime.js";
import { applyEdits, snapshot, type FileSnapshot } from "../../src/edit-plan.js";
import { resolveLocalPath, splitLocalTarget } from "../../src/link-target.js";
import type { FixerContext } from "../../src/fix/registry.js";
import { tocFixer } from "../../src/fix/toc-fixer.js";
import { canonicalLocalTarget, relativeLinksFixer } from "../../src/fix/relative-links-fixer.js";
import {
  ALLOWED_RULES,
  fixInfoRange,
  markdownlintFixer,
} from "../../src/fix/markdownlint-fixer.js";
import { lintContent, loadMarkdownlintConfig } from "../../src/checkers/markdown-lint.js";

let tmpDir: string;

function write(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function context(): FixerContext {
  const snapshots = new Map<string, FileSnapshot>();
  return {
    root: tmpDir,
    snapshot: (file) => {
      const cached = snapshots.get(file);
      if (cached) return cached;
      const taken = snapshot(file);
      snapshots.set(file, taken);
      return taken;
    },
    toc: { maxDepth: "6", minDepth: "1", ordered: false },
  };
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-fixers-")));
  initializeRuntime(loadConfig({ disabled: true }, tmpDir));
});

afterEach(() => {
  resetRuntime();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("toc fixer", () => {
  const STALE = "# Doc\n\n<!-- cairn:toc:start -->\nold\n<!-- cairn:toc:end -->\n\n## S\n";

  it("edits exactly the marker interior", async () => {
    const file = write("a.md", STALE);
    const result = await tocFixer.plan([file], context());
    expect(result.edits).toHaveLength(1);
    const [edit] = result.edits;
    expect(edit.expected).toBe("\nold\n");
    expect(edit.replacement).toBe("\n- [Doc](#doc)\n  - [S](#s)\n");
    expect(applyEdits(STALE, [edit])).toBe(
      "# Doc\n\n<!-- cairn:toc:start -->\n- [Doc](#doc)\n  - [S](#s)\n<!-- cairn:toc:end -->\n\n## S\n",
    );
  });

  it("produces nothing for a current block or a document with no markers", async () => {
    const current = write(
      "current.md",
      "# Doc\n\n<!-- cairn:toc:start -->\n- [Doc](#doc)\n<!-- cairn:toc:end -->\n",
    );
    const plain = write("plain.md", "# Doc\n\n## S\n");
    const result = await tocFixer.plan([current, plain], context());
    expect(result.edits).toEqual([]);
    expect(result.unfixable).toEqual([]);
  });

  it("reports malformed markers instead of throwing", async () => {
    const file = write(
      "bad.md",
      "# Doc\n<!-- cairn:toc:start -->\n<!-- cairn:toc:start -->\n<!-- cairn:toc:end -->\n",
    );
    const result = await tocFixer.plan([file], context());
    expect(result.edits).toEqual([]);
    expect(result.unfixable[0]).toMatchObject({ rule: "toc", reason: "malformed markers" });
  });

  it("leaves markers inside a fenced code block alone", async () => {
    // A fence documenting the marker syntax is a code sample, not a block to
    // synchronize; writing a table of contents into it would corrupt the docs.
    const file = write(
      "doc.md",
      "# Doc\n\nSyntax:\n\n```markdown\n<!-- cairn:toc:start -->\n<!-- cairn:toc:end -->\n```\n\n## S\n",
    );
    const result = await tocFixer.plan([file], context());
    expect(result.edits).toEqual([]);
    // Not reported either: there is nothing wrong with the document.
    expect(result.unfixable).toEqual([]);
  });

  it("still synchronizes a real block in a document that also documents one", async () => {
    const file = write(
      "doc.md",
      "# Doc\n\n```markdown\n<!-- cairn:toc:start -->\n<!-- cairn:toc:end -->\n```\n\n<!-- cairn:toc:start -->\nold\n<!-- cairn:toc:end -->\n\n## S\n",
    );
    const content = fs.readFileSync(file, "utf-8");
    const result = await tocFixer.plan([file], context());
    expect(result.edits).toHaveLength(1);
    // The edit targets the second, real pair.
    expect(result.edits[0].start).toBeGreaterThan(content.indexOf("```markdown"));
    expect(applyEdits(content, result.edits)).toContain(
      "<!-- cairn:toc:start -->\n- [Doc](#doc)\n  - [S](#s)\n<!-- cairn:toc:end -->",
    );
  });

  it("writes the document's own line ending", async () => {
    const file = write("crlf.md", STALE.replace(/\n/g, "\r\n"));
    const [edit] = (await tocFixer.plan([file], context())).edits;
    expect(edit.replacement).toContain("\r\n");
    expect(edit.replacement).not.toMatch(/[^\r]\n/);
  });
});

describe("relative-links fixer", () => {
  const source = () => path.join(tmpDir, "docs", "a.md");

  const cases: Array<[string, string | undefined]> = [
    // Normalization.
    ["../docs/b.md", "b.md"],
    // `./` is preserved rather than stripped, so this normalizes the double
    // slash and keeps the prefix.
    [".//b.md", "./b.md"],
    ["./sub/../b.md", "./b.md"],
    ["sub\\b.md", "sub/b.md"],
    // Style preserved rather than normalized.
    ["./b.md", undefined],
    ["b.md", undefined],
    ["b%20c.md", undefined],
    ["b c.md", undefined],
    // Suffixes preserved byte for byte.
    ["../docs/b.md#frag", "b.md#frag"],
    ["../docs/b.md?q=1#frag", "b.md?q=1#frag"],
  ];

  it.each(cases)("canonicalizes %s", (input, expected) => {
    expect(canonicalLocalTarget(input, source(), tmpDir)).toBe(expected);
  });

  it("never changes which file a target resolves to", () => {
    for (const [input] of cases) {
      const next = canonicalLocalTarget(input, source(), tmpDir);
      if (!next) continue;
      expect(resolveLocalPath(source(), splitLocalTarget(next).path, tmpDir)).toBe(
        resolveLocalPath(source(), splitLocalTarget(input).path.split("\\").join("/"), tmpDir),
      );
    }
  });

  it("is idempotent", () => {
    for (const [input] of cases) {
      const once = canonicalLocalTarget(input, source(), tmpDir);
      if (!once) continue;
      expect(canonicalLocalTarget(once, source(), tmpDir)).toBeUndefined();
    }
  });

  it("leaves a broken link broken, just canonically spelled", async () => {
    const file = write("docs/a.md", "# A\n\n[x](../docs/missing.md)\n");
    const [edit] = (await relativeLinksFixer.plan([file], context())).edits;
    expect(edit.replacement).toBe("missing.md");
    expect(fs.existsSync(path.join(tmpDir, "docs", "missing.md"))).toBe(false);
  });

  it("skips external, anchor-only, and scheme'd targets", async () => {
    const file = write(
      "docs/a.md",
      "# A\n\n[a](https://example.com)\n[b](#frag)\n[c](mailto:x@example.com)\n",
    );
    expect((await relativeLinksFixer.plan([file], context())).edits).toEqual([]);
  });

  it("edits a shared reference definition only once", async () => {
    const file = write("docs/a.md", "# A\n\n[one][ref] and [two][ref]\n\n[ref]: ../docs/b.md\n");
    const result = await relativeLinksFixer.plan([file], context());
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].replacement).toBe("b.md");
  });

  it("re-escapes parentheses when the original was written escaped", async () => {
    const file = write("docs/a.md", "# A\n\n[x](../docs/b\\(1\\).md)\n");
    const [edit] = (await relativeLinksFixer.plan([file], context())).edits;
    expect(edit.replacement).toBe("b\\(1\\).md");
  });

  it("produces edits whose expected text matches the file", async () => {
    const file = write("docs/a.md", "# A\n\n[x](../docs/b.md)\n");
    const content = fs.readFileSync(file, "utf-8");
    for (const edit of (await relativeLinksFixer.plan([file], context())).edits) {
      expect(content.slice(edit.start, edit.end)).toBe(edit.expected);
    }
  });
});

describe("markdownlint fixer", () => {
  it("maps every allowlisted rule the same way markdownlint's own applyFix does", async () => {
    // The cross-check is the guarantee: a rule whose derived range disagrees
    // with applyFix comes off the allowlist rather than getting a special case.
    const samples: Record<string, string> = {
      MD009: "# H\n\ntrailing   \n",
      MD010: "# H\n\n\ttabbed\n",
      MD012: "# H\n\n\n\ntext\n",
      MD018: "#H\n",
      MD019: "#   H\n",
      MD023: "  # H\n",
      MD027: "> \n>  quoted\n",
      MD030: "-   item\n",
      MD038: "# H\n\n` code `\n",
      MD039: "# H\n\n[ text ](./x.md)\n",
      MD047: "# H\n\nno trailing newline",
    };
    const config = await loadMarkdownlintConfig();
    let checked = 0;

    for (const [rule, content] of Object.entries(samples)) {
      const file = write(`${rule}.md`, content);
      const errors = (await lintContent(file, content, config)).filter(
        (error) => error.ruleNames[0] === rule && error.fixInfo,
      );
      if (!errors.length) continue;

      const edits = (await markdownlintFixer.plan([file], context())).edits.filter(
        (edit) => edit.diagnostic.rule === `markdownlint/${rule}`,
      );
      expect(edits.length, `${rule}: produced no edit`).toBeGreaterThan(0);
      checked++;

      const error = errors[0];
      const lines = content.split("\n");
      const lineNumber = error.fixInfo!.lineNumber ?? error.lineNumber;
      const fixed = applyFix(lines[lineNumber - 1], error.fixInfo!, "\n");
      const ours = applyEdits(content, [edits[0]]).split("\n");
      if (fixed === null) {
        // applyFix deletes the line entirely.
        expect(ours.length).toBeLessThan(lines.length);
      } else {
        expect(ours[lineNumber - 1], `${rule}: range disagrees with applyFix`).toBe(
          fixed.split("\n")[0],
        );
      }
    }

    expect(checked, "no allowlisted rule was exercised").toBeGreaterThan(5);
  });

  it("produces no edit for a rule outside the allowlist", async () => {
    // MD034 offers a fix but turning a bare URL into an autolink changes rendering.
    expect(ALLOWED_RULES.has("MD034")).toBe(false);
    const file = write("a.md", "# H\n\nhttps://example.com\n");
    const edits = (await markdownlintFixer.plan([file], context())).edits;
    expect(edits.some((edit) => edit.diagnostic.rule === "markdownlint/MD034")).toBe(false);
  });

  it("produces edits whose expected text matches the file", async () => {
    const content = "# H\n\ntrailing   \n";
    const file = write("a.md", content);
    const edits = (await markdownlintFixer.plan([file], context())).edits;
    expect(edits.length).toBeGreaterThan(0);
    for (const edit of edits) {
      expect(content.slice(edit.start, edit.end)).toBe(edit.expected);
    }
  });
});

describe("fixInfoRange", () => {
  const content = "alpha\r\nbeta\r\n";
  const starts = [0, 7];

  it("consumes the terminator when deleteCount is -1", () => {
    expect(fixInfoRange(content, starts, 1, { deleteCount: -1 }, "\r\n")).toEqual({
      start: 0,
      end: 7,
      replacement: "",
    });
  });

  it("never lets a range cross into the line terminator", () => {
    // Columns index the terminator-stripped line, so deleting past its end is
    // not representable and must be refused rather than guessed.
    expect(fixInfoRange(content, starts, 1, { editColumn: 1, deleteCount: 5 }, "\r\n")).toEqual({
      start: 0,
      end: 5,
      replacement: "",
    });
    expect(
      fixInfoRange(content, starts, 1, { editColumn: 1, deleteCount: 6 }, "\r\n"),
    ).toBeUndefined();
  });

  it("translates newlines in insertText to the file's line ending", () => {
    expect(
      fixInfoRange(
        content,
        starts,
        1,
        { editColumn: 1, deleteCount: 0, insertText: "x\ny" },
        "\r\n",
      )?.replacement,
    ).toBe("x\r\ny");
  });

  it("returns undefined for a line that does not exist", () => {
    expect(fixInfoRange(content, starts, 9, { editColumn: 1 }, "\n")).toBeUndefined();
  });
});
