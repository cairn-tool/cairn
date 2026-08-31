import { describe, expect, it } from "vitest";
import { toMarkdown } from "../../src/jira/adf/to-markdown.js";
import { CODES } from "../../src/jira/adf/diagnostics.js";
import type { AdfDocument, AdfMark, AdfNode } from "../../src/jira/adf/types.js";

const doc = (...content: AdfNode[]): AdfDocument => ({ version: 1, type: "doc", content });
const text = (value: string, marks?: AdfMark[]): AdfNode => ({
  type: "text",
  ...(marks ? { marks } : {}),
  text: value,
});
const para = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

/** The Markdown, with the trailing newline trimmed so cases read cleanly. */
function md(document: AdfDocument): string {
  return toMarkdown(document).markdown.trimEnd();
}

function codes(document: AdfDocument): string[] {
  return toMarkdown(document).diagnostics.map((item) => item.code);
}

describe("ADF to Markdown: constructs that survive exactly", () => {
  it("maps headings at every level", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const document = doc({ type: "heading", attrs: { level }, content: [text("T")] });
      expect(md(document)).toBe(`${"#".repeat(level)} T`);
      expect(codes(document)).toEqual([]);
    }
  });

  it("falls back to level 1 for an out-of-range heading", () => {
    expect(md(doc({ type: "heading", attrs: { level: 9 }, content: [text("T")] }))).toBe("# T");
  });

  it("maps the four exact marks and links", () => {
    expect(md(doc(para(text("a", [{ type: "strong" }]))))).toBe("**a**");
    expect(md(doc(para(text("a", [{ type: "em" }]))))).toBe("_a_");
    expect(md(doc(para(text("a", [{ type: "strike" }]))))).toBe("~~a~~");
    expect(md(doc(para(text("a", [{ type: "code" }]))))).toBe("`a`");
    expect(
      md(doc(para(text("a", [{ type: "link", attrs: { href: "https://e.com", title: "T" } }])))),
    ).toBe('[a](https://e.com "T")');
    expect(codes(doc(para(text("a", [{ type: "strong" }]))))).toEqual([]);
  });

  it("nests marks in a fixed order regardless of the order ADF lists them", () => {
    const forward = doc(para(text("a", [{ type: "strong" }, { type: "em" }])));
    const reversed = doc(para(text("a", [{ type: "em" }, { type: "strong" }])));
    // Identical input content must produce identical bytes; the nesting order is
    // fixed by MARK_ORDER, not by the order the marks happen to appear in.
    expect(md(forward)).toBe(md(reversed));
    expect(md(forward)).toBe("**_a_**");
  });

  it("keeps a code block's language and content verbatim", () => {
    const document = doc({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [text("const a = 1;")],
    });
    expect(md(document)).toBe("```typescript\nconst a = 1;\n```");
    expect(codes(document)).toEqual([]);
  });

  it("keeps an ordered list's start number", () => {
    const item = { type: "listItem", content: [para(text("x"))] };
    expect(md(doc({ type: "orderedList", attrs: { order: 4 }, content: [item] }))).toBe("4. x");
    expect(md(doc({ type: "orderedList", attrs: { order: 1 }, content: [item] }))).toBe("1. x");
  });

  it("maps hard breaks and rules", () => {
    expect(md(doc(para(text("a"), { type: "hardBreak" }, text("b"))))).toBe("a\\\nb");
    expect(md(doc({ type: "rule" }))).toBe("---");
  });

  it("drops an empty text node rather than emitting an empty string", () => {
    expect(md(doc(para(text(""), text("a"))))).toBe("a");
  });
});

describe("ADF to Markdown: approximations", () => {
  it("leads a panel with its type in bold", () => {
    const document = doc({
      type: "panel",
      attrs: { panelType: "warning" },
      content: [para(text("careful"))],
    });
    expect(md(document)).toBe("> **Warning**\n>\n> careful");
    expect(codes(document)).toContain(CODES.panelApproximated);
  });

  it("falls back to info for an unlisted panel type", () => {
    const document = doc({
      type: "panel",
      attrs: { panelType: "bogus" },
      content: [para(text("x"))],
    });
    expect(md(document)).toContain("**Info**");
  });

  it("renders an expand as a bold title followed by its body", () => {
    const document = doc({
      type: "expand",
      attrs: { title: "Details" },
      content: [para(text("body"))],
    });
    expect(md(document)).toBe("**Details**\n\nbody");
    expect(codes(document)).toContain(CODES.expandApproximated);
  });

  it("maps a task list to GFM checkboxes", () => {
    const document = doc({
      type: "taskList",
      attrs: { localId: "l" },
      content: [
        { type: "taskItem", attrs: { localId: "1", state: "DONE" }, content: [text("a")] },
        { type: "taskItem", attrs: { localId: "2", state: "TODO" }, content: [text("b")] },
      ],
    });
    expect(md(document)).toBe("- [x] a\n- [ ] b");
    expect(codes(document)).toContain(CODES.taskListApproximated);
  });

  it("nests a task list under the item that precedes it", () => {
    const document = doc({
      type: "taskList",
      attrs: { localId: "l" },
      content: [
        { type: "taskItem", attrs: { localId: "1", state: "TODO" }, content: [text("outer")] },
        {
          type: "taskList",
          attrs: { localId: "l2" },
          content: [
            { type: "taskItem", attrs: { localId: "2", state: "DONE" }, content: [text("inner")] },
          ],
        },
      ],
    });
    expect(md(document)).toBe("- [ ] outer\n  - [x] inner");
  });

  it("flattens a table cell's blocks into inline content", () => {
    const document = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [para(text("H"))] }],
        },
        {
          type: "tableRow",
          content: [{ type: "tableCell", content: [para(text("one")), para(text("two"))] }],
        },
      ],
    });
    expect(md(document)).toContain("| one two |");
    expect(codes(document)).toContain(CODES.tableFlattened);
  });

  it("reports a cell span even when the content fits", () => {
    const document = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [para(text("a"))] }],
        },
      ],
    });
    expect(codes(document)).toContain(CODES.tableFlattened);
  });

  it("maps external media to an image and an attachment to a link", () => {
    const external = doc({
      type: "mediaSingle",
      content: [
        { type: "media", attrs: { type: "external", url: "https://e.com/i.png", alt: "A" } },
      ],
    });
    expect(md(external)).toBe("![A](https://e.com/i.png)");
    expect(codes(external)).not.toContain(CODES.mediaUnresolvable);

    const attachment = doc({
      type: "mediaSingle",
      content: [{ type: "media", attrs: { type: "file", id: "9f2a", collection: "c" } }],
    });
    // A link, not an image: an image with an unfetchable target renders as a
    // broken-image icon and reads as a converter bug.
    expect(md(attachment)).toBe("[attachment 9f2a](media:9f2a)");
    expect(codes(attachment)).toContain(CODES.mediaUnresolvable);
  });

  it("maps a media group to a list of links", () => {
    const document = doc({
      type: "mediaGroup",
      content: [
        { type: "media", attrs: { type: "file", id: "a", collection: "c" } },
        { type: "media", attrs: { type: "file", id: "b", collection: "c" } },
      ],
    });
    expect(md(document)).toBe("- [attachment a](media:a)\n- [attachment b](media:b)");
  });

  it("renders inline constructs as text or inline code", () => {
    expect(md(doc(para({ type: "mention", attrs: { id: "u1", text: "@bryan" } })))).toBe("@bryan");
    expect(md(doc(para({ type: "mention", attrs: { id: "u1" } })))).toBe("@u1");
    expect(md(doc(para({ type: "emoji", attrs: { shortName: ":smile:" } })))).toBe(":smile:");
    expect(md(doc(para({ type: "status", attrs: { text: "Open" } })))).toBe("`Open`");
    // An autolink, because the link text equals its target.
    expect(md(doc(para({ type: "inlineCard", attrs: { url: "https://e.com" } })))).toBe(
      "<https://e.com>",
    );
  });

  it("renders a date in UTC, never the host timezone", () => {
    // Fixed epoch millis; the output must not depend on TZ.
    const document = doc(para({ type: "date", attrs: { timestamp: "1700000000000" } }));
    expect(md(document)).toBe("2023-11-14");
    expect(codes(document)).toContain(CODES.inlineApproximated);
  });

  it("collapses a column layout into sequential blocks", () => {
    const document = doc({
      type: "layoutSection",
      content: [
        { type: "layoutColumn", content: [para(text("left"))] },
        { type: "layoutColumn", content: [para(text("right"))] },
      ],
    });
    expect(md(document)).toBe("left\n\nright");
    expect(codes(document)).toContain(CODES.layoutCollapsed);
  });

  it("maps a decision list to a plain list", () => {
    const document = doc({
      type: "decisionList",
      attrs: { localId: "d" },
      content: [
        { type: "decisionItem", attrs: { localId: "i", state: "DECIDED" }, content: [text("go")] },
      ],
    });
    expect(md(document)).toBe("- go");
    expect(codes(document)).toContain(CODES.decisionApproximated);
  });

  it("drops an extension and reports it", () => {
    const document = doc({ type: "extension", attrs: { extensionKey: "k" } });
    expect(md(document)).toBe("");
    expect(codes(document)).toContain(CODES.extensionDropped);
  });

  it("drops an unsupported mark but keeps its text", () => {
    const document = doc(para(text("plain", [{ type: "underline" }])));
    expect(md(document)).toBe("plain");
    expect(codes(document)).toContain(CODES.markDropped);
  });
});

describe("ADF to Markdown: unrecognized input", () => {
  it("reports an unknown node type rather than dropping it silently", () => {
    const document = doc({ type: "quantumParagraph", content: [para(text("kept"))] });
    const result = toMarkdown(document);
    expect(result.diagnostics.map((item) => item.code)).toContain(CODES.unknownNode);
    // The children still reach the output: dropping is the one degradation whose
    // result is indistinguishable from success.
    expect(result.markdown.trimEnd()).toBe("kept");
  });

  it("reports an unknown mark", () => {
    const document = doc(para(text("a", [{ type: "sparkle" }])));
    expect(codes(document)).toContain(CODES.unknownMark);
    expect(md(document)).toBe("a");
  });

  it("names the location of a finding", () => {
    const document = doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "panel", attrs: { panelType: "info" }, content: [para(text("x"))] }],
        },
      ],
    });
    const panel = toMarkdown(document).diagnostics.find(
      (item) => item.code === CODES.panelApproximated,
    );
    expect(panel?.location).toBe("doc/bulletList/listItem");
  });

  it("reports each condition once per location rather than once per occurrence", () => {
    const cell = (value: string): AdfNode => ({
      type: "tableCell",
      content: [para(text(value)), para(text("second"))],
    });
    const document = doc({
      type: "table",
      content: [{ type: "tableRow", content: [cell("a"), cell("b"), cell("c")] }],
    });
    const flattened = toMarkdown(document).diagnostics.filter(
      (item) => item.code === CODES.tableFlattened,
    );
    // Three cells, one location, so one finding for the flattening plus the
    // table's own rating — not one per cell.
    expect(flattened.length).toBeLessThanOrEqual(2);
  });
});

describe("ADF to Markdown: determinism", () => {
  it("produces identical bytes for identical input", () => {
    const build = (): AdfDocument =>
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("T")] },
        para(text("a", [{ type: "strong" }, { type: "link", attrs: { href: "https://e.com" } }])),
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [para(text("H"))] }] },
          ],
        },
      );
    expect(md(build())).toBe(md(build()));
    expect(toMarkdown(build()).diagnostics).toEqual(toMarkdown(build()).diagnostics);
  });

  it("sorts diagnostics stably by code then location", () => {
    const document = doc(
      { type: "panel", attrs: { panelType: "info" }, content: [para(text("x"))] },
      { type: "expand", attrs: { title: "T" }, content: [para(text("y"))] },
      para(text("z", [{ type: "underline" }])),
    );
    const emitted = toMarkdown(document).diagnostics.map((item) => item.code);
    expect(emitted).toEqual([...emitted].sort());
  });
});
