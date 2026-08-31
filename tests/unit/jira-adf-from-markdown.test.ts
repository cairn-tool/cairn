import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv04 from "ajv-draft-04";
import { CODES } from "../../src/jira/adf/diagnostics.js";
import { fromMarkdown } from "../../src/jira/adf/from-markdown.js";
import type { AdfDocument, AdfNode } from "../../src/jira/adf/types.js";

/**
 * Every case here asserts against Atlassian's published schema as well as
 * against the expected shape.
 *
 * Emitting ADF that a Jira API rejects is the failure mode that matters, and the
 * degradations exist precisely to avoid it — so a test that only checked the
 * shape would pass while shipping documents the API refuses.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validate = new (Ajv04 as unknown as typeof Ajv04.default)({
  strict: false,
  allErrors: true,
}).compile(
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../node_modules/@atlaskit/adf-schema/json-schema/v1/full.json"),
      "utf8",
    ),
  ),
);

function convert(markdown: string): { document: AdfDocument; codes: string[] } {
  const result = fromMarkdown(markdown);
  const ok = validate(result.document);
  if (!ok)
    throw new Error(
      `emitted invalid ADF: ${JSON.stringify(validate.errors?.slice(0, 3))}\n${JSON.stringify(result.document, null, 2)}`,
    );
  return { document: result.document, codes: result.diagnostics.map((item) => item.code) };
}

const top = (markdown: string): AdfNode[] => convert(markdown).document.content ?? [];

describe("Markdown to ADF: constructs that survive exactly", () => {
  it("maps headings, paragraphs, rules, and code blocks", () => {
    expect(top("## T")[0]).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "T" }],
    });
    expect(top("---")[0]).toEqual({ type: "rule" });
    expect(top("```ts\nconst a = 1;\n```")[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;" }],
    });
    expect(convert("## T").codes).toEqual([]);
  });

  it("accumulates nested marks onto one flat text node", () => {
    // mdast nests; ADF keeps marks flat on the text node.
    const node = (top("**_bold em_**")[0].content ?? [])[0];
    expect(node.text).toBe("bold em");
    expect(node.marks?.map((mark) => mark.type).sort()).toEqual(["em", "strong"]);
  });

  it("maps inline code and strikethrough to marks", () => {
    expect((top("`x`")[0].content ?? [])[0].marks).toEqual([{ type: "code" }]);
    expect((top("~~x~~")[0].content ?? [])[0].marks).toEqual([{ type: "strike" }]);
  });

  it("carries a link's href and title", () => {
    const node = (top('[a](https://e.com "T")')[0].content ?? [])[0];
    expect(node.marks).toEqual([{ type: "link", attrs: { href: "https://e.com", title: "T" } }]);
  });

  it("resolves a link reference through its definition", () => {
    const node = (top("[a][d]\n\n[d]: https://e.com")[0].content ?? [])[0];
    expect(node.marks).toEqual([{ type: "link", attrs: { href: "https://e.com" } }]);
    expect(convert("[a][d]\n\n[d]: https://e.com").codes).toEqual([]);
  });

  it("keeps an ordered list's start number and omits the default", () => {
    expect(top("3. x")[0].attrs).toEqual({ order: 3 });
    expect(top("1. x")[0].attrs).toBeUndefined();
  });

  it("maps a task list, deriving every localId", () => {
    const list = top("- [x] a\n- [ ] b")[0];
    expect(list.type).toBe("taskList");
    expect(typeof list.attrs?.localId).toBe("string");
    expect(list.content?.map((item) => item.attrs?.state)).toEqual(["DONE", "TODO"]);
    // Derived from a counter, never random: identical input, identical ids.
    expect(fromMarkdown("- [x] a").document).toEqual(fromMarkdown("- [x] a").document);
  });
});

describe("Markdown to ADF: minimum-content rules", () => {
  it("fills an empty table cell with an empty paragraph", () => {
    // `content: []` in a cell is invalid ADF, and an empty cell is ordinary
    // Markdown, so this filler is load-bearing rather than defensive.
    const table = top("| a |  |\n| - | - |\n| b |  |")[0];
    const headerCells = table.content?.[0].content ?? [];
    expect(headerCells[1].content).toEqual([{ type: "paragraph", content: [] }]);
  });

  it("marks the first row as header cells and the rest as body cells", () => {
    const table = top("| a |\n| - |\n| b |")[0];
    expect(table.content?.[0].content?.[0].type).toBe("tableHeader");
    expect(table.content?.[1].content?.[0].type).toBe("tableCell");
  });

  it("emits an empty document rather than a filler paragraph", () => {
    // Unlike a cell, an empty `doc` is valid ADF, so nothing is invented.
    expect(convert("").document).toEqual({ version: 1, type: "doc", content: [] });
  });

  it("never emits an empty text node", () => {
    const document = convert("a\n\n\nb").document;
    const texts = JSON.stringify(document);
    expect(texts).not.toContain('"text":""');
  });
});

describe("Markdown to ADF: degradations", () => {
  it("flattens a heading in a list item to a bold paragraph in place", () => {
    const item = top("- x\n\n  ## H")[0].content?.[0];
    expect(item?.content?.[1]).toEqual({
      type: "paragraph",
      content: [{ type: "text", marks: [{ type: "strong" }], text: "H" }],
    });
    expect(convert("- x\n\n  ## H").codes).toContain(CODES.headingFlattened);
  });

  it("flattens a heading in a block quote the same way", () => {
    expect(convert("> ## H\n>\n> x").codes).toContain(CODES.headingFlattened);
  });

  it("preserves order rather than lifting the heading out", () => {
    // The whole reason lifting is rejected: promoting the heading would move it
    // past the text that followed it inside the item.
    const item = top("- before\n\n  ## H\n\n  after")[0].content?.[0];
    const texts = (item?.content ?? []).map((block) => block.content?.[0]?.text);
    expect(texts).toEqual(["before", "H", "after"]);
  });

  it("unwraps a block quote inside a list item", () => {
    const item = top("- x\n\n  > quoted")[0].content?.[0];
    expect(item?.content?.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
    expect(convert("- x\n\n  > quoted").codes).toContain(CODES.blockquoteUnwrapped);
  });

  it("turns a table in a list item into one paragraph per row", () => {
    const item = top("- x\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |")[0].content?.[0];
    const rows = (item?.content ?? []).slice(1).map((block) => block.content?.[0]?.text);
    expect(rows).toEqual(["a | b", "1 | 2"]);
    expect(convert("- x\n\n  | a |\n  | - |").codes).toContain(CODES.tableFlattenedToRows);
  });

  it("drops a thematic break where ADF forbids one", () => {
    const item = top("- x\n\n  ---")[0].content?.[0];
    expect(item?.content?.map((block) => block.type)).toEqual(["paragraph"]);
    expect(convert("- x\n\n  ---").codes).toContain(CODES.contentDropped);
  });

  it("merges a nested block quote into one level", () => {
    const quote = top("> a\n>\n> > b")[0];
    expect(quote.type).toBe("blockquote");
    expect(quote.content?.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
    expect(convert("> a\n>\n> > b").codes).toContain(CODES.blockquoteUnwrapped);
  });

  it("downgrades a task list inside a block quote, keeping the state visible", () => {
    const quote = top("> - [x] done")[0];
    expect(quote.content?.[0].type).toBe("bulletList");
    const first = quote.content?.[0].content?.[0].content?.[0].content ?? [];
    expect(first[0].text).toBe("[x] ");
    expect(convert("> - [x] done").codes).toContain(CODES.listSplit);
  });

  it("splits a paragraph around an inline image rather than reordering it", () => {
    const blocks = top("before ![alt](https://e.com/i.png) after");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "mediaSingle", "paragraph"]);
    expect(blocks[0].content?.[0].text).toBe("before");
    expect(blocks[2].content?.[0].text).toBe("after");
    expect(blocks[1].content?.[0]).toEqual({
      type: "media",
      attrs: { type: "external", url: "https://e.com/i.png", alt: "alt" },
    });
    expect(convert("a ![x](https://e.com/i.png) b").codes).toContain(CODES.paragraphSplit);
  });

  it("makes an image inside a table cell a link, since a cell holds one paragraph", () => {
    const cell = top("| a |\n| - |\n| ![x](https://e.com/i.png) |")[0].content?.[1].content?.[0];
    const node = cell?.content?.[0].content?.[0];
    expect(node?.marks).toEqual([{ type: "link", attrs: { href: "https://e.com/i.png" } }]);
  });

  it("preserves raw HTML verbatim in a code block", () => {
    expect(top("<div>x</div>")[0]).toEqual({
      type: "codeBlock",
      content: [{ type: "text", text: "<div>x</div>" }],
    });
    expect(convert("<div>x</div>").codes).toContain(CODES.htmlPreserved);
  });

  it("preserves inline HTML as inline code", () => {
    const node = (top("a <br> b")[0].content ?? [])[1];
    expect(node.marks).toEqual([{ type: "code" }]);
    expect(node.text).toBe("<br>");
  });

  it("drops frontmatter rather than putting it in the body", () => {
    const blocks = top("---\ntitle: T\n---\n\nbody");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph"]);
    expect(blocks[0].content?.[0].text).toBe("body");
    expect(convert("---\ntitle: T\n---\n\nbody").codes).toContain(CODES.frontmatterDropped);
  });

  it("does not mistake frontmatter for a rule and a heading", () => {
    // The trap: under the non-frontmatter parser this yields a thematicBreak
    // plus a level-2 heading reading "title: T", which converts to plausible
    // nonsense rather than going missing.
    const blocks = top("---\ntitle: T\n---\n\nbody");
    expect(blocks.some((block) => block.type === "rule")).toBe(false);
    expect(JSON.stringify(blocks)).not.toContain("title: T");
  });

  it("moves footnote bodies to the end behind a rule", () => {
    const blocks = top("ref[^1]\n\n[^1]: body");
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "rule",
      "paragraph",
      "paragraph",
    ]);
    const marker = blocks[0].content?.[1];
    expect(marker?.marks).toEqual([{ type: "subsup", attrs: { type: "sup" } }]);
    expect(convert("ref[^1]\n\n[^1]: body").codes).toContain(CODES.footnoteApproximated);
  });

  it("drops table alignment and says so", () => {
    expect(convert("| a |\n| :-: |\n| b |").codes).toContain(CODES.alignmentDropped);
    expect(convert("| a |\n| --- |\n| b |").codes).not.toContain(CODES.alignmentDropped);
  });

  it("splits a mixed task and plain list into runs, in place", () => {
    const blocks = top("- plain\n- [x] task\n- plain again");
    expect(blocks.map((block) => block.type)).toEqual(["bulletList", "taskList", "bulletList"]);
    expect(convert("- plain\n- [x] task").codes).toContain(CODES.listSplit);
  });

  it("flattens a multi-block task item into one inline run", () => {
    const item = top("- [x] first\n\n  second")[0].content?.[0];
    expect(item?.content?.map((node) => node.type)).toEqual(["text", "hardBreak", "text"]);
    expect(convert("- [x] first\n\n  second").codes).toContain(CODES.contentDropped);
  });

  it("leaves a dangling reference as literal text", () => {
    // CommonMark resolves this before the converter ever sees it: an
    // unresolved reference is literal text, not a reference node. So there is
    // no dangling-reference diagnostic, because nothing can produce one.
    const node = (top("[a][missing]")[0].content ?? [])[0];
    expect(node.text).toBe("[a][missing]");
    expect(node.marks).toBeUndefined();
    expect(convert("[a][missing]").codes).toEqual([]);
  });
});

describe("Markdown to ADF: determinism", () => {
  const SOURCE = "# T\n\n- [x] a\n- [ ] b\n\n> q\n\n| h |\n| - |\n| c |\n";

  it("produces the same document for the same input", () => {
    expect(fromMarkdown(SOURCE).document).toEqual(fromMarkdown(SOURCE).document);
  });

  it("produces the same diagnostics for the same input", () => {
    expect(fromMarkdown(SOURCE).diagnostics).toEqual(fromMarkdown(SOURCE).diagnostics);
  });

  it("sorts diagnostics by code then location", () => {
    const emitted = fromMarkdown(
      "- x\n\n  ## H\n\n  ---\n\n<div>y</div>\n\n---\ntitle: T\n---\n",
    ).diagnostics;
    const keys = emitted.map((item) => `${item.code} ${item.location ?? ""}`);
    expect(keys).toEqual([...keys].sort());
  });
});
