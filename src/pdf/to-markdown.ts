import type {
  BlockContent,
  Emphasis,
  InlineCode,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
} from "mdast";
import { stringifyMarkdown } from "../markdown-stringify.js";
import { CODES, DiagnosticSink } from "./diagnostics.js";
import type { OpenDocument, PdfStructNode } from "./document.js";
import { blocksFromLayout } from "./layout.js";
import { blocksFromStruct } from "./struct.js";
import { extractPage } from "./text.js";
import type { PageRuns } from "./text.js";
import type { Block, InlineSpan, PdfDiagnostic } from "./types.js";

/** The five Latin ligatures a text layer routinely carries. */
const LIGATURES: Record<string, string> = {
  ﬀ: "ff",
  ﬁ: "fi",
  ﬂ: "fl",
  ﬃ: "ffi",
  ﬄ: "ffl",
};

interface Normalization {
  ligatures: boolean;
  controls: boolean;
}

/**
 * Normalizes one span's text.
 *
 * Ligature expansion is opinionated and worth the notice it carries: leaving
 * U+FB01 in place breaks searching a converted document for "find", "office", or
 * "file", which is most of the reason to convert to Markdown at all.
 *
 * Markdown syntax is deliberately *not* pre-escaped here — that is
 * remark-stringify's job, and doing both double-escapes.
 */
function normalizeText(text: string, seen: Normalization): string {
  let out = "";
  for (const char of text) {
    const expansion = LIGATURES[char];
    if (expansion) {
      seen.ligatures = true;
      out += expansion;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && char !== "\t") || code === 127) {
      seen.controls = true;
      continue;
    }
    out += char;
  }
  // Two byte sequences for the same visible text defeat every downstream grep.
  return out.replace(/\s+/g, " ").normalize("NFC");
}

/**
 * Renders spans as phrasing content, in a fixed nesting order.
 *
 * Code innermost, then emphasis, then strong — fixed for the same reason the ADF
 * converter fixes its mark order: mdast nests what the source keeps flat, and a
 * varying nesting order varies the output bytes for identical input.
 */
function phrasing(spans: InlineSpan[], seen: Normalization): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const span of spans) {
    const value = normalizeText(span.text, seen);
    if (!value) continue;
    let node: PhrasingContent = span.code
      ? ({ type: "inlineCode", value } as InlineCode)
      : ({ type: "text", value } as Text);
    if (span.italic) node = { type: "emphasis", children: [node] } as Emphasis;
    if (span.bold) node = { type: "strong", children: [node] } as Strong;
    out.push(node);
  }
  return out;
}

function paragraphOf(spans: InlineSpan[], seen: Normalization): Paragraph | null {
  const children = phrasing(spans, seen);
  return children.length ? { type: "paragraph", children } : null;
}

/** Converts one block. Never branches on `provenance.path`. */
function toMdast(block: Block, sink: DiagnosticSink, seen: Normalization): RootContent[] {
  switch (block.kind) {
    case "heading": {
      const children = phrasing(block.spans, seen);
      if (!children.length) return [];
      return [
        {
          type: "heading",
          depth: Math.min(Math.max(block.level ?? 1, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6,
          children,
        },
      ];
    }
    case "paragraph":
    case "figure":
    case "code": {
      if (block.kind === "code") {
        const value = block.spans.map((span) => span.text).join("\n");
        // `lang` and `meta` pinned null: nothing here can infer a language, and
        // guessing one would be a claim the converter cannot support.
        return value ? [{ type: "code", lang: null, meta: null, value }] : [];
      }
      const paragraph = paragraphOf(block.spans, seen);
      return paragraph ? [paragraph] : [];
    }
    case "caption": {
      const children = phrasing(block.spans, seen);
      return children.length
        ? [{ type: "paragraph", children: [{ type: "emphasis", children }] }]
        : [];
    }
    case "blockquote": {
      const children = block.children.flatMap((child) => toMdast(child, sink, seen));
      return children.length ? [{ type: "blockquote", children: children as BlockContent[] }] : [];
    }
    case "list": {
      const items = block.children
        .filter((child) => child.kind === "listItem")
        .map((child) => {
          const own = paragraphOf(child.spans, seen);
          const nested = child.children.flatMap((grand) => toMdast(grand, sink, seen));
          const content = [...(own ? [own] : []), ...nested] as BlockContent[];
          // `spread` and `checked` pinned rather than derived from input
          // whitespace, which would make the bytes depend on the source's
          // incidental leading.
          return { type: "listItem" as const, spread: false, checked: null, children: content };
        })
        .filter((item) => item.children.length > 0);
      return items.length
        ? [
            {
              type: "list",
              ordered: Boolean(block.ordered),
              start: null,
              spread: false,
              children: items,
            },
          ]
        : [];
    }
    case "listItem": {
      const paragraph = paragraphOf(block.spans, seen);
      return paragraph ? [paragraph] : [];
    }
    case "table": {
      const rows = block.children.filter((child) => child.kind === "tableRow");
      if (rows.length === 0) return [];
      const width = Math.max(...rows.map((row) => row.children.length));
      const mdRows: TableRow[] = rows.map((row) => {
        const cells: TableCell[] = row.children.slice(0, width).map((cell) => {
          if (cell.children.length > 0)
            sink.add({
              code: CODES.cellSpanDropped,
              quality: "approximate",
              message: "A table cell's block content was flattened into inline content",
              construct: "TD",
            });
          return { type: "tableCell", children: phrasing(cell.spans, seen) };
        });
        while (cells.length < width) cells.push({ type: "tableCell", children: [] });
        return { type: "tableRow", children: cells };
      });
      // Alignment is never inferred from geometry: an ADF cell has no alignment
      // and neither does a reconstructed one, so claiming one would be invented.
      const table: Table = {
        type: "table",
        align: Array.from({ length: width }, () => null),
        children: mdRows,
      };
      return [table];
    }
    default:
      return [];
  }
}

export interface ToMarkdownResult {
  markdown: string;
  diagnostics: PdfDiagnostic[];
  blocks: Block[];
}

export interface ConvertOptions {
  /** Pages to emit. Statistics are still computed across the whole document. */
  pages?: number[];
  headingLevels?: Map<string, number>;
}

/**
 * Converts a document to Markdown.
 *
 * The path is chosen **per page**: a page whose structure tree carries at least
 * one content leaf uses it, and any other page falls to geometry. Mixed
 * documents are real — a scanned appendix bound onto a tagged report — and
 * `getMarkInfo().Marked` alone is not sufficient evidence, since producers set
 * it and ship empty trees.
 */
export async function toMarkdown(
  handle: OpenDocument,
  options: ConvertOptions = {},
): Promise<ToMarkdownResult> {
  const sink = new DiagnosticSink();
  const seen: Normalization = { ligatures: false, controls: false };
  const { doc } = handle;

  const all = Array.from({ length: doc.numPages }, (_, index) => index + 1);
  const wanted = options.pages ?? all;
  const selected = new Set(wanted);

  const structBlocks: Block[] = [];
  const geometricPages: PageRuns[] = [];
  let structCount = 0;
  let geometricCount = 0;

  for (const page of all) {
    let runs: PageRuns;
    try {
      runs = await extractPage(handle, page, { markedContent: true });
    } catch {
      sink.add({
        code: CODES.contentUndecodable,
        quality: "unsupported",
        message: "The page's content stream could not be decoded; nothing was emitted for it",
        page,
      });
      continue;
    }

    if (runs.runs.length === 0) {
      if (selected.has(page))
        sink.add({
          code: CODES.noTextLayer,
          quality: "unsupported",
          message: "The page carries no text layer; nothing was emitted for it",
          page,
          remediation:
            "The page is an image. Recognizing its text needs OCR, which this toolset does not do.",
        });
      continue;
    }

    let tree: PdfStructNode | null;
    try {
      const proxy = await handle.within(() => doc.getPage(page));
      tree = await handle.within(() => proxy.getStructTree());
    } catch {
      tree = null;
    }

    const structured = blocksFromStruct(tree, runs.runs, sink, page);
    if (structured.usable) {
      structCount += 1;
      if (selected.has(page)) structBlocks.push(...structured.blocks);
    } else {
      geometricCount += 1;
      geometricPages.push(runs);
    }
  }

  // Geometry runs over every page it owns, selected or not, so document-wide
  // statistics — the modal body size, the heading ranking, repeated headers —
  // are the same whether or not `--pages` narrowed the output. The selection is
  // applied afterwards, which is what makes a page range a true subset of the
  // full conversion rather than a differently-inferred document.
  const geometric = geometricPages.length
    ? blocksFromLayout(geometricPages, sink, { headingLevels: options.headingLevels })
    : [];
  const geometricSelected = geometric.filter((block) =>
    block.provenance.pages.some((page) => selected.has(page)),
  );

  const blocks = [...structBlocks, ...geometricSelected].sort(
    (a, b) => (a.provenance.pages[0] ?? 0) - (b.provenance.pages[0] ?? 0),
  );

  // Always emitted, and deliberately a notice rather than an approximation:
  // making "this document was untagged" itself blocking would mean --strict
  // refuses essentially every real PDF, which makes the flag meaningless.
  // --strict blocks on the per-construct losses instead.
  sink.add({
    code: CODES.conversionPath,
    quality: "exact",
    message:
      structCount && geometricCount
        ? `Mixed conversion: ${structCount} page(s) from the structure tree, ${geometricCount} from geometry`
        : structCount
          ? `Converted ${structCount} page(s) from the document's structure tree`
          : `Converted ${geometricCount} page(s) by inferring structure from geometry`,
    remediation:
      geometricCount > 0
        ? "An untagged page has no paragraphs, headings, or lists to read — all of them are inferred."
        : undefined,
  });

  if (options.pages)
    sink.add({
      code: CODES.pageSubsetConverted,
      quality: "exact",
      message: `Emitted ${wanted.length} of ${doc.numPages} page(s); document-wide inference still used every page`,
    });

  if (geometricCount > 0)
    sink.add({
      code: CODES.inlineStyleInferred,
      quality: "approximate",
      message:
        "Bold and italic are inferred from font names; underline, strikethrough, and super/subscript are not represented",
      remediation:
        "The standard 14 fonts report a generic family, so weight is undetectable in documents using them.",
    });

  if (seen.ligatures)
    sink.add({
      code: CODES.ligaturesExpanded,
      quality: "exact",
      message: "Typographic ligatures were expanded to their component letters",
    });
  if (seen.controls)
    sink.add({
      code: CODES.controlCharactersStripped,
      quality: "exact",
      message: "Control characters in the text layer were removed",
    });

  const children = blocks.flatMap((block) => toMdast(block, sink, seen));
  const root: Root = { type: "root", children };
  return { markdown: stringifyMarkdown(root), diagnostics: sink.all(), blocks };
}
