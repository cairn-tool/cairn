import type { MappingQuality } from "../../mapping-quality.js";

/**
 * The ADF content model, and what to emit when Markdown asks for something it
 * forbids.
 *
 * This is data, and the converters read it rather than branching on node type,
 * for the same reason `src/agent/render.ts` reads `src/agent/targets/*.ts`
 * instead of branching on the target: the legality question has one answer per
 * (parent, child) pair, and a branch is where the answers drift apart.
 *
 * Every entry below was probed against `@atlaskit/adf-schema`'s published JSON
 * Schema rather than transcribed from prose, and
 * `tests/unit/jira-adf-profile.test.ts` re-probes all of it on every run. That test
 * is the reason this file may be trusted; without it the tables are assertions
 * about someone else's format with nothing checking them.
 *
 * Deliberately not derived from the schema at runtime: deriving would trade a
 * small authored table for a parser against someone else's schema structure,
 * which a restructure breaks and the agreement test would have survived.
 */

/** Inline nodes, legal wherever a parent accepts inline content. */
export const INLINE_NODES = new Set([
  "text",
  "hardBreak",
  "emoji",
  "mention",
  "date",
  "status",
  "inlineCard",
  "placeholder",
  "mediaInline",
  "inlineExtension",
]);

/** Marks this tool recognizes. Anything else reports `AD101`. */
export const MARKS = new Set([
  "strong",
  "em",
  "code",
  "strike",
  "underline",
  "subsup",
  "link",
  "textColor",
  "backgroundColor",
  "alignment",
  "indentation",
  "breakout",
  "border",
  "annotation",
  "dataConsumer",
  "fragment",
]);

/** Closed enum in the schema: an unlisted value is invalid ADF, not an unknown. */
export const PANEL_TYPES = new Set([
  "info",
  "note",
  "tip",
  "warning",
  "error",
  "success",
  "custom",
]);

export interface ContentRule {
  /**
   * Legal child types. `"inline"` means the inline set above; `"text"` means
   * bare text nodes carrying no marks, which is `codeBlock` only.
   */
  children: readonly string[] | "inline" | "text";
  /** Minimum children valid ADF requires. */
  minimum: 0 | 1;
  /** Maximum, where the schema imposes one. */
  maximum?: number;
}

/**
 * Every block container, with its verified legal children.
 *
 * Note `doc` has `minimum: 0` — an empty document is valid ADF, so no filler
 * paragraph is needed there. `listItem`, `tableCell`, `tableHeader`, `table`,
 * `tableRow`, and the lists all require content, and an empty GFM table cell is
 * ordinary Markdown, so the filler rules below are load-bearing rather than
 * defensive.
 */
export const CONTENT_MODEL: Readonly<Record<string, ContentRule>> = {
  doc: { children: BLOCKS(), minimum: 0 },
  paragraph: { children: "inline", minimum: 0 },
  heading: { children: "inline", minimum: 0 },
  codeBlock: { children: "text", minimum: 0 },
  rule: { children: [], minimum: 0 },
  blockquote: {
    children: ["paragraph", "codeBlock", "bulletList", "orderedList", "mediaSingle", "mediaGroup"],
    minimum: 1,
  },
  bulletList: { children: ["listItem"], minimum: 1 },
  orderedList: { children: ["listItem"], minimum: 1 },
  listItem: {
    children: ["paragraph", "codeBlock", "bulletList", "orderedList", "mediaSingle", "taskList"],
    minimum: 1,
  },
  table: { children: ["tableRow"], minimum: 1 },
  // A row with no cells is valid ADF, unlike a table with no rows or a cell
  // with no blocks. Probed, not assumed.
  tableRow: { children: ["tableCell", "tableHeader"], minimum: 0 },
  tableCell: { children: CELL_BLOCKS(), minimum: 1 },
  tableHeader: { children: CELL_BLOCKS(), minimum: 1 },
  panel: {
    children: [
      "paragraph",
      "heading",
      "codeBlock",
      "rule",
      "bulletList",
      "orderedList",
      "mediaSingle",
      "mediaGroup",
      "taskList",
      "decisionList",
    ],
    minimum: 1,
  },
  expand: {
    children: BLOCKS()
      .filter((type) => type !== "expand")
      .concat("nestedExpand"),
    minimum: 1,
  },
  nestedExpand: { children: CELL_BLOCKS().filter((t) => t !== "nestedExpand"), minimum: 1 },
  taskList: { children: ["taskItem", "taskList"], minimum: 1 },
  taskItem: { children: "inline", minimum: 0 },
  decisionList: { children: ["decisionItem"], minimum: 1 },
  decisionItem: { children: "inline", minimum: 0 },
  mediaSingle: { children: ["media"], minimum: 1, maximum: 1 },
  mediaGroup: { children: ["media"], minimum: 1 },
  media: { children: [], minimum: 0 },
};

/** Top-level block set. A function so the two callers cannot share an array. */
function BLOCKS(): string[] {
  return [
    "paragraph",
    "heading",
    "codeBlock",
    "rule",
    "blockquote",
    "bulletList",
    "orderedList",
    "panel",
    "table",
    "mediaSingle",
    "mediaGroup",
    "taskList",
    "decisionList",
    "expand",
  ];
}

/** What a table cell accepts: the block set minus `table`, plus `nestedExpand`. */
function CELL_BLOCKS(): string[] {
  return BLOCKS()
    .filter((type) => type !== "table" && type !== "expand")
    .concat("nestedExpand");
}

/**
 * What to emit when Markdown nests something ADF forbids.
 *
 * Only three parents can arise from Markdown. A GFM table cell holds inline
 * content only, so `tableCell` never receives an illegal block from this
 * direction, and `panel`, `expand`, and `decisionList` have no mdast
 * counterpart at all — which is why this table is far shorter than the set of
 * illegal pairs in the content model.
 */
export type Degradation =
  /** Becomes a paragraph whose text carries the `strong` mark. */
  | "strong-paragraph"
  /** The child's own children are lifted into the parent in place. */
  | "unwrap"
  /** One paragraph per table row, cells joined with a pipe. */
  | "rows-as-paragraphs"
  /** Carries no content of its own, so nothing is lost by omitting it. */
  | "drop"
  /** Block content collapsed to inline, separated by `hardBreak`. */
  | "inline-flatten"
  /**
   * A `taskList` becomes a `bulletList`, each item's text keeping a literal
   * `[x] ` or `[ ] ` prefix so the state stays visible to a reader. It is not
   * reversible: converting back escapes the bracket, because an unescaped one
   * would silently become a task item again.
   */
  | "list-downgrade";

export interface DegradationRule {
  parent: string;
  child: string;
  action: Degradation;
  quality: MappingQuality;
}

export const DEGRADATIONS: readonly DegradationRule[] = [
  { parent: "listItem", child: "heading", action: "strong-paragraph", quality: "approximate" },
  { parent: "listItem", child: "blockquote", action: "unwrap", quality: "approximate" },
  { parent: "listItem", child: "table", action: "rows-as-paragraphs", quality: "approximate" },
  { parent: "listItem", child: "rule", action: "drop", quality: "unsupported" },
  { parent: "blockquote", child: "heading", action: "strong-paragraph", quality: "approximate" },
  { parent: "blockquote", child: "blockquote", action: "unwrap", quality: "approximate" },
  { parent: "blockquote", child: "table", action: "rows-as-paragraphs", quality: "approximate" },
  { parent: "blockquote", child: "rule", action: "drop", quality: "unsupported" },
  { parent: "blockquote", child: "taskList", action: "list-downgrade", quality: "approximate" },
  { parent: "taskItem", child: "*", action: "inline-flatten", quality: "approximate" },
];

export function degradationFor(parent: string, child: string): DegradationRule | undefined {
  return (
    DEGRADATIONS.find((rule) => rule.parent === parent && rule.child === child) ??
    DEGRADATIONS.find((rule) => rule.parent === parent && rule.child === "*")
  );
}

/** True when `child` may appear directly inside `parent`. */
export function accepts(parent: string, child: string): boolean {
  const rule = CONTENT_MODEL[parent];
  if (!rule) return false;
  if (rule.children === "inline") return INLINE_NODES.has(child);
  if (rule.children === "text") return child === "text";
  return rule.children.includes(child);
}

/**
 * How each ADF construct survives the trip to Markdown.
 *
 * Read by `jira adf inspect` to answer "what will this cost me" before converting,
 * and by `to-markdown` to pick the diagnostic. A type absent from this table is
 * genuinely unknown to the tool and reports `AD100` rather than being dropped
 * quietly.
 */
export const FIDELITY: Readonly<Record<string, { quality: MappingQuality; note: string }>> = {
  doc: { quality: "exact", note: "The document root." },
  paragraph: { quality: "exact", note: "A paragraph." },
  text: { quality: "exact", note: "Text, with its marks mapped separately." },
  heading: { quality: "exact", note: "An ATX heading of the same level." },
  hardBreak: { quality: "exact", note: "A hard line break." },
  rule: { quality: "exact", note: "A thematic break." },
  blockquote: { quality: "exact", note: "A block quote." },
  bulletList: { quality: "exact", note: "An unordered list." },
  orderedList: { quality: "exact", note: "An ordered list, keeping its start number." },
  listItem: { quality: "exact", note: "A list item." },
  codeBlock: { quality: "exact", note: "A fenced code block, keeping its language." },
  table: { quality: "approximate", note: "A GFM table. Cell blocks and spans flatten." },
  tableRow: { quality: "approximate", note: "A GFM table row." },
  tableCell: { quality: "approximate", note: "A GFM cell; block content flattens to inline." },
  tableHeader: { quality: "approximate", note: "A GFM header cell." },
  taskList: { quality: "approximate", note: "A GFM task list; localId is not represented." },
  taskItem: { quality: "approximate", note: "A GFM checkbox item." },
  panel: { quality: "approximate", note: "A block quote led by the panel type." },
  expand: { quality: "approximate", note: "A bold title, then the body." },
  nestedExpand: { quality: "approximate", note: "A bold title, then the body." },
  mediaSingle: { quality: "approximate", note: "An image, or a link when the media has no URL." },
  mediaGroup: { quality: "approximate", note: "A list of media links." },
  media: {
    quality: "approximate",
    note: "External media becomes an image; a file becomes a link.",
  },
  mediaInline: { quality: "approximate", note: "A link carrying the attachment id." },
  decisionList: { quality: "approximate", note: "A list; decision state is not represented." },
  decisionItem: { quality: "approximate", note: "A list item." },
  layoutSection: { quality: "approximate", note: "Columns collapse into sequential blocks." },
  layoutColumn: { quality: "approximate", note: "Column content, in order." },
  inlineCard: { quality: "approximate", note: "A link to the card URL." },
  blockCard: { quality: "approximate", note: "A link to the card URL." },
  embedCard: { quality: "approximate", note: "A link to the embedded URL." },
  mention: { quality: "approximate", note: "The mention text; the account id is not represented." },
  emoji: { quality: "approximate", note: "The emoji character, or its short name." },
  status: { quality: "approximate", note: "Inline code; the colour is not represented." },
  date: { quality: "approximate", note: "An ISO-8601 UTC date." },
  placeholder: { quality: "unsupported", note: "Editor-only hint text; nothing is emitted." },
  extension: { quality: "unsupported", note: "Macro content has no Markdown form." },
  bodiedExtension: { quality: "unsupported", note: "Macro content has no Markdown form." },
  inlineExtension: { quality: "unsupported", note: "Macro content has no Markdown form." },
  multiBodiedExtension: { quality: "unsupported", note: "Macro content has no Markdown form." },
  extensionFrame: { quality: "unsupported", note: "Macro content has no Markdown form." },
};

/** How each mark survives the trip to Markdown. */
export const MARK_FIDELITY: Readonly<Record<string, { quality: MappingQuality; note: string }>> = {
  strong: { quality: "exact", note: "Strong emphasis." },
  em: { quality: "exact", note: "Emphasis." },
  code: { quality: "exact", note: "Inline code." },
  strike: { quality: "exact", note: "GFM strikethrough." },
  link: { quality: "exact", note: "A link, keeping its title." },
  underline: { quality: "unsupported", note: "Markdown has no underline." },
  subsup: { quality: "unsupported", note: "Markdown has no superscript or subscript." },
  textColor: { quality: "unsupported", note: "Markdown carries no colour." },
  backgroundColor: { quality: "unsupported", note: "Markdown carries no colour." },
  alignment: { quality: "unsupported", note: "Markdown carries no block alignment." },
  indentation: { quality: "unsupported", note: "Markdown carries no indentation level." },
  breakout: { quality: "unsupported", note: "A layout hint with no Markdown form." },
  border: { quality: "unsupported", note: "A layout hint with no Markdown form." },
  annotation: { quality: "unsupported", note: "Inline comments have no Markdown form." },
  dataConsumer: { quality: "unsupported", note: "A structural mark with no Markdown form." },
  fragment: { quality: "unsupported", note: "A structural mark with no Markdown form." },
};
