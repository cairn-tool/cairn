import fs from "node:fs";
import path from "node:path";
import { CODES, diagnostic } from "./diagnostics.js";
import type { AdfDocument, AdfNode, ConversionDiagnostic } from "./types.js";

/**
 * Matches the snippet reader's cap. ADF documents are prose, not archives, and
 * an issue description past two megabytes is a sign of something other than an
 * issue description.
 */
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

/**
 * Maximum ADF nesting depth.
 *
 * ADF is a recursive tree and both converters walk it recursively, so this is a
 * correctness guard rather than hygiene: without it a document nested a few
 * hundred thousand deep exits with a stack overflow and no diagnostic, which for
 * input arriving off a network is the wrong failure.
 */
export const MAX_DEPTH = 200;

export type ReadResult =
  { ok: true; content: string } | { ok: false; diagnostic: ConversionDiagnostic };

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Reads a conversion input, from a path or from stdin when `source` is `-`.
 *
 * The guards mirror `readSnippetSource` in src/snippets.ts, which bounds reads
 * of files named by analyzed content. Here the content itself arrives from a
 * REST API, so the same treatment applies: resolve through symlinks, refuse
 * anything that is not a regular file, cap the size, and reject NUL.
 */
/**
 * Reads stdin to completion.
 *
 * Not `fs.readFileSync(0)`: when stdin is a pipe whose writer has not produced
 * anything yet, that throws `EAGAIN` rather than waiting — and
 * `curl | jq | cairn jira adf to-markdown -` is the primary documented workflow, so
 * the failure would land squarely on the common case. Streaming the descriptor
 * waits properly.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readInput(source: string, containmentRoot?: string): Promise<ReadResult> {
  if (source === "-") {
    const content = await readStdin();
    return content.includes("\0")
      ? {
          ok: false,
          diagnostic: diagnostic({
            code: CODES.notJson,
            severity: "error",
            quality: "unsupported",
            message: "Input contains a NUL byte, so it is not text",
          }),
        }
      : { ok: true, content };
  }

  const resolved = path.resolve(source);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic({
        code: CODES.failure,
        severity: "error",
        quality: "unsupported",
        message: `Input file not found: ${source}`,
      }),
    };
  }

  if (containmentRoot !== undefined) {
    let realRoot = containmentRoot;
    try {
      realRoot = fs.realpathSync(containmentRoot);
    } catch {
      // An unresolvable root can only make the check stricter.
    }
    if (!contained(realRoot, real))
      return {
        ok: false,
        diagnostic: diagnostic({
          code: CODES.failure,
          severity: "error",
          quality: "unsupported",
          message: `Input file is outside the permitted root: ${source}`,
        }),
      };
  }

  // Checked on the open descriptor, not on the path, so the file cannot be
  // swapped between the check and the read. O_NONBLOCK is what makes that safe
  // to do here: opening a FIFO without it blocks until a writer appears, which
  // is the very hazard the regular-file check exists to prevent.
  let descriptor: number;
  try {
    descriptor = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic({
        code: CODES.failure,
        severity: "error",
        quality: "unsupported",
        message: `Input file could not be opened: ${source}`,
      }),
    };
  }

  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile())
      return {
        ok: false,
        diagnostic: diagnostic({
          code: CODES.failure,
          severity: "error",
          quality: "unsupported",
          message: `Input path is not a regular file: ${source}`,
        }),
      };
    if (stat.size > MAX_INPUT_BYTES)
      return {
        ok: false,
        diagnostic: diagnostic({
          code: CODES.tooLarge,
          severity: "error",
          quality: "unsupported",
          message: `Input is larger than ${MAX_INPUT_BYTES} bytes`,
          remediation: "Split the document, or convert the field you actually need.",
        }),
      };

    const content = fs.readFileSync(descriptor, "utf8");
    if (content.includes("\0"))
      return {
        ok: false,
        diagnostic: diagnostic({
          code: CODES.notJson,
          severity: "error",
          quality: "unsupported",
          message: `Input contains a NUL byte, so it is not text: ${source}`,
        }),
      };
    return { ok: true, content };
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Keys a Jira REST response uses for a rich-text field, in the order to suggest. */
const WRAPPER_FIELDS = ["fields.description", "fields.summary", "body", "comment.body"];

function depthOf(node: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(node))
    return node.reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
  if (!node || typeof node !== "object") return depth;
  let max = depth;
  for (const value of Object.values(node as Record<string, unknown>))
    max = Math.max(max, depthOf(value, depth + 1));
  return max;
}

/**
 * Finds a plausible ADF document nested inside an arbitrary object.
 *
 * Used only to write a better error. The tool converts a bare ADF document and
 * knows nothing about the Jira response wrapper, so this never *extracts* the
 * document — it only lets AD002 say which field to pull out, which is the
 * likeliest first mistake anyone makes and the one place a good message replaces
 * a whole option.
 */
function locateNested(value: unknown, trail: string[] = [], found: string[] = []): string[] {
  if (found.length > 3 || !value || typeof value !== "object") return found;
  if (Array.isArray(value)) return found;
  const record = value as Record<string, unknown>;
  if (record.type === "doc" && Array.isArray(record.content)) found.push(trail.join("."));
  for (const [key, child] of Object.entries(record)) locateNested(child, [...trail, key], found);
  return found;
}

export type ParseResult =
  { ok: true; document: AdfDocument } | { ok: false; diagnostic: ConversionDiagnostic };

/** Parses and shape-checks an ADF document, without validating its content model. */
export function parseAdfDocument(content: string, source: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostic: diagnostic({
        code: CODES.notJson,
        severity: "error",
        quality: "unsupported",
        message: `Input is not valid JSON: ${(error as Error).message}`,
      }),
    };
  }

  const isDocument =
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "doc";

  if (!isDocument) {
    const nested = locateNested(value).filter(Boolean);
    const suggestion = nested.length
      ? `Extract it first, for example: jq .${nested[0]} ${source === "-" ? "" : source}`.trim()
      : `This command converts a bare ADF document — an object with "type": "doc". A Jira REST response nests one under a field such as ${WRAPPER_FIELDS.join(" or ")}; extract it with jq first.`;
    return {
      ok: false,
      diagnostic: diagnostic({
        code: CODES.notADocument,
        severity: "error",
        quality: "unsupported",
        message: nested.length
          ? `Input is not an ADF document, but one appears at .${nested[0]}`
          : 'Input is not an ADF document: no top-level "type": "doc"',
        remediation: suggestion,
      }),
    };
  }

  const depth = depthOf(value);
  if (depth > MAX_DEPTH)
    return {
      ok: false,
      diagnostic: diagnostic({
        code: CODES.tooDeep,
        severity: "error",
        quality: "unsupported",
        message: `Input nests deeper than ${MAX_DEPTH} levels`,
      }),
    };

  const record = value as Record<string, unknown>;
  return {
    ok: true,
    document: {
      version: typeof record.version === "number" ? record.version : 1,
      type: "doc",
      content: Array.isArray(record.content) ? (record.content as AdfNode[]) : [],
    },
  };
}
