import { CODES, DiagnosticSink } from "./diagnostics.js";
import { classify } from "./document.js";
import type { OpenDocument, PdfStructNode } from "./document.js";
import { extractPage, round2 } from "./text.js";
import type { PdfDiagnostic, PdfDocumentInfo, PdfPageInfo, TextLayer } from "./types.js";

/** Square points per square inch: 72 × 72. */
const POINTS_PER_SQUARE_INCH = 5184;

/**
 * Below this many characters per square inch a page cannot be read as a
 * document.
 *
 * A conventionally typeset Letter page — 12 pt body, ~1.4 line spacing, one inch
 * margins — carries roughly 3000 characters over 93.5 in², so about 32 chars per
 * square inch. Five is a sixth of that: on Letter it is around 470 characters,
 * six to eight lines. Above it the text layer can carry a document; below it,
 * whatever is there is a stamp, a caption, or a watermark.
 *
 * The inputs are published alongside the label so a caller who disagrees can
 * re-threshold from `characters` and `density` without reverse-engineering this
 * constant.
 */
const SPARSE_DENSITY = 5;

/** A page with a handful of glyphs and nothing else is `absent`, not `sparse`. */
const MINIMUM_GLYPHS = 32;
const MINIMUM_DENSITY = 0.5;

export function classifyTextLayer(characters: number, density: number): TextLayer {
  if (characters === 0) return "absent";
  if (characters < MINIMUM_GLYPHS && density < MINIMUM_DENSITY) return "absent";
  if (density < SPARSE_DENSITY) return "sparse";
  return "present";
}

/** The document-level roll-up: the label holding at least 80% of pages, else mixed. */
function rollUp(pages: PdfPageInfo[]): TextLayer {
  if (pages.length === 0) return "absent";
  const counts = new Map<TextLayer, number>();
  for (const page of pages) counts.set(page.textLayer, (counts.get(page.textLayer) ?? 0) + 1);
  for (const label of ["present", "sparse", "absent"] as const)
    if ((counts.get(label) ?? 0) / pages.length >= 0.8) return label;
  return "sparse";
}

/** Strips C0 controls and bounds a metadata string; attacker-controlled input. */
function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return stripped ? stripped.slice(0, 1024) : undefined;
}

/**
 * Converts a PDF `D:YYYYMMDDHHmmSS` date to ISO 8601 in UTC.
 *
 * Omitted rather than guessed when it does not parse, and never rendered in the
 * host timezone: that would make the payload machine-dependent, which is the
 * same reasoning the ADF converter applies to its own timestamps.
 */
export function parsePdfDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})'?)?/.exec(
      value,
    );
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, , sign, offsetHours, offsetMinutes] = match;
  const stamp = Date.UTC(
    Number(year),
    Number(month ?? "01") - 1,
    Number(day ?? "01"),
    Number(hour ?? "00"),
    Number(minute ?? "00"),
    Number(second ?? "00"),
  );
  if (Number.isNaN(stamp)) return undefined;
  const offset =
    sign && offsetHours
      ? (Number(offsetHours) * 60 + Number(offsetMinutes ?? "0")) * 60_000 * (sign === "-" ? -1 : 1)
      : 0;
  return new Date(stamp - offset).toISOString();
}

/** True when a structure tree carries at least one marked-content leaf. */
export function hasStructContent(node: PdfStructNode | null | undefined): boolean {
  if (!node) return false;
  if (node.type === "content" && node.id) return true;
  return (node.children ?? []).some(hasStructContent);
}

export interface SummaryResult {
  document: PdfDocumentInfo;
  diagnostics: PdfDiagnostic[];
}

/**
 * The document facts that cost nothing: no page is opened.
 *
 * Every command carries this, so a caller can read `document.tagged` off a
 * `to-markdown` payload rather than making a second call. `structured` and
 * `textLayer` are absent here because only a command that walks pages can
 * measure them, and a field nobody measured must not read as a measurement.
 */
export async function documentSummary(handle: OpenDocument): Promise<SummaryResult> {
  const sink = new DiagnosticSink();
  const { doc } = handle;

  let info: Record<string, unknown> = {};
  try {
    const metadata = await handle.within(() => doc.getMetadata());
    info = metadata.info ?? {};
  } catch {
    sink.add({
      code: CODES.metadataUnreadable,
      quality: "approximate",
      message: "The document's metadata could not be read; other findings are unaffected",
    });
  }

  // getMarkInfo() returns a Map, not an object — reading `.Marked` on it is
  // always undefined, which would report every document as untagged. The
  // published .d.ts says otherwise and is wrong.
  let tagged: boolean;
  try {
    const markInfo = await handle.within(() => doc.getMarkInfo());
    tagged = markInfo instanceof Map && markInfo.get("Marked") === true;
  } catch {
    tagged = false;
  }

  if (handle.encrypted)
    sink.add({
      code: CODES.encryptedOpenPassword,
      quality: "exact",
      message:
        "The document is encrypted but opened without a password, so its restrictions are advisory only",
    });

  return {
    document: {
      pageCount: doc.numPages,
      tagged,
      encrypted: handle.encrypted,
      ...maybe("pdfVersion", clean(info.PDFFormatVersion)),
      ...maybe("title", clean(info.Title)),
      ...maybe("author", clean(info.Author)),
      ...maybe("subject", clean(info.Subject)),
      ...maybe("keywords", clean(info.Keywords)),
      ...maybe("creator", clean(info.Creator)),
      ...maybe("producer", clean(info.Producer)),
      ...maybe("created", parsePdfDate(info.CreationDate)),
      ...maybe("modified", parsePdfDate(info.ModDate)),
    },
    diagnostics: sink.all(),
  };
}

export interface InspectResult {
  document: PdfDocumentInfo;
  pages: PdfPageInfo[];
  diagnostics: PdfDiagnostic[];
}

/**
 * The page inventory, on top of {@link documentSummary}.
 *
 * `probeStructure` drives whether each page's structure tree is opened. It is on
 * for `inspect`, because `structured` is one of the two fields the command
 * exists to report, and off elsewhere.
 */
export async function inspectDocument(
  handle: OpenDocument,
  options: { pages?: number[]; probeStructure?: boolean } = {},
): Promise<InspectResult> {
  const sink = new DiagnosticSink();
  const { doc } = handle;
  const summary = await documentSummary(handle);
  for (const item of summary.diagnostics)
    sink.add({ ...item, quality: item.quality, severity: item.severity });

  const wanted = options.pages ?? Array.from({ length: doc.numPages }, (_, index) => index + 1);
  const pages: PdfPageInfo[] = [];
  let structuredPages = 0;
  let probedPages = 0;

  for (const page of wanted) {
    try {
      const extracted = await extractPage(handle, page);
      const density =
        extracted.width > 0 && extracted.height > 0
          ? (extracted.characters * POINTS_PER_SQUARE_INCH) / (extracted.width * extracted.height)
          : 0;
      const textLayer = classifyTextLayer(extracted.characters, density);
      pages.push({
        page,
        width: extracted.width,
        height: extracted.height,
        rotation: extracted.rotation,
        characters: extracted.characters,
        density: round2(density),
        textLayer,
      });
      if (textLayer === "absent")
        sink.add({
          code: CODES.noTextLayer,
          quality: "unsupported",
          message: "The page carries no text layer; nothing can be extracted from it",
          page,
          remediation:
            "The page is an image. Recognizing its text needs OCR, which this toolset does not do.",
        });

      if (options.probeStructure) {
        probedPages += 1;
        const proxy = await handle.within(() => doc.getPage(page));
        const tree = await handle.within(() => proxy.getStructTree());
        if (hasStructContent(tree)) structuredPages += 1;
        proxy.cleanup();
      }
    } catch (error) {
      const classified = await classify(error, page);
      sink.add({ ...classified, quality: "unsupported" });
    }
  }

  if (options.probeStructure) {
    if (summary.document.tagged && structuredPages === 0)
      sink.add({
        code: CODES.taggedButEmpty,
        quality: "approximate",
        message:
          "The document declares /MarkInfo <</Marked true>> but no page carries a usable structure tree",
        remediation:
          "Conversion will infer structure geometrically, as though the document were untagged.",
      });
    if (structuredPages > 0 && structuredPages < probedPages)
      sink.add({
        code: CODES.structPartial,
        quality: "exact",
        message: `A structure tree is present on ${structuredPages} of ${probedPages} pages`,
      });
  }

  return {
    document: {
      ...summary.document,
      ...(options.probeStructure
        ? {
            structured:
              structuredPages === 0
                ? ("none" as const)
                : structuredPages === probedPages
                  ? ("struct" as const)
                  : ("partial" as const),
          }
        : {}),
      ...(pages.length ? { textLayer: rollUp(pages) } : {}),
    },
    pages,
    diagnostics: sink.all(),
  };
}

function maybe<K extends string>(key: K, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}
