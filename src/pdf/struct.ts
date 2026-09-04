import { CODES, DiagnosticSink } from "./diagnostics.js";
import type { PdfStructNode } from "./document.js";
import type { PositionedRun } from "./text.js";
import type { Block, BlockKind, InlineSpan, MappingQuality } from "./types.js";

/**
 * How a structure-tree role maps onto a block.
 *
 * Data, deliberately, in the shape `FIDELITY` takes in
 * `src/jira/adf/profile.ts`: a role a reader can look up beats a switch a reader
 * has to trace. `block: null` means the role contributes nesting but emits
 * nothing itself.
 */
export interface RoleMapping {
  block: BlockKind | null;
  quality: MappingQuality;
  /** Heading level, for the roles that fix one. */
  level?: number;
  note: string;
}

export const ROLE_FIDELITY: Record<string, RoleMapping> = {
  Document: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  Part: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  Art: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  Sect: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  Div: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  NonStruct: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  // Real producers mark running heads and page numbers as artifacts, which is
  // why the tagged path gets header and footer removal for free.
  Artifact: { block: null, quality: "exact", note: "Page furniture; dropped, as intended." },

  H1: { block: "heading", quality: "exact", level: 1, note: "A level 1 heading." },
  H2: { block: "heading", quality: "exact", level: 2, note: "A level 2 heading." },
  H3: { block: "heading", quality: "exact", level: 3, note: "A level 3 heading." },
  H4: { block: "heading", quality: "exact", level: 4, note: "A level 4 heading." },
  H5: { block: "heading", quality: "exact", level: 5, note: "A level 5 heading." },
  H6: { block: "heading", quality: "exact", level: 6, note: "A level 6 heading." },
  H: {
    block: "heading",
    quality: "approximate",
    note: "A generic heading; its level is inferred.",
  },
  Title: {
    block: "heading",
    quality: "approximate",
    level: 1,
    note: "Treated as a level 1 heading.",
  },

  P: { block: "paragraph", quality: "exact", note: "A paragraph." },
  L: {
    block: "list",
    quality: "approximate",
    note: "A list; ordered-ness is inferred from its labels.",
  },
  LI: { block: "listItem", quality: "exact", note: "A list item." },
  Lbl: { block: null, quality: "exact", note: "An item label; consumed as the marker." },
  LBody: { block: null, quality: "exact", note: "An item body; its content is the item's." },

  Index: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  Private: { block: null, quality: "exact", note: "A container; contributes nesting only." },
  Aside: { block: null, quality: "exact", note: "A container; contributes nesting only." },

  Table: { block: "table", quality: "exact", note: "A table." },
  // Row groups must be containers, not blocks. Left unmodelled they fall to the
  // AP219 path, which emits one paragraph of everything beneath — collapsing
  // every row of a table head into a single line and losing the table.
  THead: { block: null, quality: "exact", note: "A row group; its rows belong to the table." },
  TBody: { block: null, quality: "exact", note: "A row group; its rows belong to the table." },
  TFoot: { block: null, quality: "exact", note: "A row group; its rows belong to the table." },
  TR: { block: "tableRow", quality: "exact", note: "A table row." },
  TD: { block: "tableCell", quality: "exact", note: "A table cell." },
  TH: { block: "tableCell", quality: "exact", note: "A header cell." },

  BlockQuote: { block: "blockquote", quality: "exact", note: "A block quote." },
  Code: { block: "code", quality: "approximate", note: "A code block; no language is recorded." },
  Caption: {
    block: "caption",
    quality: "approximate",
    note: "A caption, emitted as emphasized text.",
  },
  Figure: { block: "figure", quality: "approximate", note: "A figure; only its text survives." },
  Formula: {
    block: "paragraph",
    quality: "approximate",
    note: "A formula, flattened to its text.",
  },
  TOC: { block: "list", quality: "approximate", note: "A table of contents, flattened to a list." },
  TOCI: { block: "listItem", quality: "approximate", note: "A table-of-contents entry." },

  Span: { block: null, quality: "exact", note: "Inline; folded into the enclosing block." },
  Quote: { block: null, quality: "exact", note: "Inline; folded into the enclosing block." },
  Note: { block: null, quality: "approximate", note: "Inline; folded into the enclosing block." },
  Reference: { block: null, quality: "exact", note: "Inline; folded into the enclosing block." },
  BibEntry: { block: "paragraph", quality: "approximate", note: "A bibliography entry." },
  Link: { block: null, quality: "approximate", note: "Text is kept; the href is not resolved." },
  // Ruby and Warichu annotate East Asian text inline; their bases and
  // annotations flatten into the enclosing block rather than becoming blocks.
  Ruby: { block: null, quality: "approximate", note: "Inline; folded into the enclosing block." },
  RB: { block: null, quality: "exact", note: "Inline; folded into the enclosing block." },
  RT: { block: null, quality: "approximate", note: "Inline; folded into the enclosing block." },
  RP: { block: null, quality: "exact", note: "Inline; folded into the enclosing block." },
  Warichu: {
    block: null,
    quality: "approximate",
    note: "Inline; folded into the enclosing block.",
  },
  WT: { block: null, quality: "exact", note: "Inline; folded into the enclosing block." },
  WP: { block: null, quality: "exact", note: "Inline; folded into the enclosing block." },
  // Interactive elements carry no readable content of their own.
  Form: { block: null, quality: "unsupported", note: "A form field; it carries no text to emit." },
  Annot: { block: null, quality: "unsupported", note: "An annotation; not part of the content." },
};

/** Guards against a malformed tree; the walk is recursive over hostile input. */
const MAX_STRUCT_DEPTH = 128;

function spansFor(runs: PositionedRun[]): InlineSpan[] {
  const ordered = [...runs].sort((a, b) => a.page - b.page || a.index - b.index);
  const spans: InlineSpan[] = [];
  for (const run of ordered) {
    const previous = spans[spans.length - 1];
    // Coalesced before emission, or a paragraph split into forty runs renders as
    // `**a****b****c**`.
    if (previous && previous.bold === run.bold && previous.italic === run.italic) {
      const needsSpace = !/\s$/.test(previous.text) && !/^\s/.test(run.text);
      previous.text += needsSpace ? ` ${run.text}` : run.text;
      continue;
    }
    spans.push({ text: run.text, bold: run.bold, italic: run.italic, code: false });
  }
  return spans;
}

export interface StructResult {
  blocks: Block[];
  /** False when the page's tree carried nothing usable and geometry should run. */
  usable: boolean;
}

/**
 * Converts one page's structure tree into blocks.
 *
 * The pairing is by marked-content id: a `StructTreeContent` leaf's `id` and a
 * `TextMarkedContent` item's `id` are the *same string* (`p5R_mc0`), verified
 * against 6.3.289, and only `beginMarkedContentProps` carries one. `text.ts`
 * has already attributed each run to its innermost id-bearing frame, so this
 * only has to look runs up.
 */
export function blocksFromStruct(
  tree: PdfStructNode | null,
  runs: PositionedRun[],
  sink: DiagnosticSink,
  page: number,
): StructResult {
  if (!tree) return { blocks: [], usable: false };

  const byMcid = new Map<string, PositionedRun[]>();
  for (const run of runs) {
    if (!run.mcid) continue;
    const bucket = byMcid.get(run.mcid);
    if (bucket) bucket.push(run);
    else byMcid.set(run.mcid, [run]);
  }
  if (byMcid.size === 0) return { blocks: [], usable: false };

  const provenance = (quality: MappingQuality, role?: string): Block["provenance"] => ({
    path: "struct",
    quality,
    pages: [page],
    ...(role ? { role } : {}),
  });

  /** Collects every run under a node, in document order. */
  const gather = (node: PdfStructNode, depth: number): PositionedRun[] => {
    if (depth > MAX_STRUCT_DEPTH) return [];
    if (node.type === "content" && node.id) return byMcid.get(node.id) ?? [];
    return (node.children ?? []).flatMap((child) => gather(child, depth + 1));
  };

  const walk = (node: PdfStructNode, depth: number): Block[] => {
    if (depth > MAX_STRUCT_DEPTH) return [];
    const role = node.role;
    if (!role || role === "Root")
      return (node.children ?? []).flatMap((child) => walk(child, depth + 1));

    const mapping = ROLE_FIDELITY[role];
    if (!mapping) {
      // The AD100 analogue, and the non-negotiable one: an unrecognized role
      // reports and emits its text rather than disappearing. Dropping is the one
      // degradation whose output is indistinguishable from success.
      sink.add({
        code: CODES.unknownRole,
        quality: "unsupported",
        message: `Structure role "${role}" is not modelled; its text was emitted as a paragraph`,
        construct: role,
        page,
      });
      const runsHere = gather(node, depth);
      return runsHere.length
        ? [
            {
              kind: "paragraph",
              spans: spansFor(runsHere),
              children: [],
              provenance: provenance("unsupported", role),
            },
          ]
        : [];
    }

    const children = (node.children ?? []).flatMap((child) => walk(child, depth + 1));

    if (mapping.block === null) return children;

    if (mapping.quality === "approximate") noteApproximation(role, sink, page);

    const container =
      mapping.block === "list" ||
      mapping.block === "listItem" ||
      mapping.block === "table" ||
      mapping.block === "tableRow" ||
      mapping.block === "blockquote";

    if (container)
      return [
        {
          kind: mapping.block,
          ...(mapping.block === "list" ? { ordered: false } : {}),
          spans: [],
          children,
          provenance: provenance(mapping.quality, role),
        },
      ];

    const runsHere = gather(node, depth);
    const spans = spansFor(runsHere);
    if (spans.length === 0 && children.length === 0) return [];

    return [
      {
        kind: mapping.block,
        ...(mapping.level ? { level: mapping.level } : {}),
        ...(mapping.block === "tableCell" ? { header: role === "TH" } : {}),
        spans,
        children: mapping.block === "tableCell" ? [] : children,
        provenance: provenance(mapping.quality, role),
      },
    ];
  };

  return { blocks: walk(tree, 0), usable: true };
}

/** One code per approximating role, so a caller learns what a tag cost. */
function noteApproximation(role: string, sink: DiagnosticSink, page: number): void {
  const mapping = ROLE_FIDELITY[role];
  const code =
    role === "H"
      ? CODES.headingLevelInferred
      : role === "L" || role === "TOC"
        ? CODES.listOrderingInferred
        : role === "Figure"
          ? CODES.figureTextOnly
          : null;
  if (!code) return;
  sink.add({ code, quality: "approximate", message: mapping.note, construct: role, page });
}
