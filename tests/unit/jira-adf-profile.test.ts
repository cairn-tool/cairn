import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv04 from "ajv-draft-04";
import {
  CONTENT_MODEL,
  DEGRADATIONS,
  INLINE_NODES,
  MARKS,
  MARK_FIDELITY,
  PANEL_TYPES,
  accepts,
  degradationFor,
  FIDELITY,
} from "../../src/jira/adf/profile.js";
import type { AdfDocument, AdfNode } from "../../src/jira/adf/types.js";

/**
 * The agreement test.
 *
 * `src/adf/profile.ts` states what ADF permits. Atlassian's published JSON
 * Schema is what actually decides. Two artifacts drift only if nothing checks
 * them, so this checks them — in both directions, so the profile can neither
 * claim something illegal is legal nor needlessly degrade something that was
 * legal all along.
 *
 * The schema is a devDependency read only from here. Nothing is vendored,
 * generated, or shipped: `adf validate` reports against the profile, and a node
 * type the profile does not model reports AD100 rather than pretending to be
 * Atlassian's validator.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@atlaskit",
  "adf-schema",
  "json-schema",
  "v1",
  "full.json",
);

// Draft-04, so the draft-2020 instance the contract schemas use cannot compile it.
const ajv = new (Ajv04 as unknown as typeof Ajv04.default)({ strict: false, allErrors: false });
const validateAdf = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));

const text = (value = "x"): AdfNode => ({ type: "text", text: value });
const doc = (...content: AdfNode[]): AdfDocument => ({ version: 1, type: "doc", content });

/** A minimal valid instance of every node type the profile names as a child. */
const SAMPLES: Record<string, () => AdfNode> = {
  paragraph: () => ({ type: "paragraph", content: [text()] }),
  heading: () => ({ type: "heading", attrs: { level: 2 }, content: [text()] }),
  codeBlock: () => ({ type: "codeBlock", content: [text()] }),
  rule: () => ({ type: "rule" }),
  blockquote: () => ({ type: "blockquote", content: [SAMPLES.paragraph()] }),
  bulletList: () => ({ type: "bulletList", content: [SAMPLES.listItem()] }),
  orderedList: () => ({ type: "orderedList", content: [SAMPLES.listItem()] }),
  listItem: () => ({ type: "listItem", content: [SAMPLES.paragraph()] }),
  panel: () => ({ type: "panel", attrs: { panelType: "info" }, content: [SAMPLES.paragraph()] }),
  table: () => ({ type: "table", content: [SAMPLES.tableRow()] }),
  tableRow: () => ({ type: "tableRow", content: [SAMPLES.tableCell()] }),
  tableCell: () => ({ type: "tableCell", content: [SAMPLES.paragraph()] }),
  tableHeader: () => ({ type: "tableHeader", content: [SAMPLES.paragraph()] }),
  mediaSingle: () => ({ type: "mediaSingle", content: [SAMPLES.media()] }),
  mediaGroup: () => ({
    type: "mediaGroup",
    content: [{ type: "media", attrs: { type: "file", id: "a", collection: "c" } }],
  }),
  media: () => ({ type: "media", attrs: { type: "external", url: "https://example.com/i.png" } }),
  taskList: () => ({ type: "taskList", attrs: { localId: "l" }, content: [SAMPLES.taskItem()] }),
  taskItem: () => ({ type: "taskItem", attrs: { localId: "i", state: "TODO" }, content: [text()] }),
  decisionList: () => ({
    type: "decisionList",
    attrs: { localId: "d" },
    content: [SAMPLES.decisionItem()],
  }),
  decisionItem: () => ({
    type: "decisionItem",
    attrs: { localId: "i", state: "DECIDED" },
    content: [text()],
  }),
  expand: () => ({ type: "expand", attrs: { title: "T" }, content: [SAMPLES.paragraph()] }),
  nestedExpand: () => ({
    type: "nestedExpand",
    attrs: { title: "T" },
    content: [SAMPLES.paragraph()],
  }),
  text: () => text(),
  hardBreak: () => ({ type: "hardBreak" }),
  emoji: () => ({ type: "emoji", attrs: { shortName: ":smile:", text: "\u{1F604}" } }),
  mention: () => ({ type: "mention", attrs: { id: "u1", text: "@name" } }),
  date: () => ({ type: "date", attrs: { timestamp: "1700000000000" } }),
  status: () => ({ type: "status", attrs: { text: "Done", color: "green" } }),
  inlineCard: () => ({ type: "inlineCard", attrs: { url: "https://example.com" } }),
  mediaInline: () => ({ type: "mediaInline", attrs: { type: "file", id: "a", collection: "c" } }),
};

/**
 * Wraps children in the shallowest valid document that puts them inside
 * `parent`, so a rejection is attributable to the pair under test.
 */
const WRAPPERS: Record<string, (children: AdfNode[]) => AdfDocument> = {
  doc: (children) => doc(...children),
  paragraph: (children) => doc({ type: "paragraph", content: children }),
  heading: (children) => doc({ type: "heading", attrs: { level: 2 }, content: children }),
  blockquote: (children) => doc({ type: "blockquote", content: children }),
  bulletList: (children) => doc({ type: "bulletList", content: children }),
  orderedList: (children) => doc({ type: "orderedList", content: children }),
  listItem: (children) =>
    doc({ type: "bulletList", content: [{ type: "listItem", content: children }] }),
  table: (children) => doc({ type: "table", content: children }),
  tableRow: (children) =>
    doc({ type: "table", content: [{ type: "tableRow", content: children }] }),
  tableCell: (children) =>
    doc({
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: children }] }],
    }),
  tableHeader: (children) =>
    doc({
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableHeader", content: children }] }],
    }),
  panel: (children) => doc({ type: "panel", attrs: { panelType: "info" }, content: children }),
  expand: (children) => doc({ type: "expand", attrs: { title: "T" }, content: children }),
  nestedExpand: (children) =>
    doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{ type: "nestedExpand", attrs: { title: "T" }, content: children }],
            },
          ],
        },
      ],
    }),
  taskList: (children) => doc({ type: "taskList", attrs: { localId: "l" }, content: children }),
  taskItem: (children) =>
    doc({
      type: "taskList",
      attrs: { localId: "l" },
      content: [{ type: "taskItem", attrs: { localId: "i", state: "TODO" }, content: children }],
    }),
  decisionList: (children) =>
    doc({ type: "decisionList", attrs: { localId: "d" }, content: children }),
  decisionItem: (children) =>
    doc({
      type: "decisionList",
      attrs: { localId: "d" },
      content: [
        { type: "decisionItem", attrs: { localId: "i", state: "DECIDED" }, content: children },
      ],
    }),
  mediaSingle: (children) => doc({ type: "mediaSingle", content: children }),
  mediaGroup: (children) => doc({ type: "mediaGroup", content: children }),
};

/** Parents whose legality the schema can be asked about through a wrapper. */
const PROBEABLE = Object.keys(WRAPPERS).filter((parent) => parent in CONTENT_MODEL);

describe("the ADF content model agrees with @atlaskit/adf-schema", () => {
  it("probes a meaningful number of pairs", () => {
    // Guards the loops themselves: a broken registry would make every
    // assertion below vacuously pass.
    expect(PROBEABLE.length).toBeGreaterThan(15);
    expect(Object.keys(SAMPLES).length).toBeGreaterThan(25);
  });

  it("claims nothing legal that the schema rejects", () => {
    const wrong: string[] = [];
    for (const parent of PROBEABLE) {
      for (const [child, build] of Object.entries(SAMPLES)) {
        if (!accepts(parent, child)) continue;
        if (!validateAdf(WRAPPERS[parent]([build()]))) wrong.push(`${parent} < ${child}`);
      }
    }
    expect(wrong, `profile permits pairs the schema rejects: ${wrong.join(", ")}`).toEqual([]);
  });

  it("degrades nothing that the schema would have accepted", () => {
    const wrong: string[] = [];
    for (const parent of PROBEABLE) {
      for (const [child, build] of Object.entries(SAMPLES)) {
        if (accepts(parent, child)) continue;
        if (validateAdf(WRAPPERS[parent]([build()]))) wrong.push(`${parent} < ${child}`);
      }
    }
    expect(wrong, `profile needlessly forbids legal pairs: ${wrong.join(", ")}`).toEqual([]);
  });

  it("agrees on which containers require content", () => {
    for (const parent of PROBEABLE) {
      const rule = CONTENT_MODEL[parent];
      // `rule` carries no content and has no wrapper that could hold any.
      if (Array.isArray(rule.children) && rule.children.length === 0) continue;
      const empty = validateAdf(WRAPPERS[parent]([]));
      expect(empty, `${parent} empty content: schema says ${empty}`).toBe(rule.minimum === 0);
    }
  });

  it("agrees that mediaSingle holds exactly one media node", () => {
    expect(CONTENT_MODEL.mediaSingle.maximum).toBe(1);
    expect(validateAdf(WRAPPERS.mediaSingle([SAMPLES.media(), SAMPLES.media()]))).toBe(false);
  });

  it("agrees on the panel type enum", () => {
    for (const panelType of PANEL_TYPES)
      expect(
        validateAdf(doc({ type: "panel", attrs: { panelType }, content: [SAMPLES.paragraph()] })),
        `panelType ${panelType}`,
      ).toBe(true);
    expect(
      validateAdf(
        doc({ type: "panel", attrs: { panelType: "nope" }, content: [SAMPLES.paragraph()] }),
      ),
    ).toBe(false);
  });

  it("agrees that a code block's text carries no marks", () => {
    expect(CONTENT_MODEL.codeBlock.children).toBe("text");
    expect(
      validateAdf(
        doc({ type: "codeBlock", content: [{ ...text(), marks: [{ type: "strong" }] }] }),
      ),
    ).toBe(false);
  });

  it("agrees that an empty text node is invalid", () => {
    // Why `from-markdown` must never emit one as filler: an empty paragraph is
    // `content: []`, not a paragraph holding an empty text node.
    expect(validateAdf(doc({ type: "paragraph", content: [text("")] }))).toBe(false);
    expect(validateAdf(doc({ type: "paragraph", content: [] }))).toBe(true);
  });

  it("agrees that mediaInline cannot carry an external URL", () => {
    // The reason an inline Markdown image splits its paragraph around a
    // block-level mediaSingle instead of staying inline.
    expect(
      validateAdf(
        doc({
          type: "paragraph",
          content: [
            { type: "mediaInline", attrs: { type: "external", url: "https://e.com/i.png" } },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("agrees that every recognized mark is a real mark", () => {
    for (const mark of MARKS) {
      if (mark === "dataConsumer" || mark === "fragment" || mark === "annotation") continue;
      const attrs: Record<string, Record<string, unknown>> = {
        subsup: { type: "sup" },
        link: { href: "https://example.com" },
        textColor: { color: "#ff0000" },
        backgroundColor: { color: "#ff0000" },
        alignment: { align: "center" },
        indentation: { level: 1 },
        breakout: { mode: "wide" },
        border: { size: 1, color: "#091e4224" },
      };
      const node: AdfNode = {
        ...text(),
        marks: [attrs[mark] ? { type: mark, attrs: attrs[mark] } : { type: mark }],
      };
      // Block-level marks are not legal on text; only assert the inline ones.
      if (["alignment", "indentation", "breakout", "border"].includes(mark)) continue;
      expect(validateAdf(doc({ type: "paragraph", content: [node] })), `mark ${mark}`).toBe(true);
    }
  });
});

describe("the degradation table is complete", () => {
  /**
   * The pairs `from-markdown` can actually form, derived from mdast's own
   * containment rules rather than from a cartesian product.
   *
   * This is the spec the converter is held to: the ADF children listed for a
   * parent are exactly what a legal walk of an mdast tree can hand it, so each
   * must be either legal ADF or carry a degradation rule. Adding an emitter
   * means adding it here, which forces the decision to be made.
   */
  const BLOCKS_FROM_FLOW = [
    "paragraph",
    "heading",
    "codeBlock",
    "rule",
    "blockquote",
    "bulletList",
    "orderedList",
    "table",
    "mediaSingle",
    "taskList",
  ];
  const POSSIBLE: Record<string, string[]> = {
    // mdast `root`, `blockquote`, and `listItem` all hold the same flow content.
    doc: BLOCKS_FROM_FLOW,
    blockquote: BLOCKS_FROM_FLOW,
    listItem: BLOCKS_FROM_FLOW,
    taskItem: BLOCKS_FROM_FLOW,
    bulletList: ["listItem"],
    orderedList: ["listItem"],
    taskList: ["taskItem", "taskList"],
    table: ["tableRow"],
    tableRow: ["tableCell", "tableHeader"],
    // A GFM cell holds inline content only, so it only ever gets one paragraph.
    tableCell: ["paragraph"],
    tableHeader: ["paragraph"],
    mediaSingle: ["media"],
    paragraph: ["text", "hardBreak"],
    heading: ["text", "hardBreak"],
    codeBlock: ["text"],
  };

  it("covers every pair the Markdown converter can form", () => {
    const uncovered: string[] = [];
    for (const [parent, children] of Object.entries(POSSIBLE))
      for (const child of children)
        if (!accepts(parent, child) && !degradationFor(parent, child))
          uncovered.push(`${parent} < ${child}`);
    expect(uncovered.sort(), "add a degradation rule or an emitter guard for these").toEqual([]);
  });

  it("models only parents the content model knows", () => {
    for (const parent of Object.keys(POSSIBLE))
      expect(CONTENT_MODEL[parent], `unknown parent ${parent}`).toBeDefined();
  });

  it("names only parents and children that exist in the content model", () => {
    for (const rule of DEGRADATIONS) {
      expect(CONTENT_MODEL[rule.parent], `unknown parent ${rule.parent}`).toBeDefined();
      if (rule.child !== "*")
        expect(CONTENT_MODEL[rule.child], `unknown child ${rule.child}`).toBeDefined();
    }
  });

  it("never degrades a pair that is already legal", () => {
    for (const rule of DEGRADATIONS) {
      if (rule.child === "*") continue;
      expect(accepts(rule.parent, rule.child), `${rule.parent} < ${rule.child} is legal`).toBe(
        false,
      );
    }
  });
});

describe("the fidelity tables are complete", () => {
  it("rates every node type the content model names", () => {
    const missing = Object.keys(CONTENT_MODEL).filter((type) => !FIDELITY[type]);
    expect(missing, `add these to FIDELITY: ${missing.join(", ")}`).toEqual([]);
  });

  it("rates every inline node type", () => {
    const missing = [...INLINE_NODES].filter((type) => !FIDELITY[type]);
    expect(missing, `add these to FIDELITY: ${missing.join(", ")}`).toEqual([]);
  });

  it("rates every recognized mark", () => {
    const missing = [...MARKS].filter((type) => !MARK_FIDELITY[type]);
    expect(missing, `add these to MARK_FIDELITY: ${missing.join(", ")}`).toEqual([]);
  });
});
