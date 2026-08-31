import { describe, expect, it } from "vitest";
import { fromMarkdown } from "../../src/jira/adf/from-markdown.js";
import { toMarkdown } from "../../src/jira/adf/to-markdown.js";
import { serializeAdf } from "../../src/jira/adf/serialize.js";
import { FIDELITY, MARK_FIDELITY } from "../../src/jira/adf/profile.js";
import type { AdfDocument, AdfNode } from "../../src/jira/adf/types.js";

/**
 * The three round-trip properties.
 *
 * The third is the one that catches a one-directional mapping edit, and it is
 * narrower than "the loop closes for everything": that needs the deferred
 * reversible fidelity mode. What v1 can assert is byte-identity over the
 * documents whose findings are all `exact` — a gate that widens on its own as
 * constructs are promoted out of `approximate`.
 */

const doc = (...content: AdfNode[]): AdfDocument => ({ version: 1, type: "doc", content });
const text = (value: string): AdfNode => ({ type: "text", text: value });
const para = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

/** Exercises every construct with a degradation or an approximation. */
const RICH = `---
title: Notes
---

# Heading

Text with **bold**, _em_, ~~strike~~, \`code\`, a [link](https://e.com "T"), and a ref [r][d].

[d]: https://ref.example.com "RT"

- plain item
- [x] done task
- [ ] todo task

  extra paragraph in the task

> quoted
>
> - [x] task in a quote
>
> ## heading in a quote
>
> | a | b |
> | - | - |
> | 1 | 2 |
>
> ---

1. one

   ## heading in a list item

   > quote in a list item

   ---

| Left | Right |
| :--- | ----: |
| a    |       |

\`\`\`ts
const a = 1;
\`\`\`

Inline image ![alt](https://e.com/i.png) inside a paragraph.

<div>raw html block</div>

Footnote ref[^1].

[^1]: The footnote body.
`;

describe("determinism", () => {
  it("converts identically on repeated runs, in both directions", () => {
    const first = fromMarkdown(RICH);
    const second = fromMarkdown(RICH);
    expect(serializeAdf(first.document)).toBe(serializeAdf(second.document));
    expect(first.diagnostics).toEqual(second.diagnostics);

    const back = toMarkdown(first.document);
    expect(toMarkdown(second.document).markdown).toBe(back.markdown);
  });

  it("does not depend on the host timezone", () => {
    // `date` renders in UTC. If it read the host zone, this would differ between
    // a developer machine and CI.
    const original = process.env.TZ;
    const render = (): string =>
      toMarkdown(doc(para({ type: "date", attrs: { timestamp: "1700000000000" } }))).markdown;
    try {
      process.env.TZ = "UTC";
      const utc = render();
      process.env.TZ = "Pacific/Kiritimati";
      expect(render()).toBe(utc);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("idempotence, not identity", () => {
  it("stabilizes from the second pass rather than reproducing the input", () => {
    // The first pass moves bytes: the serializer normalizes emphasis markers,
    // heading style, and list markers. Asserting identity here would be
    // asserting the wrong thing and would produce a test nobody can keep green.
    const first = toMarkdown(fromMarkdown(RICH).document).markdown;
    const second = toMarkdown(fromMarkdown(first).document).markdown;
    const third = toMarkdown(fromMarkdown(second).document).markdown;
    expect(second).toBe(third);
  });

  it("stabilizes the ADF too", () => {
    const once = fromMarkdown(RICH).document;
    const twice = fromMarkdown(toMarkdown(once).markdown).document;
    const thrice = fromMarkdown(toMarkdown(twice).markdown).document;
    expect(serializeAdf(thrice)).toBe(serializeAdf(twice));
  });

  it("keeps emitting valid documents across passes", () => {
    // A degradation that produced illegal ADF on a later pass would be invisible
    // to a single-pass test.
    let markdown = RICH;
    for (let pass = 0; pass < 3; pass++) {
      const result = fromMarkdown(markdown);
      const illegal = result.diagnostics.filter((item) => item.severity === "error");
      expect(illegal, `pass ${pass} produced errors`).toEqual([]);
      markdown = toMarkdown(result.document).markdown;
    }
  });
});

describe("byte identity over the lossless subset", () => {
  /**
   * Documents built only from constructs both directions rate `exact`.
   *
   * Each must survive ADF to Markdown to ADF with byte-identical output after
   * canonicalization. This is the `agent upgrade` precedent, which renders
   * before and after and refuses when byte-identity stops holding.
   */
  const LOSSLESS: Array<[string, AdfDocument]> = [
    ["paragraph", doc(para(text("plain")))],
    ["heading", doc({ type: "heading", attrs: { level: 3 }, content: [text("T")] })],
    ["strong", doc(para({ ...text("b"), marks: [{ type: "strong" }] }))],
    ["em", doc(para({ ...text("i"), marks: [{ type: "em" }] }))],
    ["strike", doc(para({ ...text("s"), marks: [{ type: "strike" }] }))],
    ["inline code", doc(para({ ...text("c"), marks: [{ type: "code" }] }))],
    [
      "link",
      doc(para({ ...text("a"), marks: [{ type: "link", attrs: { href: "https://e.com" } }] })),
    ],
    ["rule", doc({ type: "rule" })],
    [
      "code block",
      doc({ type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] }),
    ],
    ["blockquote", doc({ type: "blockquote", content: [para(text("quoted"))] })],
    [
      "bullet list",
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [para(text("one"))] },
          { type: "listItem", content: [para(text("two"))] },
        ],
      }),
    ],
    [
      "nested list",
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              para(text("outer")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [para(text("inner"))] }],
              },
            ],
          },
        ],
      }),
    ],
    ["hard break", doc(para(text("a"), { type: "hardBreak" }, text("b")))],
  ];

  for (const [label, document] of LOSSLESS)
    it(`closes the loop for ${label}`, () => {
      const forward = toMarkdown(document);
      // The premise: this document really is lossless in the first direction.
      expect(
        forward.diagnostics.filter((item) => item.quality !== "exact"),
        `${label} is not actually lossless`,
      ).toEqual([]);

      const back = fromMarkdown(forward.markdown);
      expect(
        back.diagnostics.filter((item) => item.quality !== "exact"),
        `${label} is not lossless in reverse`,
      ).toEqual([]);
      expect(serializeAdf(back.document)).toBe(serializeAdf(document));
    });

  it("covers a meaningful share of the exact constructs", () => {
    // Guards the list above: silently shrinking it would make this suite pass
    // while checking almost nothing.
    const exactNodes = Object.entries(FIDELITY).filter(([, r]) => r.quality === "exact").length;
    const exactMarks = Object.entries(MARK_FIDELITY).filter(
      ([, r]) => r.quality === "exact",
    ).length;
    expect(LOSSLESS.length).toBeGreaterThanOrEqual(exactMarks);
    expect(exactNodes).toBeGreaterThan(8);
  });
});

describe("declared one-directional mappings", () => {
  /**
   * Two mappings deliberately do not survive a round trip. They are asserted
   * here so that the asymmetry is a recorded decision rather than a surprise the
   * byte-identity gate above reports as a mystery.
   */
  it("a footnote becomes superscript text, which Markdown cannot carry back", () => {
    const forward = fromMarkdown("ref[^1]\n\n[^1]: body");
    const marker = forward.document.content?.[0].content?.[1];
    expect(marker?.marks).toEqual([{ type: "subsup", attrs: { type: "sup" } }]);

    // Coming back, `subsup` has no Markdown form, so the marker is plain text.
    const back = toMarkdown(forward.document);
    expect(back.diagnostics.some((item) => item.node === "subsup")).toBe(true);
    expect(back.markdown).toContain("ref1");
  });

  it("a downgraded task list keeps its state visible but not reversible", () => {
    const forward = fromMarkdown("> - [x] done");
    const markdown = toMarkdown(forward.document).markdown;
    // Escaped rather than re-parsed as a checkbox: an unescaped bracket at the
    // start of a list item would silently become a task item again.
    expect(markdown).toContain("\\[x]");
    expect(markdown).not.toContain("- [x]");
  });
});
