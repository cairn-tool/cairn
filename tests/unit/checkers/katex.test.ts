import { describe, it, expect } from "vitest";
import { checkKatex } from "../../../src/checkers/katex.js";
import type { Issue } from "../../../src/types.js";

describe("checkKatex", () => {
  it("produces no issues for valid inline math", () => {
    const content = "# Test\n\nHere is $x^2 + y^2 = z^2$ math.\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(0);
  });

  it("produces no issues for valid display math", () => {
    const content = "# Test\n\n$$\n\\frac{1}{2}\n$$\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(0);
  });

  it("detects invalid inline math", () => {
    const content = "# Test\n\nHere is $\\invalidcmd$ math.\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(1);
    expect(issues[0].checker).toBe("katex");
    expect(issues[0].message).toContain("Invalid inline math");
    expect(issues[0].line).toBe(3);
  });

  it("detects invalid display math", () => {
    const content = "# Test\n\n$$\n\\badcommand\n$$\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Invalid display math");
    expect(issues[0].line).toBe(3);
  });

  it("handles multi-line display math correctly", () => {
    const content = "# Test\n\n$$\n\\frac{a}{b} + \\frac{c}{d}\n$$\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(0);
  });

  it("skips math inside code blocks", () => {
    const content = "# Test\n\n```\n$\\invalidcmd$\n```\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(0);
  });

  it("does not match escaped dollar signs", () => {
    const content = "# Test\n\nPrice is \\$5.00 and \\$10.00.\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(0);
  });

  it("handles single-line display math", () => {
    const content = "# Test\n\n$$x^2 + y^2$$\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues);
    expect(issues).toHaveLength(0);
  });

  it("expands the project's macros, and reports one it does not define", () => {
    const content = "# Test\n\nThe set $\\RR^3$ and $\\vect{v}$ and $\\nope$.\n";
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues, undefined, {
      macros: { "\\RR": "\\mathbb{R}", "\\vect": "\\mathbf{#1}" },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("\\nope");
  });

  it("does not let one expression's \\gdef reach the next one's check", () => {
    const content = "# Test\n\n$\\gdef\\foo{x}\\foo$ then $\\foo$.\n";
    const macros = { "\\RR": "\\mathbb{R}" };
    const issues: Issue[] = [];
    checkKatex("/tmp/test.md", content, issues, undefined, { macros });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("\\foo");
    expect(macros).toEqual({ "\\RR": "\\mathbb{R}" });
  });
});
