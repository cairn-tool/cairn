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
import type { PdfCommand, PdfDiagnostic, PdfResult, PdfTextPage } from "../pdf/types.js";

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

function limitsFor(opts: PdfOptions): { maxBytes: number; timeoutMs: number; maxPages: number } {
  return {
    maxBytes: bounded(opts.maxBytes, "--max-bytes", MAX_INPUT_BYTES, MAX_INPUT_CEILING),
    timeoutMs: bounded(opts.timeout, "--timeout", DEFAULT_TIMEOUT_MS),
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
  body: (handle: OpenDocument, notices: PdfDiagnostic[]) => Promise<T>,
): Promise<T> {
  const limits = limitsFor(opts);
  const read = await readInput(source, limits);
  if (!read.ok) return fail(command, source, opts, read.diagnostic);
  try {
    return await withDocument(read.bytes, limits, (handle) => body(handle, read.notices));
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
                "The page is an image. Recognizing its text needs OCR, which this toolset does not do.",
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
