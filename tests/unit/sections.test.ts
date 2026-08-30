import { describe, it, expect } from "vitest";
import { extractHeadings, extractLinks, parseMarkdown } from "../../src/markdown-ast.js";
import { parseFrontmatter, type MarkdownDocument } from "../../src/workspace.js";
import {
  documentSections,
  findSection,
  frontmatterEndLine,
  matchSectionIndex,
} from "../../src/sections.js";
import { nestedValue } from "../../src/object-path.js";

function document(content: string): MarkdownDocument {
  const tree = parseMarkdown(content);
  return {
    path: "/workspace/doc.md",
    content,
    lines: content.split("\n"),
    tree,
    headings: extractHeadings(tree),
    references: extractLinks(tree, content),
    frontmatter: parseFrontmatter(content),
  };
}

describe("frontmatterEndLine", () => {
  it("returns the closing fence line", () => {
    expect(frontmatterEndLine("---\ntitle: X\n---\n# Real\n")).toBe(3);
    expect(frontmatterEndLine("---\na: 1\nb: 2\n---\n\ntext\n")).toBe(4);
  });

  it("handles a document that is only frontmatter", () => {
    expect(frontmatterEndLine("---\ntitle: X\n---")).toBe(3);
  });

  it("returns 0 when there is no frontmatter, or it is unterminated", () => {
    expect(frontmatterEndLine("# Heading\n")).toBe(0);
    expect(frontmatterEndLine("---\ntitle: X\n")).toBe(0);
    expect(frontmatterEndLine("")).toBe(0);
  });

  it("recognises the ... terminator", () => {
    expect(frontmatterEndLine("---\ntitle: X\n...\n# Real\n")).toBe(3);
  });
});

describe("documentSections", () => {
  it("partitions a document without overlap or gaps", () => {
    const content = "intro\n\n# One\na\n\n## Two\nb\n\n# Three\nc\n";
    const sections = documentSections(document(content));
    expect(sections.map((s) => [s.heading?.text ?? null, s.startLine, s.endLine])).toEqual([
      [null, 1, 2],
      ["One", 3, 5],
      ["Two", 6, 8],
      // 11, not 10: a trailing newline yields a final empty line, and the last
      // section owns it. `md section` has always counted lines the same way.
      ["Three", 9, 11],
    ]);
    // Exhaustive and non-overlapping: rejoining reproduces the document exactly.
    expect(sections.map((s) => s.content).join("\n")).toBe(content);
  });

  it("is flat, so a parent never contains its children's bytes", () => {
    const sections = documentSections(document("# One\na\n\n## Two\nb\n"));
    expect(sections[0].content).toBe("# One\na\n");
    expect(sections[0].content).not.toContain("## Two");
  });

  it("omits the preamble when the document opens with a heading", () => {
    const sections = documentSections(document("# One\na\n"));
    expect(sections).toHaveLength(1);
    expect(sections[0].heading?.text).toBe("One");
  });

  it("does not treat frontmatter as a heading or a preamble", () => {
    const content = "---\ntitle: X\n---\n# Real\nbody\n";
    // The parser is frontmatter-aware, so the block is a yaml node rather than
    // the setext h2 a bare `---` underline would otherwise make of it.
    expect(document(content).headings.map((h) => h.text)).toEqual(["Real"]);
    const sections = documentSections(document(content));
    // No preamble either: nothing sits between the closing fence and the first
    // real heading.
    expect(sections.map((s) => s.heading?.text ?? null)).toEqual(["Real"]);
    expect(sections[0].startLine).toBe(4);
  });

  it("emits a preamble that starts after the frontmatter block", () => {
    const sections = documentSections(document("---\ntitle: X\n---\nlead\n\n# Real\n"));
    expect(sections.map((s) => [s.heading?.text ?? null, s.startLine])).toEqual([
      [null, 4],
      ["Real", 6],
    ]);
    expect(sections[0].content).toBe("lead\n");
  });
});

describe("findSection", () => {
  const content = "# One\na\n\n## Two\nb\n\n### Three\nc\n\n# Four\nd\n";

  it("matches by heading text, case-insensitively, or by slug", () => {
    expect(findSection(document(content), "two")?.heading.text).toBe("Two");
    expect(findSection(document(content), "Two")?.heading.text).toBe("Two");
    expect(findSection(document(content), "three")?.heading.text).toBe("Three");
    expect(findSection(document(content), "nope")).toBeUndefined();
  });

  it("extends through deeper headings with children, and stops at any heading without", () => {
    expect(findSection(document(content), "Two", { children: true })?.content).toBe(
      "## Two\nb\n\n### Three\nc\n",
    );
    expect(findSection(document(content), "Two", { children: false })?.content).toBe("## Two\nb\n");
  });

  it("drops the heading line when includeHeading is false", () => {
    const section = findSection(document(content), "Two", { includeHeading: false });
    expect(section?.startLine).toBe(5);
    expect(section?.content).toBe("b\n\n### Three\nc\n");
  });

  it("runs to the end of the document for the last section", () => {
    expect(findSection(document(content), "Four")?.content).toBe("# Four\nd\n");
  });
});

describe("matchSectionIndex", () => {
  it("locates a section in the flat partition", () => {
    const sections = documentSections(document("intro\n\n# One\na\n\n## Two\nb\n"));
    expect(matchSectionIndex(sections, "Two")).toBe(2);
    expect(matchSectionIndex(sections, "missing")).toBe(-1);
  });
});

describe("nestedValue", () => {
  const data = { a: { b: "x" }, list: ["first", "second"], zero: 0 };

  it("resolves a dotted path", () => {
    expect(nestedValue(data, "a.b")).toBe("x");
    expect(nestedValue(data, "zero")).toBe(0);
    expect(nestedValue(data, "a.missing")).toBeUndefined();
    expect(nestedValue(data, "zero.deeper")).toBeUndefined();
  });

  it("indexes into arrays by default and refuses when arrays is false", () => {
    // The two behaviors this preserves are both published: `md frontmatter --key`
    // has always indexed lists, `md query --field frontmatter:<key>` never has.
    expect(nestedValue(data, "list.0")).toBe("first");
    expect(nestedValue(data, "list.0", { arrays: false })).toBeUndefined();
    expect(nestedValue(data, "a.b", { arrays: false })).toBe("x");
  });
});
