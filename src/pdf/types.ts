import type { DiagnosticSeverity, MappingQuality } from "../mapping-quality.js";
export type { MappingQuality } from "../mapping-quality.js";

/**
 * A PDF finding.
 *
 * The third finding family, after `AB###` for agent bundles and `AD###` for ADF
 * conversion. It is structurally a `ConversionDiagnostic` with `node` and
 * `location` replaced by `page` and `construct`, because a PDF finding is
 * positioned by page rather than by a node ancestry trail — stuffing a page
 * number into a field documented as "slash-joined ancestor node types" would be
 * worse than a third shape. `quality` and the quality-to-severity rule are
 * shared with the other two through `src/mapping-quality.ts`.
 */
export interface PdfDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  quality: MappingQuality;
  /** 1-based page the finding concerns, when it concerns one page. */
  page?: number;
  /** The PDF construct: a structure role, a filter name, a font name. */
  construct?: string;
  remediation?: string;
}

export type PdfCommand =
  | "inspect"
  | "text"
  | "outline"
  | "validate"
  | "to-markdown"
  | "attachments"
  | "forms"
  | "images"
  | "render"
  | "ocr";

/** How much text a page carries, relative to its area. */
export type TextLayer = "present" | "sparse" | "absent";

/**
 * Document-level facts, present on every command that opened the document.
 *
 * A deliberate divergence from `AdfResult`, where `inventory` is `inspect`-only:
 * a conversion from a tagged document and one from a scan are not the same kind
 * of artifact and must not look identical in the payload. `jq .document.tagged`
 * has to work on a `to-markdown` result.
 */
export interface PdfDocumentInfo {
  pageCount: number;
  /**
   * The document declares `/MarkInfo <</Marked true>>`.
   *
   * Not the same question as whether a usable structure tree exists — plenty of
   * producers set this and ship an empty tree — which is what `structured`
   * answers by probing.
   */
  tagged: boolean;
  /**
   * Whether any page yielded a structure tree with content.
   *
   * Optional because only the commands that walk pages can answer it; `outline`
   * never opens one. Omitted rather than defaulted, on the rule that a field
   * nobody measured must not read as a measurement.
   */
  structured?: "struct" | "partial" | "none";
  encrypted: boolean;
  /** Omitted for the same reason as `structured`. */
  textLayer?: TextLayer;
  pdfVersion?: string;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO-8601, when the document's own `D:` string parsed. Omitted, never guessed. */
  created?: string;
  modified?: string;
}

export interface PdfPageInfo {
  page: number;
  /** Points, 72 to the inch, with `/Rotate` already applied. */
  width: number;
  height: number;
  rotation: number;
  /** Non-whitespace code points on the page: the evidence behind `textLayer`. */
  characters: number;
  /** Characters per square inch, rounded to 2 dp. The other half of the evidence. */
  density: number;
  textLayer: TextLayer;
}

export interface PdfTextPage {
  page: number;
  text: string;
  characters: number;
}

export interface PdfOutlineEntry {
  title: string;
  /** 1-based nesting depth. */
  level: number;
  /** 1-based destination page, or null when it did not resolve. */
  page: number | null;
  /** Present only when pdf.js validated the URL's scheme. */
  url?: string;
  children: PdfOutlineEntry[];
}

/** One embedded file. Emitted by `pdf attachments`. */
export interface PdfAttachment {
  /** The name-tree key: the identifier the content lookup takes. */
  id: string;
  /**
   * The basename pdf.js derived. Never used as a path without re-checking —
   * the sanitization this command applies is its own, not pdf.js's.
   */
  filename: string;
  /** The stored name verbatim, including any traversal it carries. */
  rawFilename: string;
  description?: string;
  /** Byte length of the decoded file. Absent when the content could not be read. */
  bytes?: number;
  sha256?: string;
  /** Executable format, when the magic bytes say so. */
  binary?: "elf" | "pe" | "macho";
  /** Absolute path written. Present only under `--extract`. */
  written?: string;
}

/** One AcroForm field. Emitted by `pdf forms`. */
export interface PdfFormField {
  /** Fully-qualified field name. */
  name: string;
  type: string;
  /** 1-based, converted from the 0-based index pdf.js reports. */
  page: number | null;
  value?: string;
  defaultValue?: string;
  readOnly: boolean;
  hidden: boolean;
  /**
   * The field's password flag. The value is still reported: the same bytes are
   * reachable through `pdf text`, so withholding them would be theatre.
   */
  password: boolean;
  charLimit?: number;
  exportValues?: string;
  /** Widgets this field renders as; one field can appear on several pages. */
  widgets: number;
}

export interface PdfForm {
  /** `xfa` means the values live in an XML packet this does not read. */
  type: "acroform" | "xfa" | "none";
  fieldCount: number;
  fields: PdfFormField[];
}

/**
 * One image placement. Emitted by `pdf images`.
 *
 * Coordinates are PDF default user space: points, origin at the bottom left of
 * the page's coordinate system, `/Rotate` not applied — the same space
 * `pdf render --box` takes, so a placement's `box` can be handed straight to it.
 */
export interface PdfImage {
  page: number;
  /** 1-based order of placement on the page, in content-stream order. */
  index: number;
  /** `12 0 R`, or null for an inline image, which is not an object. */
  object: string | null;
  /** The XObject resource name, e.g. `Im1`. */
  name?: string;
  inline: boolean;
  /** Form XObjects entered to reach the image, outermost first. */
  forms?: string[];
  /** Pixel size, as declared. */
  width: number;
  height: number;
  /** `DeviceRGB`, `ICCBased(3)`, `Indexed(DeviceRGB,255)`, …; null for a stencil mask. */
  colorSpace: string | null;
  components: number;
  bitsPerComponent: number;
  /** The filter chain, abbreviations expanded. */
  filters: string[];
  imageMask: boolean;
  mask?: { type: "smask" | "stencil" | "color-key"; object?: string; file?: string };
  /** The image-space unit square mapped into user space: `[a, b, c, d, e, f]`. */
  transform: number[];
  /** `[x0, y0, x1, y1]` bounding the placement in user space. */
  box: number[];
  /** Written file, relative to the output directory. Absent when skipped. */
  file?: string;
  format?: "png" | "jpeg" | "jp2";
  bytes?: number;
  sha256?: string;
  skipped?: "min-size" | "undecodable";
}

/** What `pdf render` drew. */
export interface PdfRenderInfo {
  page: number;
  dpi: number;
  /** Pixel size of the PNG. */
  width: number;
  height: number;
  /** The region drawn, user space, after snapping to whole pixels and clipping to the page. */
  box: number[];
  /** The page's visible area (crop box) in user space. */
  pageBox: number[];
  rotation: number;
  /** Absolute path written. */
  file: string;
  bytes: number;
  sha256: string;
}

export interface PdfOcrWord {
  text: string;
  /** 0–100, as the engine reports it. */
  confidence: number;
  /** User space, like every other box in this toolset. */
  box: number[];
}

/** One recognised page. `source` is always `ocr`: recognised text never masquerades as a text layer. */
export interface PdfOcrPage {
  page: number;
  source: "ocr";
  /** The page's own text layer, measured before recognition. */
  textLayer: "present" | "absent";
  text: string;
  /** Mean word confidence, weighted by word length; null when nothing was recognised. */
  confidence: number | null;
  words: PdfOcrWord[];
}

export interface PdfOcr {
  engine: { name: "tesseract"; version: string; languages: string[]; dpi: number; psm: number };
  /** The confidence floor below which a page is reported. */
  minConfidence: number;
  pages: PdfOcrPage[];
}

export interface PdfResult {
  command: PdfCommand;
  ok: boolean;
  /** Input path, or `-` for stdin. */
  source: string;
  document?: PdfDocumentInfo;
  /** inspect */
  pages?: PdfPageInfo[];
  /** text */
  text?: PdfTextPage[];
  /** outline */
  outline?: PdfOutlineEntry[];
  /** to-markdown */
  markdown?: string;
  /** attachments */
  attachments?: PdfAttachment[];
  /** forms */
  form?: PdfForm;
  /** images */
  images?: PdfImage[];
  /** render */
  render?: PdfRenderInfo;
  /** ocr */
  ocr?: PdfOcr;
  /** text, to-markdown — present only when `--pages` narrowed the document. */
  selectedPages?: number[];
  /** Where `--output` or `--out` wrote: a file, or for `images` the directory. */
  output?: string;
  diagnostics: PdfDiagnostic[];
}

/* ------------------------------------------------------------------ *
 * The intermediate block model.
 *
 * `struct.ts` and `layout.ts` both produce it and `to-markdown.ts`
 * consumes it, which is why it lives here rather than in either producer.
 * `to-markdown.ts` must never branch on `provenance.path` — the same rule
 * that keeps `src/commands/usage.ts` free of `provider.name` checks. The
 * difference between the two paths travels in the diagnostics, not into
 * the emitter.
 * ------------------------------------------------------------------ */

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "listItem"
  | "table"
  | "tableRow"
  | "tableCell"
  | "code"
  | "blockquote"
  | "figure"
  | "caption";

export interface InlineSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
}

export interface BlockProvenance {
  path: "struct" | "geometric";
  /** Per block, not per document: one conversion mixes exact and approximate. */
  quality: MappingQuality;
  /** Pages the block's runs came from. A stitched paragraph has two. */
  pages: number[];
  /** The structure-tree role, when `path` is `"struct"`. */
  role?: string;
}

/**
 * One block of converted content.
 *
 * `spans` and `children` are both always present and mutually exclusive by
 * kind, rather than a discriminated union, for the reason `AdfNode` is
 * structural: a new kind must be able to reach a diagnostic instead of failing
 * to compile at forty call sites.
 *
 * A flattened table is a run of sibling `paragraph` blocks — never a `table`
 * with one cell. The emitter must be structurally unable to produce a table
 * that was not one.
 */
export interface Block {
  kind: BlockKind;
  /** heading only, 1..6. */
  level?: number;
  /** list only. */
  ordered?: boolean;
  /** tableCell only. */
  header?: boolean;
  spans: InlineSpan[];
  children: Block[];
  provenance: BlockProvenance;
}
