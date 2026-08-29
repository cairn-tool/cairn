import { describe, it, expect } from "vitest";
import {
  parseMarkdown,
  parseMarkdownWithFrontmatter,
  extractLinks,
  extractHeadings,
  extractCodeBlocks,
  extractTasks,
  extractTables,
  isLineInCodeBlock,
  slugify,
  extractText,
} from "../../src/markdown-ast.js";

describe("parseMarkdown", () => {
  it("returns a Root node", () => {
    const tree = parseMarkdown("# Hello");
    expect(tree.type).toBe("root");
  });
});

describe("slugify", () => {
  it("converts heading text to slug", () => {
    expect(slugify("My Section")).toBe("my-section");
  });

  it("removes special characters", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("uses GitHub's whitespace and hyphen behavior", () => {
    expect(slugify("a - b -- c")).toBe("a---b----c");
    expect(slugify("foo   bar")).toBe("foo---bar");
  });

  it("preserves Unicode characters", () => {
    expect(slugify("Über café 東京")).toBe("über-café-東京");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("extractText", () => {
  it("includes inline code in rendered text", () => {
    const tree = parseMarkdown("### The `Foo` trait");
    expect(extractText(tree.children[0])).toBe("The Foo trait");
  });
});

describe("extractLinks", () => {
  it("extracts links from markdown", () => {
    const tree = parseMarkdown("See [docs](./README.md) here.");
    const links = extractLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      linkText: "docs",
      target: "./README.md",
      isImage: false,
      isExternal: false,
      isAnchorOnly: false,
    });
  });

  it("extracts images", () => {
    const tree = parseMarkdown("![alt text](image.png)");
    const links = extractLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0].isImage).toBe(true);
    expect(links[0].linkText).toBe("alt text");
  });

  it("identifies external URLs", () => {
    const tree = parseMarkdown("[site](https://example.com)");
    const links = extractLinks(tree);
    expect(links[0].isExternal).toBe(true);
  });

  it("recognizes schemes case-insensitively and protocol-relative URLs", () => {
    const links = extractLinks(
      parseMarkdown("[upper](HTTPS://example.com) [relative](//example.com/path)"),
    );
    expect(links.every((link) => link.isExternal)).toBe(true);
  });

  it("does not classify Windows drive paths as URI schemes", () => {
    const links = extractLinks(parseMarkdown("[file](C:/docs/readme.md)"));
    expect(links[0].isExternal).toBe(false);
  });

  it("identifies anchor-only links", () => {
    const tree = parseMarkdown("[section](#heading)");
    const links = extractLinks(tree);
    expect(links[0].isAnchorOnly).toBe(true);
  });

  it("does not extract links inside code blocks", () => {
    const content = "```\n[not a link](fake.md)\n```\n\n[real](real.md)";
    const tree = parseMarkdown(content);
    const links = extractLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("real.md");
  });

  it("does not extract links inside inline code", () => {
    const content = "See `[not a link](fake.md)` here.";
    const tree = parseMarkdown(content);
    const links = extractLinks(tree);
    expect(links).toHaveLength(0);
  });

  it("extracts links with bold/italic text", () => {
    const tree = parseMarkdown("[**bold link**](page.md)");
    const links = extractLinks(tree);
    expect(links[0].linkText).toBe("bold link");
  });

  it("preserves document order when mixing links and images", () => {
    const content = "![img](a.png)\n\n[link](b.md)\n\n![img2](c.png)";
    const tree = parseMarkdown(content);
    const links = extractLinks(tree);
    expect(links).toHaveLength(3);
    expect(links[0].target).toBe("a.png");
    expect(links[1].target).toBe("b.md");
    expect(links[2].target).toBe("c.png");
  });

  it("resolves full, collapsed, and shortcut reference links and images", () => {
    const content = [
      "[full][docs] [collapsed][] [shortcut] ![image][asset]",
      "",
      "[docs]: docs.md",
      "[collapsed]: collapsed.md",
      "[shortcut]: shortcut.md",
      "[asset]: image.png",
    ].join("\n");
    const links = extractLinks(parseMarkdown(content), content);
    expect(links.map((link) => [link.target, link.referenceType, link.isImage])).toEqual([
      ["docs.md", "full", false],
      ["collapsed.md", "collapsed", false],
      ["shortcut.md", "shortcut", false],
      ["image.png", "full", true],
    ]);
    expect(links[0].line).toBe(1);
    expect(links[0].destinationLine).toBe(3);
    expect(content.slice(links[0].destinationStart, links[0].destinationEnd)).toBe("docs.md");
  });

  it("ignores an undefined reference-style link", () => {
    expect(extractLinks(parseMarkdown("[not defined][missing]"))).toHaveLength(0);
  });
});

describe("extractHeadings", () => {
  it("extracts headings with depth and slug", () => {
    const content = "# Title\n\n## Section\n\n### Subsection";
    const tree = parseMarkdown(content);
    const headings = extractHeadings(tree);
    expect(headings).toHaveLength(3);
    expect(headings[0]).toMatchObject({ depth: 1, text: "Title", slug: "title" });
    expect(headings[1]).toMatchObject({ depth: 2, text: "Section", slug: "section" });
    expect(headings[2]).toMatchObject({ depth: 3, text: "Subsection", slug: "subsection" });
  });

  it("includes correct line numbers", () => {
    const content = "# Title\n\nSome text\n\n## Section";
    const tree = parseMarkdown(content);
    const headings = extractHeadings(tree);
    expect(headings[0].line).toBe(1);
    expect(headings[1].line).toBe(5);
  });

  it("returns empty array for no headings", () => {
    const tree = parseMarkdown("Just text.\n\nMore text.");
    expect(extractHeadings(tree)).toHaveLength(0);
  });

  it("assigns GitHub suffixes to duplicate headings", () => {
    const headings = extractHeadings(parseMarkdown("# Same\n\n## Same\n\n## Same"));
    expect(headings.map((heading) => heading.slug)).toEqual(["same", "same-1", "same-2"]);
  });

  it("includes inline code in heading text and GitHub slugs", () => {
    const headings = extractHeadings(parseMarkdown("### The `*PRTF` render seam"));
    expect(headings[0]).toMatchObject({
      text: "The *PRTF render seam",
      slug: "the-prtf-render-seam",
    });
  });
});

describe("extractCodeBlocks", () => {
  it("extracts fenced code blocks", () => {
    const content = "# Title\n\n```typescript\nconst x = 1;\n```\n";
    const tree = parseMarkdown(content);
    const blocks = extractCodeBlocks(tree);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("typescript");
    expect(blocks[0].value).toBe("const x = 1;");
  });

  it("handles code blocks with no language", () => {
    const content = "```\nplain code\n```";
    const tree = parseMarkdown(content);
    const blocks = extractCodeBlocks(tree);
    expect(blocks[0].lang).toBeNull();
  });

  it("includes line range", () => {
    const content = "text\n\n```js\na\nb\nc\n```\n";
    const tree = parseMarkdown(content);
    const blocks = extractCodeBlocks(tree);
    expect(blocks[0].line).toBe(3);
    expect(blocks[0].endLine).toBe(7);
  });

  it("captures the fence info string after the language", () => {
    const content = '```ts title="x" cairn:snippet=a.ts#r\nconst x = 1;\n```\n';
    const blocks = extractCodeBlocks(parseMarkdown(content));
    expect(blocks[0].lang).toBe("ts");
    expect(blocks[0].meta).toBe('title="x" cairn:snippet=a.ts#r');
  });

  it("reports null meta for a bare fence and an indented block", () => {
    expect(extractCodeBlocks(parseMarkdown("```js\na\n```\n"))[0].meta).toBeNull();
    expect(extractCodeBlocks(parseMarkdown("    indented\n"))[0].meta).toBeNull();
  });

  it("includes offsets addressing the raw fence span", () => {
    const content = "text\n\n```js\na\n```\n";
    const blocks = extractCodeBlocks(parseMarkdown(content));
    expect(content.slice(blocks[0].start, blocks[0].end)).toBe("```js\na\n```");
  });
});

describe("isLineInCodeBlock", () => {
  it("returns true for lines inside a code block", () => {
    const blocks = [{ line: 3, endLine: 7, lang: "js", value: "" }];
    expect(isLineInCodeBlock(3, blocks)).toBe(true);
    expect(isLineInCodeBlock(5, blocks)).toBe(true);
    expect(isLineInCodeBlock(7, blocks)).toBe(true);
  });

  it("returns false for lines outside code blocks", () => {
    const blocks = [{ line: 3, endLine: 7, lang: "js", value: "" }];
    expect(isLineInCodeBlock(1, blocks)).toBe(false);
    expect(isLineInCodeBlock(8, blocks)).toBe(false);
  });
});

describe("extractTasks", () => {
  it("extracts checked and unchecked tasks", () => {
    const content = "- [x] Done task\n- [ ] Pending task\n- Regular item";
    const tree = parseMarkdown(content);
    const tasks = extractTasks(tree);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ checked: true, text: "Done task" });
    expect(tasks[1]).toMatchObject({ checked: false, text: "Pending task" });
  });

  it("returns empty array when no tasks", () => {
    const tree = parseMarkdown("- Normal item\n- Another item");
    expect(extractTasks(tree)).toHaveLength(0);
  });

  it("includes line numbers", () => {
    const content = "# Title\n\n- [x] First\n- [ ] Second";
    const tree = parseMarkdown(content);
    const tasks = extractTasks(tree);
    expect(tasks[0].line).toBe(3);
    expect(tasks[1].line).toBe(4);
  });

  it("handles nested task items", () => {
    const content = "- [x] Parent\n  - [ ] Child";
    const tree = parseMarkdown(content);
    const tasks = extractTasks(tree);
    expect(tasks).toHaveLength(2);
  });
});

describe("extractTables", () => {
  it("extracts table with headers and data", () => {
    const content = "| Name | Type |\n|------|------|\n| foo  | bar  |\n| baz  | qux  |";
    const tree = parseMarkdown(content);
    const tables = extractTables(tree);
    expect(tables).toHaveLength(1);
    expect(tables[0].columns).toBe(2);
    expect(tables[0].rows).toBe(2);
    expect(tables[0].headers).toEqual(["Name", "Type"]);
    expect(tables[0].data).toEqual([
      ["foo", "bar"],
      ["baz", "qux"],
    ]);
  });

  it("returns empty array when no tables", () => {
    const tree = parseMarkdown("# Just a heading\n\nSome text.");
    expect(extractTables(tree)).toHaveLength(0);
  });

  it("includes line range", () => {
    const content = "text\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
    const tree = parseMarkdown(content);
    const tables = extractTables(tree);
    expect(tables[0].line).toBe(3);
    expect(tables[0].endLine).toBe(5);
  });

  it("captures alignment info", () => {
    const content = "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |";
    const tree = parseMarkdown(content);
    const tables = extractTables(tree);
    expect(tables[0].align).toEqual(["left", "center", "right"]);
  });
});

describe("parseMarkdownWithFrontmatter", () => {
  it("parses yaml frontmatter node", () => {
    const content = "---\ntitle: Test\n---\n\n# Heading";
    const tree = parseMarkdownWithFrontmatter(content);
    const yamlNode = tree.children.find((n) => n.type === "yaml");
    expect(yamlNode).toBeDefined();
    expect((yamlNode as unknown as { value: string }).value).toBe("title: Test");
  });

  it("does not produce yaml node without frontmatter", () => {
    const tree = parseMarkdownWithFrontmatter("# Just a heading");
    const yamlNode = tree.children.find((n) => n.type === "yaml");
    expect(yamlNode).toBeUndefined();
  });
});
