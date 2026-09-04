import { CODES, DiagnosticSink } from "./diagnostics.js";
import type { OpenDocument } from "./document.js";
import type { PdfDiagnostic, PdfOutlineEntry } from "./types.js";

/**
 * The outline is attacker-shaped structure and the walk is recursive, so it is
 * bounded for the same reason the ADF reader bounds nesting depth: a stack
 * overflow with no diagnostic is the wrong failure for input off a network.
 */
export const MAX_OUTLINE_DEPTH = 64;

/**
 * C0 controls and DEL, stripped from every attacker-controlled string.
 *
 * Declared once so the directive stays attached to the pattern: inline, the
 * formatter moves the expression onto its own line and the comment governs the
 * wrong statement.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Titles are attacker-controlled; bound them and strip control characters. */
function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARACTERS, "").normalize("NFC").trim().slice(0, 512);
}

interface RawOutlineEntry {
  title?: unknown;
  dest?: unknown;
  url?: unknown;
  unsafeUrl?: unknown;
  items?: RawOutlineEntry[];
}

export interface OutlineResult {
  outline: PdfOutlineEntry[];
  diagnostics: PdfDiagnostic[];
  /** Normalized title to level, for `layout.ts` to pin heading levels against. */
  headingLevels: Map<string, number>;
}

/**
 * Reads the declared outline and resolves each destination to a page.
 *
 * The outline a document declares, never one inferred from its text: a document
 * with no `/Outlines` returns an empty tree and exits 0, which is an answer
 * rather than a failure.
 *
 * URLs are recorded, never followed — no fetch, no HEAD, no DNS. `unsafeUrl` is
 * deliberately not surfaced as `url`: pdf.js populates `url` only when the
 * scheme passed its own validation, and putting a rejected `javascript:` or
 * `file:` URI into a field named as though it were clickable would be a
 * misrepresentation.
 */
export async function readOutline(handle: OpenDocument): Promise<OutlineResult> {
  const sink = new DiagnosticSink();
  const headingLevels = new Map<string, number>();
  const { doc } = handle;

  let raw: RawOutlineEntry[] | null;
  try {
    raw = (await handle.within(() => doc.getOutline())) as RawOutlineEntry[] | null;
  } catch {
    // A document with a malformed /Outlines reports no outline rather than
    // failing: the outline is not why the caller opened the document.
    raw = null;
  }
  if (!raw || raw.length === 0) return { outline: [], diagnostics: sink.all(), headingLevels };

  // `getPageIndex` walks the page tree, so a 500-entry outline on a long
  // document is quadratic without this.
  const resolved = new Map<string, number | null>();

  const pageFor = async (entry: RawOutlineEntry, title: string): Promise<number | null> => {
    const dest = entry.dest;
    if (dest === null || dest === undefined) return null;
    try {
      const target = Array.isArray(dest)
        ? dest
        : typeof dest === "string"
          ? await handle.within(() => doc.getDestination(dest))
          : null;
      const first = Array.isArray(target) ? (target[0] as { num?: number; gen?: number }) : null;
      if (!first || typeof first.num !== "number") return null;
      const key = `${first.num}R${first.gen ?? 0}`;
      if (resolved.has(key)) return resolved.get(key) ?? null;
      const index = await handle.within(() => doc.getPageIndex(first));
      const page = index + 1;
      resolved.set(key, page);
      return page;
    } catch {
      sink.add({
        code: CODES.destinationUnresolved,
        quality: "approximate",
        message: `The destination for "${title}" does not resolve to a page`,
        construct: title,
        remediation: "The entry is kept with a null page rather than dropped.",
      });
      return null;
    }
  };

  const walk = async (entries: RawOutlineEntry[], level: number): Promise<PdfOutlineEntry[]> => {
    if (level > MAX_OUTLINE_DEPTH) {
      sink.add({
        code: CODES.outlineTooDeep,
        quality: "unsupported",
        message: `The outline nests deeper than ${MAX_OUTLINE_DEPTH} levels and was truncated`,
      });
      return [];
    }
    const out: PdfOutlineEntry[] = [];
    for (const entry of entries) {
      const title = cleanTitle(entry.title);
      const page = await pageFor(entry, title);
      if (title && page !== null && !headingLevels.has(title)) headingLevels.set(title, level);
      out.push({
        title,
        level,
        page,
        ...(typeof entry.url === "string" ? { url: entry.url } : {}),
        children: await walk(entry.items ?? [], level + 1),
      });
    }
    return out;
  };

  const outline = await walk(raw, 1);
  return { outline, diagnostics: sink.all(), headingLevels };
}

/** Renders the tree for the human-facing streams, two spaces per level. */
export function formatOutline(entries: PdfOutlineEntry[]): string {
  const lines: string[] = [];
  const walk = (nodes: PdfOutlineEntry[]): void => {
    for (const node of nodes) {
      const indent = "  ".repeat(node.level - 1);
      lines.push(`${indent}${node.title} (p. ${node.page ?? "—"})`);
      walk(node.children);
    }
  };
  walk(entries);
  return lines.length ? `${lines.join("\n")}\n` : "";
}
