import { createRequire } from "node:module";
import path from "node:path";
import { CODES, diagnostic } from "./diagnostics.js";
import type { PdfDiagnostic } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The single place a PDF is opened.
 *
 * Everything hostile about the format is contained here: one hardened option
 * set, one console capture, one deadline, one teardown, and one place a pdf.js
 * exception becomes an `AP###`. Every other module in `src/pdf` receives an
 * already-open handle and never imports pdfjs itself.
 */

/**
 * The minimum of pdf.js this project uses, written out by hand.
 *
 * Same discipline as `src/sqlite.ts`: `tsconfig` sets `declaration: true`, so a
 * pdfjs type appearing in an exported signature would put that package's types
 * into cairn's published `.d.ts`. pdfjs's own definitions are also JSDoc-derived
 * and `any`-heavy, which would leak straight through.
 */
export interface PdfTextItem {
  str?: string;
  dir?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
  /** Marked-content items carry these two instead. */
  type?: string;
  id?: string;
}

export interface PdfTextStyle {
  fontFamily?: string;
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

export interface PdfStructNode {
  role?: string;
  type?: string;
  id?: string;
  children?: PdfStructNode[];
}

export interface PdfViewport {
  width: number;
  height: number;
  rotation: number;
  convertToViewportPoint(x: number, y: number): number[];
}

export interface PdfPageHandle {
  getViewport(params: { scale: number }): PdfViewport;
  getTextContent(params?: {
    includeMarkedContent?: boolean;
  }): Promise<{ items: PdfTextItem[]; styles: Record<string, PdfTextStyle> }>;
  getStructTree(): Promise<PdfStructNode | null>;
  cleanup(): boolean;
}

export interface PdfDocumentHandle {
  numPages: number;
  getPage(page: number): Promise<PdfPageHandle>;
  getMetadata(): Promise<{ info?: Record<string, unknown>; metadata?: unknown }>;
  getOutline(): Promise<any[] | null>;
  getDestination(id: string): Promise<any[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  getMarkInfo(): Promise<unknown>;
  getPermissions(): Promise<Set<number> | null>;
  cleanup(): Promise<unknown>;
}

/** What every command works against. */
export interface OpenDocument {
  doc: PdfDocumentHandle;
  /** Warnings pdf.js emitted while this document was open, in emission order. */
  notices: readonly string[];
  /** True when a password was supplied and accepted, or none was needed. */
  encrypted: boolean;
  /** Races a pdfjs promise against the deadline. */
  within<T>(work: () => Promise<T>): Promise<T>;
}

export interface OpenOptions {
  /** Wall-clock budget in milliseconds for the whole operation. */
  timeoutMs: number;
  /** Refuse a document with more pages than this before touching any of them. */
  maxPages: number;
}

/** Raised when the wall-clock budget expires. Classified as `AP005`. */
export class DeadlineExceeded extends Error {
  constructor(readonly ms: number) {
    super(`Exceeded the ${ms}ms budget`);
    this.name = "DeadlineExceeded";
  }
}

/** Raised when the install is broken, rather than the document. */
export class PdfjsUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `The PDF parser could not be loaded (${cause}). Reinstall @cairn-tool/cairn; ` +
        "this is an installation problem rather than a problem with the document.",
    );
    this.name = "PdfjsUnavailableError";
  }
}

/**
 * Resolves pdfjs's asset directories.
 *
 * `createRequire(import.meta.url)` is the idiom `src/sqlite.ts` already uses.
 * Resolving `package.json` rather than the entry point lands at the package root
 * with no `..` climbing, and works because pdfjs-dist publishes no `exports`
 * map.
 *
 * These are **runtime resolutions into another package's directory, not files
 * cairn packs**. Nothing here belongs in `package.json` `files`; this looks like
 * the `.markdownlintrc` packaging trap and is not one.
 */
function pdfjsRoot(): string {
  try {
    return path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  } catch (error) {
    throw new PdfjsUnavailableError((error as Error).message);
  }
}

/**
 * A trailing separator is load-bearing: pdf.js concatenates
 * `cMapUrl + name + ".bcmap"`, so omitting it produces a wrong path, no cmap,
 * and silently missing CJK text — a degradation indistinguishable from success.
 */
function assetDir(root: string, name: string): string {
  return `${path.join(root, name)}${path.sep}`;
}

let cached: any;

/**
 * Imports the **legacy** build.
 *
 * Not a preference. The package-root entry prints
 * "Please use the `legacy` build in Node.js environments" and then throws
 * `hashOriginal.toHex is not a function`: it assumes a V8 with
 * `Uint8Array.prototype.toHex`, which Node 22 and 23 do not have. The legacy
 * build works across cairn's whole `engines` range.
 *
 * The `process.emitWarning` swap is the same guard `src/sqlite.ts` applies to
 * `node:sqlite`: stderr carries the diagnostics stream, and an experimental
 * warning emitted at import time would land in it.
 */
async function loadPdfjs(): Promise<any> {
  if (cached) return cached;
  const emit = process.emitWarning;
  try {
    process.emitWarning = () => {};
    cached = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    throw new PdfjsUnavailableError((error as Error).message);
  } finally {
    process.emitWarning = emit;
  }
  return cached;
}

/**
 * A pathological document can emit a warning per object; past this the count is
 * kept and the text is dropped.
 */
const CAPTURE_CAP = 2000;

/**
 * Opens a document, runs `body`, and tears down — in that order, always.
 *
 * A scoped-resource function rather than an open/close pair so a caller cannot
 * forget the teardown. On 6.3.289 pdf.js uses the main-thread fake worker in
 * Node (no worker thread is spawned, verified), so a leaked handle does not hang
 * the process — but `destroy()` still releases the parsed object graph, and a
 * future version spawning a real worker would make it load-bearing.
 */
export async function withDocument<T>(
  data: Uint8Array,
  options: OpenOptions,
  body: (handle: OpenDocument) => Promise<T>,
): Promise<T> {
  const pdfjs = await loadPdfjs();
  const root = pdfjsRoot();

  // pdf.js refuses a Node `Buffer` outright — "Please provide binary data as
  // `Uint8Array`" — even though a Buffer is one. `read.ts` already hands over a
  // plain array it owns, but normalizing here means no caller can get it wrong,
  // and this is the site whose job is to absorb exactly that.
  const bytes = data.constructor === Uint8Array ? data : Uint8Array.from(data as ArrayLike<number>);

  const captured: string[] = [];
  let dropped = 0;
  const saved = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  const capture = (...args: unknown[]): void => {
    if (captured.length < CAPTURE_CAP) captured.push(args.map(String).join(" "));
    else dropped += 1;
  };

  // Captured rather than silenced. pdf.js routes warn() to console.warn, which
  // is stderr — the stream that carries this toolset's diagnostics and must be
  // empty on a clean run. Capturing also gives `validate` its only signal for a
  // reconstructed xref, a substituted font, or an unsupported filter; setting
  // verbosity to ERRORS would keep stderr clean and take those away.
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  console.info = capture;
  console.debug = capture;

  const deadline = Date.now() + options.timeoutMs;
  const within = async <R>(work: () => Promise<R>): Promise<R> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DeadlineExceeded(options.timeoutMs);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          // unref'd, or the timer itself keeps the event loop alive and the CLI
          // waits out the whole budget after it has already written its output.
          timer = setTimeout(() => reject(new DeadlineExceeded(options.timeoutMs)), remaining);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let task: any;
  try {
    let needsPassword = false;
    task = pdfjs.getDocument({
      data: bytes,
      // No `url` and no `docBaseUrl`: absence is the hardening. Supplying either
      // would make pdf.js the thing performing I/O, and the toolset could no
      // longer claim it does not reach the network.
      verbosity: pdfjs.VerbosityLevel.WARNINGS,
      cMapUrl: assetDir(root, "cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assetDir(root, "standard_fonts"),
      iccUrl: assetDir(root, "iccs"),
      wasmUrl: assetDir(root, "wasm"),
      useWasm: false,
      // The field that actually keeps the no-network claim true: it forces the
      // main thread to supply cmap and font bytes from the paths above instead
      // of letting the worker call fetch().
      useWorkerFetch: false,
      // Probing the host's installed fonts would make output machine-dependent.
      useSystemFonts: false,
      disableFontFace: true,
      // Always false, in every command. Enumerating every damaged page is worth
      // more than dying on the first, and `--strict` changes the exit rule
      // rather than the parse.
      stopAtErrors: false,
      maxImageSize: 32 * 1024 * 1024,
    });

    // Never prompts: a CLI that blocks on a TTY read is unusable in a pipeline.
    // There is no --password flag, so this only ever refuses.
    task.onPassword = (reply: (value: unknown) => void) => {
      needsPassword = true;
      reply(new Error("password required"));
    };

    const doc = (await within(() => task.promise)) as PdfDocumentHandle;

    if (doc.numPages > options.maxPages)
      throw new PageBudgetExceeded(doc.numPages, options.maxPages);
    void needsPassword;

    const permissions = await within(() => doc.getPermissions());
    const handle: OpenDocument = {
      doc,
      notices: captured,
      // getPermissions() returns null on an unencrypted document and a Set on an
      // encrypted one, verified against 6.3.289 — so a non-null result here with
      // no password supplied means the document opened on an empty user
      // password, and its restrictions are advisory only.
      encrypted: permissions !== null,
      within,
    };
    return await body(handle);
  } finally {
    // destroy() first, restore second. pdf.js fires callbacks during teardown,
    // and restoring the console before the worker is gone lets a late warning
    // escape onto a stream that is carrying a payload.
    if (task) {
      try {
        await task.destroy();
      } catch {
        // Teardown failure cannot change the answer already computed.
      }
    }
    Object.assign(console, saved);
    if (dropped > 0) captured.push(`(${dropped} further parser messages dropped)`);
  }
}

/** Raised before any page is touched, when the document is larger than allowed. */
export class PageBudgetExceeded extends Error {
  constructor(
    readonly pages: number,
    readonly limit: number,
  ) {
    super(`Document has ${pages} pages, more than the ${limit} allowed`);
    this.name = "PageBudgetExceeded";
  }
}

/**
 * Maps a thrown value onto a finding.
 *
 * Matched by class where pdf.js exports one, never by `error.name`: a name is a
 * string that has drifted before, and the classes are exported precisely so a
 * consumer can branch on them.
 *
 * The distinction between `AP002` and `AP100` is worth keeping: `AP002` means
 * the bytes never had a `%PDF-` header, decided by `read.ts` before pdf.js ran,
 * and `AP100` means it looked like a PDF and could not be parsed. That is the
 * difference between "wrong file" and "damaged file".
 */
export async function classify(error: unknown, page?: number): Promise<PdfDiagnostic> {
  const pdfjs = await loadPdfjs().catch(() => null);
  const message = error instanceof Error ? error.message : String(error);

  const build = (code: string, text: string, remediation?: string): PdfDiagnostic =>
    diagnostic({
      code,
      severity: "error",
      quality: "unsupported",
      message: text,
      ...(page !== undefined ? { page } : {}),
      ...(remediation ? { remediation } : {}),
    });

  if (error instanceof DeadlineExceeded)
    return build(CODES.timedOut, message, "Raise the budget with --timeout.");
  if (error instanceof PageBudgetExceeded)
    return build(CODES.tooManyPages, message, "Raise the bound with --max-pages.");
  if (error instanceof PdfjsUnavailableError) return build(CODES.failure, message);

  if (pdfjs) {
    if (error instanceof pdfjs.PasswordException) {
      const incorrect =
        (error as { code?: number }).code === pdfjs.PasswordResponses?.INCORRECT_PASSWORD;
      return build(
        incorrect ? CODES.passwordIncorrect : CODES.passwordRequired,
        incorrect
          ? "The document was encrypted with a password this tool was not given"
          : "The document is encrypted and requires a password to open",
        "This toolset takes no password. Decrypt the document with another tool first.",
      );
    }
    if (error instanceof pdfjs.InvalidPDFException)
      return build(
        CODES.unparseable,
        `The document could not be parsed even after recovery: ${message}`,
      );
    if (pdfjs.ResponseException && error instanceof pdfjs.ResponseException)
      return build(
        CODES.failure,
        `The parser attempted a network request, which should be impossible: ${message}`,
        "Report this: it means a hardening option stopped taking effect.",
      );
  }

  if (page !== undefined) return build(CODES.pageUnreadable, `Page ${page}: ${message}`);
  return build(CODES.failure, message);
}
