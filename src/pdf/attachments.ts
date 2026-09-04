import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { binaryKind } from "../binary-kind.js";
import { writeAtomically } from "../atomic-write.js";
import type { OpenDocument } from "./document.js";
import { CODES, DiagnosticSink } from "./diagnostics.js";
import type { PdfAttachment, PdfDiagnostic } from "./types.js";

/**
 * Embedded files: inventory, and extraction under `--extract`.
 *
 * Two rules shape the module, and both are security properties rather than
 * conveniences.
 *
 * **Binary never reaches stdout.** `--extract` is the only way bytes leave this
 * command. A command that emits UTF-8 under one flag and a binary blob under
 * another is a contract no consumer can code against.
 *
 * **Extraction is planned before anything is written.** An embedded file's
 * stored name is attacker-controlled and will contain `../` eventually. Every
 * destination is resolved and checked over the whole set first, so a single
 * refused path means nothing is written at all — the same plan-then-write shape
 * `src/agent/install` uses, and deliberately not `archive extract`, which
 * sanitizes with `path.basename` alone and has no collision handling.
 *
 * pdf.js already strips the path — a `/F` of `../../etc/evil.csv` arrives as
 * `filename: "evil.csv"` with `rawFilename` preserved. That is not treated as
 * sufficient. The sanitization here is this command's own, and the payload
 * reports both names so a caller can see what was renamed.
 */

/**
 * Total decoded attachment bytes an inventory will hold at once.
 *
 * The inventory fetches content because size and SHA-256 are what make it
 * actionable, and the document is already resident so a fetch is decompression
 * rather than I/O. The cap bounds a document that claims a thousand large
 * embedded files, and it reports rather than truncating silently.
 */
export const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;

export interface AttachmentsResult {
  attachments: PdfAttachment[];
  diagnostics: PdfDiagnostic[];
}

/** A name is refused outright rather than repaired into something surprising. */
const RESERVED = new Set([".", "..", ""]);

/**
 * Windows device names, which are not writable files on that platform whatever
 * extension follows. Refused on every platform so an extraction behaves the same
 * everywhere rather than only failing on the host that happens to care.
 */
const DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/**
 * The basename this command is willing to write, or null when there is none.
 *
 * Deliberately stricter than "strip the directory": a name that still carries a
 * separator, a NUL, or a drive letter after basename is a name whose author was
 * trying something, and guessing at their intent is how a traversal gets through.
 */
export function sanitizeName(candidate: string): string | null {
  const trimmed = candidate.replace(/\0/g, "").trim();
  if (RESERVED.has(trimmed)) return null;
  // Both separators, because a Windows-authored name reaching a POSIX host keeps
  // its backslashes and `path.basename` here would not treat them as separators.
  const base = trimmed.split(/[/\\]/).pop() ?? "";
  if (RESERVED.has(base)) return null;
  if (/^[A-Za-z]:/.test(base)) return null;
  if (DEVICE.test(base)) return null;
  // Anything left is a plain file name, `.gitignore` included: a leading dot is
  // a real name, and `.` and `..` were already refused above.
  return base || null;
}

/** `name-2.csv`, `name-3.csv`, … — never an overwrite. */
function disambiguate(name: string, taken: Set<string>, directory: string): string {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  let counter = 2;
  while (taken.has(candidate.toLowerCase()) || fs.existsSync(path.join(directory, candidate))) {
    candidate = `${stem}-${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}

interface Planned {
  attachment: PdfAttachment;
  content: Uint8Array;
  destination: string;
}

export async function readAttachments(
  handle: OpenDocument,
  options: { extract?: string } = {},
): Promise<AttachmentsResult> {
  const sink = new DiagnosticSink();
  const entries = await handle.within(() => handle.doc.getAttachments());
  if (!entries || entries.size === 0) return { attachments: [], diagnostics: sink.all() };

  const keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const attachments: PdfAttachment[] = [];
  const contents = new Map<string, Uint8Array>();
  let budget = 0;

  for (const id of keys) {
    const entry = entries.get(id) ?? {};
    const rawFilename = entry.rawFilename ?? entry.filename ?? id;
    const filename = entry.filename ?? id;
    const attachment: PdfAttachment = {
      id,
      filename,
      rawFilename,
      ...(entry.description ? { description: entry.description } : {}),
    };

    if (budget >= MAX_ATTACHMENT_BYTES) {
      sink.add({
        code: CODES.attachmentBudgetReached,
        quality: "approximate",
        construct: filename,
        message: `Attachment budget of ${MAX_ATTACHMENT_BYTES} bytes reached; '${filename}' was listed without size or hash`,
        remediation: "Extract the earlier attachments first, or read the document in parts.",
      });
      attachments.push(attachment);
      continue;
    }

    let content: Uint8Array | null;
    try {
      content = await handle.within(() => handle.doc.getAttachmentContent(id));
    } catch {
      content = null;
    }
    if (!content) {
      sink.add({
        code: CODES.attachmentUnreadable,
        quality: "approximate",
        construct: filename,
        message: `Attachment '${filename}' could not be decoded; it is listed without size or hash`,
      });
      attachments.push(attachment);
      continue;
    }

    const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    budget += buffer.byteLength;
    attachment.bytes = buffer.byteLength;
    attachment.sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const kind = binaryKind(buffer);
    if (kind) attachment.binary = kind;
    contents.set(id, content);
    attachments.push(attachment);
  }

  if (!options.extract) return { attachments, diagnostics: sink.all() };

  // ---- Planning. Nothing below this line writes until every entry is resolved.
  const directory = path.resolve(options.extract);
  const real = fs.existsSync(directory) ? fs.realpathSync(directory) : directory;
  if (fs.existsSync(real) && !fs.statSync(real).isDirectory())
    throw new Error(`--extract is not a directory: ${options.extract}`);

  const taken = new Set<string>();
  const plan: Planned[] = [];
  let refused = false;

  for (const attachment of attachments) {
    const content = contents.get(attachment.id);
    if (!content) continue;

    const safe = sanitizeName(attachment.filename) ?? sanitizeName(attachment.rawFilename);
    if (!safe) {
      sink.add({
        code: CODES.attachmentPathRefused,
        severity: "error",
        quality: "unsupported",
        construct: attachment.rawFilename,
        message: `Attachment '${attachment.rawFilename}' has no name that can be safely written`,
        remediation: "Nothing was extracted. Inspect the document before trusting its file names.",
      });
      refused = true;
      continue;
    }
    if (safe !== attachment.rawFilename)
      sink.add({
        code: CODES.attachmentNameSanitized,
        quality: "approximate",
        construct: attachment.rawFilename,
        message: `Stored name '${attachment.rawFilename}' was sanitized to '${safe}' before writing`,
      });

    const chosen = disambiguate(safe, taken, real);
    if (chosen !== safe)
      sink.add({
        code: CODES.attachmentNameCollided,
        quality: "exact",
        construct: safe,
        message: `'${safe}' already exists or was already claimed; written as '${chosen}'`,
      });

    const destination = path.resolve(real, chosen);
    // Belt and braces: `chosen` carries no separator by construction, so this
    // cannot fail — which is exactly why it is cheap to assert rather than trust.
    const relative = path.relative(real, destination);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      sink.add({
        code: CODES.attachmentPathRefused,
        severity: "error",
        quality: "unsupported",
        construct: chosen,
        message: `Destination for '${chosen}' escapes ${options.extract}`,
        remediation: "Nothing was extracted.",
      });
      refused = true;
      continue;
    }

    taken.add(chosen.toLowerCase());
    plan.push({ attachment, content, destination });
  }

  if (refused) return { attachments, diagnostics: sink.all() };

  // The collision check above ran during planning, so a file appearing in the
  // target between then and now would still be replaced. That window is left
  // open deliberately: closing it means either writing some files and refusing
  // others — which breaks the all-or-nothing property that makes a refusal
  // safe to act on — or holding the directory locked, which a local extraction
  // tool has no business doing.
  fs.mkdirSync(real, { recursive: true });
  for (const item of plan) {
    writeAtomically(item.destination, item.content);
    item.attachment.written = item.destination;
  }
  return { attachments, diagnostics: sink.all() };
}

/** The human and llm rendering: one line per embedded file. */
export function formatAttachments(attachments: PdfAttachment[]): string {
  if (attachments.length === 0) return "no embedded files\n";
  const width = Math.max(...attachments.map((item) => item.filename.length));
  const lines = attachments.map((item) => {
    const size = item.bytes === undefined ? "        ?" : String(item.bytes).padStart(9);
    const hash = item.sha256 ? ` ${item.sha256.slice(0, 12)}` : " ".repeat(13);
    const flags = [item.binary ?? "", item.written ? `-> ${item.written}` : ""].filter(Boolean);
    const suffix = flags.length ? `  ${flags.join("  ")}` : "";
    return `${size}${hash}  ${item.filename.padEnd(width)}${suffix}`;
  });
  return `${lines.join("\n")}\n`;
}
