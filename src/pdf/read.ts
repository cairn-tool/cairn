import fs from "node:fs";
import path from "node:path";
import { CODES, diagnostic } from "./diagnostics.js";
import type { PdfDiagnostic } from "./types.js";

/**
 * 64 MiB.
 *
 * Not the 256 MB a PDF's own size limits would suggest. The buffer is resident,
 * it is then *transferred* into the parser, and pdf.js's object cache on top of
 * it commonly runs three to five times the file size — so a 256 MB input is a
 * multi-gigabyte process, and the failure is an OOM abort with no diagnostic at
 * all. That is the shape of failure `MAX_DEPTH` exists to prevent in the ADF
 * reader. Real corpora sit far below this: papers and forms are single-digit
 * megabytes, scanned manuals twenty to eighty, and the tail past 64 MiB is
 * image-only scans that carry no text layer to extract anyway.
 *
 * `--max-bytes` raises it, up to {@link MAX_INPUT_CEILING}.
 */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** The highest `--max-bytes` will accept, so the flag cannot ask for an OOM. */
export const MAX_INPUT_CEILING = 512 * 1024 * 1024;

/**
 * How far in to look for `%PDF-`.
 *
 * The specification and every real reader tolerate leading bytes before the
 * header, and files served through mail gateways routinely have them.
 */
export const HEADER_SCAN_BYTES = 1024;

const SIGNATURE = Buffer.from("%PDF-", "latin1");

export interface ReadLimits {
  maxBytes: number;
}

export type ReadResult =
  | { ok: true; bytes: Uint8Array; notices: PdfDiagnostic[] }
  | { ok: false; diagnostic: PdfDiagnostic };

function refuse(code: string, message: string, remediation?: string): ReadResult {
  return {
    ok: false,
    diagnostic: diagnostic({
      code,
      severity: "error",
      quality: "unsupported",
      message,
      ...(remediation ? { remediation } : {}),
    }),
  };
}

/**
 * Reads stdin to completion, refusing past the cap while it streams.
 *
 * Not `fs.readFileSync(0)`: when stdin is a pipe whose writer has not produced
 * anything yet that throws `EAGAIN` rather than waiting, and piping a document
 * in is a documented workflow. Streaming also means the cap is enforced as the
 * bytes arrive — there is no `fstat` size to consult here, so a reader that
 * buffered first and checked after would happily hold the whole oversized input
 * before deciding it was too big.
 */
async function readStdin(limit: number): Promise<Uint8Array | "too-large"> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) {
      process.stdin.destroy();
      return "too-large";
    }
    chunks.push(buffer);
  }
  return own(Buffer.concat(chunks));
}

/**
 * Copies into an `ArrayBuffer` this process exclusively owns.
 *
 * `getDocument({ data })` **transfers and detaches** what it is given — verified
 * against 6.3.289, where `byteLength` is 0 after the call. Node `Buffer`s below
 * 8 KiB are views into a shared pooled allocator, so handing one over would
 * detach a buffer other parts of the process are still using. Every path out of
 * this module goes through here.
 */
function own(source: Buffer | Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

/** Locates `%PDF-` within the leading bytes; -1 when it is not there. */
function signatureOffset(bytes: Uint8Array): number {
  const window = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, HEADER_SCAN_BYTES + SIGNATURE.length),
  );
  return window.indexOf(SIGNATURE);
}

function leadingHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.subarray(0, 8)).toString("hex").replace(/(..)/g, "$1 ").trim();
}

/**
 * Reads a PDF, from a path or from stdin when `source` is `-`.
 *
 * The guards mirror `readSnippetSource` in `src/snippets.ts` and the ADF reader:
 * resolve through symlinks, refuse anything that is not a regular file *on the
 * open descriptor* so it cannot be swapped between the check and the read, open
 * with `O_NONBLOCK` so a FIFO does not block until a writer appears, and cap the
 * size. The NUL-byte rejection does not carry over — a PDF is binary.
 */
export async function readInput(source: string, limits: ReadLimits): Promise<ReadResult> {
  const notices: PdfDiagnostic[] = [];
  let bytes: Uint8Array;

  if (source === "-") {
    const streamed = await readStdin(limits.maxBytes);
    if (streamed === "too-large")
      return refuse(
        CODES.tooLarge,
        `Input on stdin is larger than ${limits.maxBytes} bytes`,
        "Raise the bound with --max-bytes, or convert a smaller document.",
      );
    bytes = streamed;
  } else {
    const resolved = path.resolve(source);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      return refuse(CODES.notRegularFile, `Input file not found: ${source}`);
    }

    let descriptor: number;
    try {
      descriptor = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch {
      return refuse(CODES.notRegularFile, `Input file could not be opened: ${source}`);
    }

    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile())
        return refuse(CODES.notRegularFile, `Input path is not a regular file: ${source}`);
      if (stat.size > limits.maxBytes)
        return refuse(
          CODES.tooLarge,
          `Input is ${stat.size} bytes, larger than ${limits.maxBytes}`,
          "Raise the bound with --max-bytes, or convert a smaller document.",
        );
      bytes = own(fs.readFileSync(descriptor));
    } finally {
      fs.closeSync(descriptor);
    }
  }

  if (bytes.byteLength === 0) return refuse(CODES.emptyInput, `Input is empty: ${source}`);

  const offset = signatureOffset(bytes);
  if (offset === -1)
    return refuse(
      CODES.notAPdf,
      `Input has no %PDF- signature in its first ${HEADER_SCAN_BYTES} bytes ` +
        `(begins ${leadingHex(bytes)})`,
      "Check that this is a PDF and not an HTML error page, an archive, or another document format.",
    );

  // Accepted, not stripped: the byte offsets in the cross-reference table are
  // measured from the start of the file as it stands, so slicing the prefix off
  // would invalidate every one of them. pdf.js handles the offset itself.
  if (offset > 0)
    notices.push(
      diagnostic({
        code: CODES.leadingBytesIgnored,
        quality: "exact",
        message: `The %PDF- signature is at byte ${offset}, not at the start of the file`,
      }),
    );

  return { ok: true, bytes, notices };
}

export type PageRangeResult =
  { ok: true; pages: number[] } | { ok: false; diagnostic: PdfDiagnostic };

/**
 * Parses `--pages`, e.g. `1,3,5-8`, `-4`, `20-`.
 *
 * Validated against the real page count rather than trusted, and always emitted
 * ascending and deduplicated regardless of the order it was written in —
 * determinism, not convenience: `--pages 5,1` and `--pages 1,5` must produce
 * byte-identical output.
 */
export function parsePageRange(spec: string, pageCount: number): PageRangeResult {
  const selected = new Set<number>();
  const invalid = (detail: string): PageRangeResult => ({
    ok: false,
    diagnostic: diagnostic({
      code: CODES.pageRangeInvalid,
      severity: "error",
      quality: "unsupported",
      message: `Invalid --pages value: ${detail}`,
      remediation: `This document has ${pageCount} page(s). Use a form like 1,3,5-8.`,
    }),
  });

  for (const part of spec.split(",")) {
    const token = part.trim();
    if (!token) return invalid(`empty range in "${spec}"`);

    const match = /^(\d+)?(-)?(\d+)?$/.exec(token);
    if (!match || (!match[1] && !match[3])) return invalid(`"${token}" is not a page or a range`);

    const [, rawStart, dash, rawEnd] = match;
    const start = rawStart ? Number(rawStart) : 1;
    const end = dash ? (rawEnd ? Number(rawEnd) : pageCount) : start;
    if (!dash && rawStart && rawEnd) return invalid(`"${token}" is not a page or a range`);
    if (start < 1 || end < 1) return invalid(`"${token}" names page 0; pages are 1-based`);
    if (start > pageCount || end > pageCount)
      return invalid(`"${token}" is outside 1-${pageCount}`);
    if (start > end) return invalid(`"${token}" runs backwards`);
    for (let page = start; page <= end; page += 1) selected.add(page);
  }

  return { ok: true, pages: [...selected].sort((a, b) => a - b) };
}
