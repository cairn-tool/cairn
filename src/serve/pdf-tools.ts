import fs from "node:fs";
import { readAttachments } from "../pdf/attachments.js";
import { withDocument } from "../pdf/document.js";
import type { OpenDocument } from "../pdf/document.js";
import { readForm } from "../pdf/forms.js";
import { documentSummary, inspectDocument } from "../pdf/inspect.js";
import { readOutline } from "../pdf/outline.js";
import { MAX_INPUT_BYTES, parsePageRange, readInput } from "../pdf/read.js";
import { extractPage, runsToText } from "../pdf/text.js";
import { toMarkdown } from "../pdf/to-markdown.js";
import type { PdfTextPage } from "../pdf/types.js";
import { confine, PathRejected, relativeTo } from "./paths.js";
import type { ServeContext, ServeTool } from "./types.js";

/**
 * Read-only PDF tools.
 *
 * Kept out of `tools.ts` because that file is uniformly the Markdown workspace
 * engine and these are not; `SERVE_TOOLS` spreads this array so registration
 * stays one list.
 *
 * Three properties hold across every tool here:
 *
 * **Confined like everything else.** A PDF must live under `--root`. That is a
 * real narrowing — a PDF handed to the CLI has nothing to do with a workspace —
 * but the alternative is a second boundary on a surface whose whole claim is
 * that there is one.
 *
 * **Nothing writes.** `list_pdf_attachments` inventories and there is no path
 * to `--extract` here, the same line that keeps `scripts run` off this surface.
 *
 * **No command action is ever called.** Those terminate the process on a
 * finding, which on a long-lived stdio server would end the session; these call
 * the `src/pdf` modules directly, all of which are pure.
 */

/**
 * Bounds, as constants rather than flags: `ServeContext` carries none, and a
 * host cannot pass `--max-bytes`. They match the CLI defaults so the same
 * document behaves the same way on both surfaces.
 */
const LIMITS = { maxBytes: MAX_INPUT_BYTES, timeoutMs: 30_000, maxPages: 5_000 };

/** A confined, existing, regular file. Mirrors `fileArgument` in `tools.ts`. */
function pdfArgument(args: Record<string, unknown>, context: ServeContext): string {
  const value = args.file;
  if (typeof value !== "string" || value === "") throw new PathRejected("file is required");
  // `confine` refuses "-" before it can reach `readInput`, whose stdin branch
  // would otherwise read fd 0 — the JSON-RPC channel — and deadlock the server.
  const target = confine(context.root, value, "file");
  if (!fs.existsSync(target) || !fs.statSync(target).isFile())
    throw new PathRejected(`File not found: ${relativeTo(context.root, target)}`);
  return target;
}

/**
 * Opens the document, applying the same bounded read the CLI does.
 *
 * Project configuration is deliberately not consulted, even though
 * `context.config` is populated on this surface: a `.cairn.yml` has no say over
 * how a document named in a tool call is parsed, which is the same rule that
 * keeps `pdf` out of `servesWorkspace`.
 */
async function open<T>(
  args: Record<string, unknown>,
  context: ServeContext,
  body: (handle: OpenDocument, file: string) => Promise<T>,
): Promise<T> {
  const file = pdfArgument(args, context);
  const read = await readInput(file, LIMITS);
  if (!read.ok) throw new Error(read.diagnostic.message);
  return withDocument(read.bytes, LIMITS, (handle) => body(handle, file));
}

function pages(args: Record<string, unknown>, handle: OpenDocument): number[] | undefined {
  const spec = args.pages;
  if (typeof spec !== "string" || spec === "") return undefined;
  const parsed = parsePageRange(spec, handle.doc.numPages);
  if (!parsed.ok) throw new Error(parsed.diagnostic.message);
  return parsed.pages;
}

const FILE = {
  type: "string",
  description: "PDF file relative to the served root.",
} as const;

const PAGES = {
  type: "string",
  description: "1-based pages to read, e.g. 1,3,5-8. Every page by default.",
} as const;

const inspectPdf: ServeTool = {
  name: "inspect_pdf",
  description:
    "Report a PDF's page count, metadata, tagging, and per-page text-layer classification. Read this before converting: `tagged` says whether structure can be trusted, and a page classified `absent` carries no text to extract. Mirrors `pdf inspect`.",
  inputSchema: { type: "object", properties: { file: FILE }, required: ["file"] },
  handler: (args, context) =>
    open(args, context, async (handle, file) => {
      const inspected = await inspectDocument(handle, { probeStructure: true });
      return {
        file: relativeTo(context.root, file),
        document: inspected.document,
        pages: inspected.pages,
        diagnostics: inspected.diagnostics,
      };
    }),
};

const readPdfText: ServeTool = {
  name: "read_pdf_text",
  description:
    "Extract the text layer a PDF already carries, page by page. Never recognizes text in an image: a scanned page comes back empty with a diagnostic saying so rather than silently blank. Mirrors `pdf text`.",
  inputSchema: { type: "object", properties: { file: FILE, pages: PAGES }, required: ["file"] },
  handler: (args, context) =>
    open(args, context, async (handle, file) => {
      const summary = await documentSummary(handle);
      const selected = pages(args, handle);
      const wanted = selected ?? Array.from({ length: handle.doc.numPages }, (_, i) => i + 1);
      const text: PdfTextPage[] = [];
      const diagnostics = [...summary.diagnostics];
      for (const page of wanted) {
        const extracted = await extractPage(handle, page);
        const body = runsToText(extracted.runs);
        text.push({ page, text: body, characters: extracted.characters });
      }
      return {
        file: relativeTo(context.root, file),
        document: summary.document,
        ...(selected ? { selectedPages: selected } : {}),
        text,
        diagnostics,
      };
    }),
};

const convertPdfToMarkdown: ServeTool = {
  name: "convert_pdf_to_markdown",
  description:
    "Convert a PDF's content to Markdown, reporting per construct what was inferred or lost. On an untagged page every block boundary is inferred from geometry, so read `document.tagged` and the diagnostics before trusting the structure. Mirrors `pdf to-markdown`.",
  inputSchema: { type: "object", properties: { file: FILE, pages: PAGES }, required: ["file"] },
  handler: (args, context) =>
    open(args, context, async (handle, file) => {
      const summary = await documentSummary(handle);
      const selected = pages(args, handle);
      const outline = await readOutline(handle);
      const converted = await toMarkdown(handle, {
        ...(selected ? { pages: selected } : {}),
        headingLevels: outline.headingLevels,
      });
      return {
        file: relativeTo(context.root, file),
        document: summary.document,
        ...(selected ? { selectedPages: selected } : {}),
        markdown: converted.markdown,
        diagnostics: [...summary.diagnostics, ...converted.diagnostics],
      };
    }),
};

const getPdfOutline: ServeTool = {
  name: "get_pdf_outline",
  description:
    "Read a PDF's declared outline (bookmarks) as a heading tree with resolved page numbers. A document with no outline returns an empty tree, which is an answer rather than a failure. Mirrors `pdf outline`.",
  inputSchema: { type: "object", properties: { file: FILE }, required: ["file"] },
  handler: (args, context) =>
    open(args, context, async (handle, file) => {
      const summary = await documentSummary(handle);
      const outline = await readOutline(handle);
      return {
        file: relativeTo(context.root, file),
        document: summary.document,
        outline: outline.outline,
        diagnostics: [...summary.diagnostics, ...outline.diagnostics],
      };
    }),
};

const listPdfAttachments: ServeTool = {
  name: "list_pdf_attachments",
  description:
    "List the files embedded inside a PDF, with size and SHA-256. Inventory only: this surface never writes, so there is no way to extract them here. Mirrors `pdf attachments` without --extract.",
  inputSchema: { type: "object", properties: { file: FILE }, required: ["file"] },
  handler: (args, context) =>
    open(args, context, async (handle, file) => {
      const summary = await documentSummary(handle);
      // No `extract` option is passed, and none can be: the schema declares no
      // such property, so a host cannot reach the writing path from here.
      const read = await readAttachments(handle);
      return {
        file: relativeTo(context.root, file),
        document: summary.document,
        attachments: read.attachments,
        diagnostics: [...summary.diagnostics, ...read.diagnostics],
      };
    }),
};

const listPdfFormFields: ServeTool = {
  name: "list_pdf_form_fields",
  description:
    "List a PDF's AcroForm field names, types, and current values. Reads and never writes. An XFA form reports type `xfa` with no fields rather than an empty list, because its values are not readable here. Mirrors `pdf forms`.",
  inputSchema: { type: "object", properties: { file: FILE }, required: ["file"] },
  handler: (args, context) =>
    open(args, context, async (handle, file) => {
      const summary = await documentSummary(handle);
      const read = await readForm(handle);
      return {
        file: relativeTo(context.root, file),
        document: summary.document,
        form: read.form,
        diagnostics: [...summary.diagnostics, ...read.diagnostics],
      };
    }),
};

export const PDF_SERVE_TOOLS: readonly ServeTool[] = [
  inspectPdf,
  readPdfText,
  convertPdfToMarkdown,
  getPdfOutline,
  listPdfAttachments,
  listPdfFormFields,
];
