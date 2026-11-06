import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAtomically } from "../atomic-write.js";
import { CommandExit, terminate } from "../command-result.js";
import { BASE_FORMATS } from "../formats.js";
import { jsonPayload } from "../result.js";
import type { OutputFormat } from "../types.js";
import { CODES, diagnostic } from "../pdf/diagnostics.js";
import { classify, withDocument } from "../pdf/document.js";
import type { OpenDocument } from "../pdf/document.js";
import { formatAttachments, readAttachments } from "../pdf/attachments.js";
import { formatForm, readForm } from "../pdf/forms.js";
import { documentSummary, inspectDocument } from "../pdf/inspect.js";
import { formatOutline, readOutline } from "../pdf/outline.js";
import { MAX_INPUT_BYTES, MAX_INPUT_CEILING, parsePageRange, readInput } from "../pdf/read.js";
import { extractPage, runsToText } from "../pdf/text.js";
import { toMarkdown } from "../pdf/to-markdown.js";
import { validateDocument } from "../pdf/validate.js";
import type {
  PdfCommand,
  PdfDiagnostic,
  PdfImage,
  PdfOcrPage,
  PdfResult,
  PdfTextPage,
} from "../pdf/types.js";

export interface PdfOptions {
  format?: string;
  envelope?: boolean;
  output?: string;
  strict?: boolean;
  /** Commander hands these through as strings; nothing coerces them for us. */
  pages?: string;
  /** `pdf attachments` only: the directory embedded files are written into. */
  extract?: string;
  maxBytes?: string;
  maxPages?: string;
  timeout?: string;
  /** `images` (a directory), `render` and `ocr` (a file). */
  out?: string;
  /** `images`: the smallest pixel dimension an image must have to be written. */
  minSize?: string;
  /** `render`: the 1-based page. */
  page?: string;
  /** `render`: `x0,y0,x1,y1` in user space. */
  box?: string;
  /** `render`, `ocr`: resolution. */
  dpi?: string;
  /** `ocr`: Tesseract language code(s). */
  lang?: string;
  /** `ocr`: an explicit engine executable. */
  tesseract?: string;
  /** `ocr`: an explicit language data directory. */
  tessdata?: string;
  /** `ocr`: the confidence floor below which a page is reported. */
  minConfidence?: string;
}

/** Some malformed documents make the parser pathologically slow rather than failing. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Refused before any page is touched, so a hostile page count costs nothing. */
const DEFAULT_MAX_PAGES = 5_000;

/**
 * The exit rule, and it is deliberately not `hasFindings` from the agent
 * commands.
 *
 * That helper fails on any approximate mapping, which is right for
 * `agent convert` and wrong here: on an untagged document every block boundary
 * is inferred, so approximation is the *expected* outcome rather than a broken
 * run. An `error` blocks; an approximation blocks only under `--strict` — the
 * same split `jira adf`, `agent audit`, and `agent test` apply.
 */
function blocking(diagnostics: PdfDiagnostic[], strict: boolean): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.quality !== "exact"),
  );
}

function checkFormat(opts: PdfOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) throw new Error(`Invalid output format: ${format}`);
  if (opts.envelope && format !== "json") throw new Error("--envelope requires --format json");
  return format;
}

/** A positive integer flag, or its default. Refuses rather than clamping. */
function bounded(
  value: string | undefined,
  flag: string,
  fallback: number,
  ceiling?: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`Invalid ${flag} value: ${value} (expected a positive integer)`);
  if (ceiling !== undefined && parsed > ceiling)
    throw new Error(`Invalid ${flag} value: ${value} (the maximum is ${ceiling})`);
  return parsed;
}

/**
 * Recognition runs an engine over every page at 300 dpi, a second or more each,
 * and `images` decodes and re-encodes every picture — a 6600x5100 scan is 100 MB
 * of pixels — so both budget the whole run rather than a parse.
 */
const OCR_TIMEOUT_MS = 600_000;
const IMAGES_TIMEOUT_MS = 300_000;

function limitsFor(
  opts: PdfOptions,
  command?: PdfCommand,
): { maxBytes: number; timeoutMs: number; maxPages: number } {
  return {
    maxBytes: bounded(opts.maxBytes, "--max-bytes", MAX_INPUT_BYTES, MAX_INPUT_CEILING),
    timeoutMs: bounded(
      opts.timeout,
      "--timeout",
      command === "ocr"
        ? OCR_TIMEOUT_MS
        : command === "images"
          ? IMAGES_TIMEOUT_MS
          : DEFAULT_TIMEOUT_MS,
    ),
    maxPages: bounded(opts.maxPages, "--max-pages", DEFAULT_MAX_PAGES),
  };
}

/** Renders diagnostics for the human-facing streams. */
function formatDiagnostics(diagnostics: PdfDiagnostic[]): string {
  const lines = ["diagnostics:"];
  for (const item of diagnostics)
    lines.push(
      `- ${item.severity} ${item.code} [${item.quality}]` +
        `${item.page ? ` page ${item.page}` : ""}` +
        `${item.construct ? ` (${item.construct})` : ""}: ${item.message}` +
        `${item.remediation ? ` Remediation: ${item.remediation}` : ""}`,
    );
  return `${lines.join("\n")}\n`;
}

/**
 * Writes a result.
 *
 * The primary output owns stdout and diagnostics go to stderr, which is the
 * `jira adf` rule and not the `agent` one: `cairn pdf to-markdown report.pdf >
 * report.md` must not get findings spliced into the document. With
 * `--format json` the payload carries both and goes to stdout instead, which is
 * why `-fj` is not "the same output in JSON".
 */
function output(result: PdfResult, opts: PdfOptions, primary: string): void {
  const format = checkFormat(opts);
  result.ok = !blocking(result.diagnostics, Boolean(opts.strict));

  if (format === "json") {
    process.stdout.write(
      jsonPayload(`pdf ${result.command}`, result, opts, {
        ok: result.ok,
        exitCode: result.ok ? 0 : 2,
      }),
    );
    if (!result.ok) terminate(2);
    return;
  }

  if (primary) process.stdout.write(primary);
  if (result.diagnostics.length) process.stderr.write(formatDiagnostics(result.diagnostics));
  if (!result.ok) terminate(2);
}

/** An expected, diagnostic-carrying failure: exit 1, in the caller's format. */
function fail(command: PdfCommand, source: string, opts: PdfOptions, item: PdfDiagnostic): never {
  const result: PdfResult = { command, ok: false, source, diagnostics: [item] };
  if (checkFormat(opts) === "json")
    process.stdout.write(jsonPayload(`pdf ${command}`, result, opts, { ok: false, exitCode: 1 }));
  else process.stderr.write(formatDiagnostics([item]));
  terminate(1);
}

/**
 * Catches anything an action did not expect and reports it in the caller's
 * chosen format, so a `--format json` consumer never receives a bare stack trace
 * on stderr. Mirrors `adfActionBoundary`, and takes `source` rather than
 * repeating that function's empty-string placeholder: the file is in scope at
 * every call site and a failure payload that names it is strictly more useful.
 */
export async function pdfActionBoundary(
  command: PdfCommand,
  source: string,
  opts: PdfOptions,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CommandExit) throw error;
    const message = (error as Error).message;
    // Tested raw rather than through checkFormat, which is itself one of the
    // things that may have thrown.
    if (opts.format === "json") {
      const result: PdfResult = {
        command,
        ok: false,
        source,
        diagnostics: [
          diagnostic({
            code: CODES.failure,
            severity: "error",
            quality: "unsupported",
            message,
            remediation: "Correct the invocation, paths, or filesystem condition and retry.",
          }),
        ],
      };
      process.stdout.write(jsonPayload(`pdf ${command}`, result, opts, { ok: false, exitCode: 1 }));
      terminate(1);
    }
    process.stderr.write(`Error: ${message}\n`);
    terminate(1);
  }
}

/** Reads and opens, reporting a read or open failure as exit 1. */
async function open<T>(
  source: string,
  command: PdfCommand,
  opts: PdfOptions,
  body: (handle: OpenDocument, notices: PdfDiagnostic[], bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  const limits = limitsFor(opts, command);
  const read = await readInput(source, limits);
  if (!read.ok) return fail(command, source, opts, read.diagnostic);
  // pdf.js detaches the buffer it is handed, so `images`, which reads the file
  // through its own object layer as well, gets a private copy. Taken for that
  // command only: the others never need the bytes twice.
  const bytes = command === "images" ? read.bytes.slice() : new Uint8Array(0);
  try {
    return await withDocument(read.bytes, limits, (handle) => body(handle, read.notices, bytes));
  } catch (error) {
    if (error instanceof CommandExit) throw error;
    return fail(command, source, opts, await classify(error));
  }
}

/** `--pages`, validated against the real page count rather than trusted. */
function selectPages(
  handle: OpenDocument,
  source: string,
  command: PdfCommand,
  opts: PdfOptions,
): number[] | undefined {
  if (!opts.pages) return undefined;
  const parsed = parsePageRange(opts.pages, handle.doc.numPages);
  if (!parsed.ok) return fail(command, source, opts, parsed.diagnostic);
  return parsed.pages;
}

/** Writes to `--output` when given, and returns the stdout text. */
function emit(result: PdfResult, opts: PdfOptions, body: string): string {
  if (!opts.output) return body;
  writeAtomically(opts.output, body);
  result.output = path.resolve(opts.output);
  return "";
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

export async function pdfInspectAction(source: string, opts: PdfOptions): Promise<void> {
  await open(source, "inspect", opts, async (handle, notices) => {
    const inspected = await inspectDocument(handle, { probeStructure: true });
    const result: PdfResult = {
      command: "inspect",
      ok: true,
      source,
      document: inspected.document,
      pages: inspected.pages,
      diagnostics: [...notices, ...inspected.diagnostics],
    };

    const { document } = inspected;
    const header = [
      `pages: ${document.pageCount}`,
      `tagged: ${document.tagged}`,
      `structure: ${document.structured}`,
      `encrypted: ${document.encrypted}`,
      `text layer: ${document.textLayer}`,
      ...(document.title ? [`title: ${document.title}`] : []),
      ...(document.producer ? [`producer: ${document.producer}`] : []),
      ...(document.created ? [`created: ${document.created}`] : []),
    ];
    const width = Math.max(4, ...inspected.pages.map((page) => String(page.page).length));
    const rows = inspected.pages.map(
      (page) =>
        `${pad(String(page.page), width)}  ${pad(`${page.width}x${page.height}`, 12)}` +
        `  rot ${pad(String(page.rotation), 3)}  ${pad(String(page.characters), 7)}` +
        `  ${pad(String(page.density), 8)}  ${page.textLayer}`,
    );
    output(result, opts, `${[...header, "", ...rows].join("\n")}\n`);
  });
}

export async function pdfTextAction(source: string, opts: PdfOptions): Promise<void> {
  await open(source, "text", opts, async (handle, notices) => {
    const selected = selectPages(handle, source, "text", opts);
    const wanted = selected ?? Array.from({ length: handle.doc.numPages }, (_, index) => index + 1);
    const summary = await documentSummary(handle);
    const diagnostics: PdfDiagnostic[] = [...notices, ...summary.diagnostics];
    const text: PdfTextPage[] = [];

    for (const page of wanted) {
      try {
        const runs = await extractPage(handle, page);
        if (runs.runs.length === 0) {
          diagnostics.push(
            diagnostic({
              code: CODES.noTextLayer,
              quality: "unsupported",
              message: "The page carries no text layer; nothing was extracted from it",
              page,
              remediation:
                "The page is an image. Recognise it with OCR through `cairn pdf ocr`, which keeps the recognised text apart from the text layer.",
            }),
          );
          continue;
        }
        const body = runsToText(runs.runs);
        text.push({ page, text: body, characters: runs.characters });
      } catch (error) {
        // Absent from the payload and reported, rather than present and
        // silently empty: an empty string is indistinguishable from a blank
        // page, and one undecodable page must not lose the other 299.
        diagnostics.push({
          ...(await classify(error, page)),
          code: CODES.contentUndecodable,
        });
      }
    }

    const result: PdfResult = {
      command: "text",
      ok: true,
      source,
      document: summary.document,
      text,
      ...(selected ? { selectedPages: selected } : {}),
      diagnostics,
    };
    // Form feed between pages, as pdftotext does. Matching the ecosystem is
    // worth more than inventing a separator.
    const body = text.map((page) => page.text).join("\f");
    output(result, opts, emit(result, opts, body ? `${body}\n` : ""));
  });
}

export async function pdfOutlineAction(source: string, opts: PdfOptions): Promise<void> {
  await open(source, "outline", opts, async (handle, notices) => {
    const summary = await documentSummary(handle);
    const outline = await readOutline(handle);
    const result: PdfResult = {
      command: "outline",
      ok: true,
      source,
      document: summary.document,
      outline: outline.outline,
      diagnostics: [...notices, ...summary.diagnostics, ...outline.diagnostics],
    };
    output(result, opts, formatOutline(outline.outline));
  });
}

export async function pdfValidateAction(source: string, opts: PdfOptions): Promise<void> {
  await open(source, "validate", opts, async (handle, notices) => {
    const summary = await documentSummary(handle);
    const validated = await validateDocument(handle);
    const diagnostics = [...notices, ...summary.diagnostics, ...validated.diagnostics];
    const errors = diagnostics.filter((item) => item.severity === "error").length;
    const result: PdfResult = {
      command: "validate",
      ok: errors === 0,
      source,
      document: summary.document,
      diagnostics,
    };
    output(
      result,
      opts,
      errors === 0
        ? `valid: no structural errors in ${source}\n`
        : `invalid: ${errors} error(s) in ${source}\n`,
    );
  });
}

export async function pdfToMarkdownAction(source: string, opts: PdfOptions): Promise<void> {
  await open(source, "to-markdown", opts, async (handle, notices) => {
    const selected = selectPages(handle, source, "to-markdown", opts);
    // The outline is read first so a bookmark title can pin a heading's level
    // where the two agree — the cheapest accuracy win in the whole conversion.
    const summary = await documentSummary(handle);
    const outline = await readOutline(handle);
    const converted = await toMarkdown(handle, {
      ...(selected ? { pages: selected } : {}),
      headingLevels: outline.headingLevels,
    });
    const result: PdfResult = {
      command: "to-markdown",
      ok: true,
      source,
      document: summary.document,
      markdown: converted.markdown,
      ...(selected ? { selectedPages: selected } : {}),
      diagnostics: [...notices, ...summary.diagnostics, ...converted.diagnostics],
    };
    output(result, opts, emit(result, opts, converted.markdown));
  });
}

export async function pdfAttachmentsAction(source: string, opts: PdfOptions): Promise<void> {
  await open(source, "attachments", opts, async (handle, notices) => {
    const summary = await documentSummary(handle);
    const read = await readAttachments(handle, {
      ...(opts.extract ? { extract: opts.extract } : {}),
    });
    const result: PdfResult = {
      command: "attachments",
      ok: true,
      source,
      document: summary.document,
      attachments: read.attachments,
      diagnostics: [...notices, ...summary.diagnostics, ...read.diagnostics],
    };
    output(result, opts, formatAttachments(read.attachments));
  });
}

export async function pdfFormsAction(source: string, opts: PdfOptions): Promise<void> {
  await open(source, "forms", opts, async (handle, notices) => {
    const summary = await documentSummary(handle);
    const read = await readForm(handle);
    const result: PdfResult = {
      command: "forms",
      ok: true,
      source,
      document: summary.document,
      form: read.form,
      diagnostics: [...notices, ...summary.diagnostics, ...read.diagnostics],
    };
    output(result, opts, formatForm(read.form));
  });
}

/** A non-negative integer flag, or its default. */
function count(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`Invalid ${flag} value: ${value} (expected a non-negative integer)`);
  return parsed;
}

/** A number in a closed range, or its default. */
function ranged(
  value: string | undefined,
  flag: string,
  fallback: number,
  low: number,
  high: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < low || parsed > high)
    throw new Error(`Invalid ${flag} value: ${value} (expected a number from ${low} to ${high})`);
  return parsed;
}

function refused(code: string, message: string, remediation?: string): PdfDiagnostic {
  return diagnostic({
    code,
    severity: "error",
    quality: "unsupported",
    message,
    ...(remediation ? { remediation } : {}),
  });
}

/** Writes a result as a JSON file: the `images.json` index and `ocr --out`. Validates against `pdf-result`. */
function writeRecord(file: string, result: PdfResult): void {
  writeAtomically(file, `${JSON.stringify(result, null, 2)}\n`);
}

function imageLine(image: PdfImage): string {
  const where = `p${image.page} #${image.index}`;
  const size = `${image.width}x${image.height}`;
  const space = image.colorSpace ?? "mask";
  const filters = image.filters.length ? image.filters.join("+") : "raw";
  const target = image.file ?? `(${image.skipped ?? "not written"})`;
  return `${where.padEnd(10)} ${size.padEnd(11)} ${space.padEnd(24)} ${filters.padEnd(16)} box ${image.box.join(",")}  ${target}`;
}

export async function pdfImagesAction(source: string, opts: PdfOptions): Promise<void> {
  if (!opts.out) throw new Error("--out <dir> is required");
  const out = path.resolve(opts.out);
  if (fs.existsSync(out) && !fs.statSync(out).isDirectory())
    throw new Error(`--out is not a directory: ${opts.out}`);
  const minSize = count(opts.minSize, "--min-size", 0);
  checkFormat(opts);
  await open(source, "images", opts, async (handle, notices, bytes) => {
    const selected = selectPages(handle, source, "images", opts);
    const wanted = selected ?? Array.from({ length: handle.doc.numPages }, (_, index) => index + 1);
    const summary = await documentSummary(handle);
    const { extractImages } = await import("../pdf/images.js");
    const extracted = await extractImages(bytes, handle.doc.numPages, {
      pages: wanted,
      out,
      minSize,
      check: () => handle.check(),
    });
    const result: PdfResult = {
      command: "images",
      ok: true,
      source,
      document: summary.document,
      images: extracted.images,
      ...(selected ? { selectedPages: selected } : {}),
      output: out,
      diagnostics: [...notices, ...summary.diagnostics, ...extracted.diagnostics],
    };
    result.ok = !blocking(result.diagnostics, Boolean(opts.strict));
    writeRecord(path.join(out, "images.json"), result);
    const written = new Set(
      extracted.images.filter((image) => image.file).map((image) => image.file),
    );
    const skipped = extracted.images.filter((image) => image.skipped).length;
    const lines = extracted.images.map(imageLine);
    lines.push(
      `${extracted.images.length} placement(s), ${written.size} file(s) written, ${skipped} skipped -> ${out}`,
    );
    output(result, opts, `${lines.join("\n")}\n`);
  });
}

export async function pdfRenderAction(source: string, opts: PdfOptions): Promise<void> {
  if (!opts.out) throw new Error("--out <file.png> is required");
  if (opts.page === undefined) throw new Error("--page <n> is required");
  const {
    DEFAULT_DPI,
    MAX_DPI,
    MIN_DPI,
    RenderRefused,
    RendererUnavailable,
    parseBox,
    renderRegion,
  } = await import("../pdf/render.js");
  const dpi = ranged(opts.dpi, "--dpi", DEFAULT_DPI, MIN_DPI, MAX_DPI);
  const box = opts.box === undefined ? undefined : parseBox(opts.box);
  if (box === null)
    throw new Error(
      `Invalid --box value: ${opts.box} (expected x0,y0,x1,y1 in points with x1>x0 and y1>y0)`,
    );
  checkFormat(opts);
  const outFile = path.resolve(opts.out);
  await open(source, "render", opts, async (handle, notices) => {
    const page = Number(opts.page);
    if (!Number.isInteger(page) || page < 1 || page > handle.doc.numPages)
      return fail(
        "render",
        source,
        opts,
        refused(
          CODES.pageRangeInvalid,
          `Invalid --page value: ${opts.page}`,
          `This document has ${handle.doc.numPages} page(s).`,
        ),
      );
    const summary = await documentSummary(handle);
    let rendered;
    try {
      rendered = await renderRegion(handle, { page, dpi, ...(box ? { box } : {}) });
    } catch (error) {
      if (error instanceof RendererUnavailable)
        return fail("render", source, opts, refused(CODES.rendererUnavailable, error.message));
      if (error instanceof RenderRefused)
        return fail("render", source, opts, refused(error.code, error.message, error.remediation));
      throw error;
    }
    writeAtomically(outFile, rendered.png);
    const sha256 = crypto.createHash("sha256").update(rendered.png).digest("hex");
    const result: PdfResult = {
      command: "render",
      ok: true,
      source,
      document: summary.document,
      render: {
        page,
        dpi,
        width: rendered.width,
        height: rendered.height,
        box: rendered.box,
        pageBox: rendered.pageBox,
        rotation: rendered.rotation,
        file: outFile,
        bytes: rendered.png.length,
        sha256,
      },
      output: outFile,
      diagnostics: [...notices, ...summary.diagnostics, ...rendered.diagnostics],
    };
    output(
      result,
      opts,
      `page ${page} box ${rendered.box.join(",")} at ${dpi} dpi -> ${rendered.width}x${rendered.height} ${outFile}\n`,
    );
  });
}

/** Default and ceiling for OCR resolution: 300 dpi is what Tesseract is trained around. */
const OCR_DPI = 300;
const OCR_MAX_DPI = 600;
const OCR_MIN_CONFIDENCE = 60;

export async function pdfOcrAction(source: string, opts: PdfOptions): Promise<void> {
  const language = opts.lang ?? "eng";
  const dpi = ranged(opts.dpi, "--dpi", OCR_DPI, 70, OCR_MAX_DPI);
  const minConfidence = ranged(opts.minConfidence, "--min-confidence", OCR_MIN_CONFIDENCE, 0, 100);
  checkFormat(opts);
  const { OcrUnavailable, assemble, locateEngine, recognise } = await import("../pdf/ocr.js");
  const { RendererUnavailable, renderRegion } = await import("../pdf/render.js");
  const settings = {
    ...(opts.tesseract ? { binary: opts.tesseract } : {}),
    ...(opts.tessdata ? { tessdata: opts.tessdata } : {}),
  };
  await open(source, "ocr", opts, async (handle, notices) => {
    const selected = selectPages(handle, source, "ocr", opts);
    let engine;
    try {
      engine = await locateEngine(settings, language, Math.max(1000, handle.remaining()));
    } catch (error) {
      if (error instanceof OcrUnavailable)
        return fail(
          "ocr",
          source,
          opts,
          refused(
            error.code === "engine" ? CODES.ocrEngineMissing : CODES.ocrLanguageMissing,
            error.message,
            error.remediation,
          ),
        );
      throw error;
    }
    const summary = await documentSummary(handle);
    const diagnostics: PdfDiagnostic[] = [...notices, ...summary.diagnostics];

    // Which pages carry a text layer: measured, never assumed.
    const candidates =
      selected ?? Array.from({ length: handle.doc.numPages }, (_, index) => index + 1);
    const layered = new Map<number, boolean>();
    for (const page of candidates) {
      try {
        layered.set(page, (await extractPage(handle, page)).runs.length > 0);
      } catch {
        layered.set(page, false);
      }
    }
    const targets = selected ?? candidates.filter((page) => !layered.get(page));
    if (!targets.length)
      diagnostics.push(
        diagnostic({
          code: CODES.ocrNothingToRecognise,
          quality: "exact",
          message:
            "Every page carries a text layer, so nothing was recognised; name pages with --pages to recognise them anyway",
        }),
      );

    const pages: PdfOcrPage[] = [];
    for (const page of targets) {
      const textLayer = layered.get(page) ? "present" : "absent";
      if (textLayer === "present")
        diagnostics.push(
          diagnostic({
            code: CODES.ocrPageHasTextLayer,
            quality: "exact",
            message:
              "The page already carries a text layer; the recognised text is reported beside it, never merged into it",
            page,
          }),
        );
      let rendered;
      try {
        rendered = await renderRegion(handle, { page, dpi });
      } catch (error) {
        if (error instanceof RendererUnavailable)
          return fail("ocr", source, opts, refused(CODES.rendererUnavailable, error.message));
        throw error;
      }
      diagnostics.push(...rendered.diagnostics);
      let lines;
      try {
        lines = await recognise(engine, settings, rendered.png, {
          language,
          dpi,
          timeoutMs: handle.remaining(),
        });
      } catch (error) {
        handle.check();
        diagnostics.push(
          diagnostic({
            code: CODES.ocrPageUnreadable,
            severity: "error",
            quality: "unsupported",
            message: `The OCR engine could not read the page: ${(error as Error).message}`,
            page,
          }),
        );
        continue;
      }
      const assembled = assemble(lines, rendered.toUser);
      pages.push({ page, source: "ocr", textLayer, ...assembled });
      if (!assembled.words.length)
        diagnostics.push(
          diagnostic({
            code: CODES.ocrPageUnreadable,
            quality: "unsupported",
            message: "The OCR engine found no text on the page",
            page,
          }),
        );
      else if (assembled.confidence !== null && assembled.confidence < minConfidence)
        diagnostics.push(
          diagnostic({
            code: CODES.ocrLowConfidence,
            quality: "approximate",
            message: `Recognition confidence ${assembled.confidence} is below the floor of ${minConfidence}`,
            page,
            remediation: "Check the recognised text against the page image before relying on it.",
          }),
        );
    }

    const result: PdfResult = {
      command: "ocr",
      ok: true,
      source,
      document: summary.document,
      ocr: {
        engine: {
          name: "tesseract",
          version: engine.version,
          languages: language.split("+"),
          dpi,
          psm: 3,
        },
        minConfidence,
        pages,
      },
      ...(selected ? { selectedPages: selected } : {}),
      diagnostics,
    };
    if (opts.out) {
      result.output = path.resolve(opts.out);
      result.ok = !blocking(result.diagnostics, Boolean(opts.strict));
      writeRecord(opts.out, result);
    }
    // Every page is introduced by a marker line, so recognised text cannot be
    // mistaken for a text layer even after it has been piped somewhere else.
    const body = pages
      .map(
        (entry) =>
          `[recognised text: page ${entry.page}, tesseract ${engine.version} ${language}, ` +
          `confidence ${entry.confidence ?? "n/a"}]\n${entry.text}`,
      )
      .join("\f");
    output(result, opts, body ? `${body}\n` : "");
  });
}
