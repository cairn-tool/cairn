import { CODES, DiagnosticSink } from "./diagnostics.js";
import type { OpenDocument } from "./document.js";
import { hasStructContent } from "./inspect.js";
import type { PdfDiagnostic } from "./types.js";

/**
 * Structural validation, bounded by what pdf.js can actually see.
 *
 * Deliberately **not** a PDF/A, PDF/UA, or PDF/X conformance checker. Full
 * conformance validation is veraPDF's job and is a Java program; claiming it
 * here would be a lie. This is the same line `jira adf validate` draws when it
 * reports `AD100` for a node type it does not model rather than pretending to be
 * Atlassian's schema.
 *
 * Specifically **not** checked, and the docs say so in these words: PDF/A or
 * PDF/UA conformance at any level; digital signature validity, certificate
 * chains, or timestamps; byte-level spec conformance such as `/Length`
 * mismatches or trailing garbage, which pdf.js repairs below the warning
 * threshold; whether the document *renders* correctly, since nothing here
 * rasterizes; whether a glyph in the text layer actually exists in the embedded
 * subset, which is only discoverable at render time; colour spaces, transparency
 * groups, and output intents; and accessibility beyond "a structure tree
 * exists".
 */

export interface WarningPattern {
  pattern: RegExp;
  code: string;
  message: string;
  quality: "approximate" | "unsupported";
}

/**
 * pdf.js warnings this command reports as findings.
 *
 * **The most fragile coupling in the toolset**: these exist only because pdf.js
 * prints a particular English string. That is contained rather than accepted —
 * `tests/unit/pdf-validate.test.ts` drives one case per row from a deliberately
 * damaged fixture, so a pdfjs bump that rewords a message fails the suite
 * instead of quietly turning the check off.
 *
 * An unmatched warning is **not** dropped. It is reported once as `AP120` with
 * the raw text, so a reworded message degrades to "something was recovered here"
 * rather than to silence.
 */
export const WARNING_PATTERNS: readonly WarningPattern[] = [
  {
    pattern: /Indexing all PDF objects/i,
    code: CODES.xrefReconstructed,
    message:
      "The cross-reference table was unusable and the parser rebuilt it by scanning every object",
    quality: "approximate",
  },
  {
    pattern:
      /(fallback|standard) font|Failed to load font|Cannot load system font|font.*not found/i,
    code: CODES.fontSubstituted,
    message: "A font is not embedded or failed to load, and a substitute was used",
    quality: "approximate",
  },
  {
    pattern: /Unsupported (filter|image|stream)|filter.*not supported|JPX|JBIG2/i,
    code: CODES.filterUnsupported,
    message: "A stream uses a filter the parser could not decode",
    quality: "unsupported",
  },
  {
    pattern: /Unable to read mark info|Invalid Metadata|Skipping invalid Metadata/i,
    code: CODES.metadataUnreadable,
    message: "The document's metadata could not be read",
    quality: "approximate",
  },
];

export interface ValidateResult {
  diagnostics: PdfDiagnostic[];
}

/**
 * Walks every page and reports what the parser could not do.
 *
 * No `--pages`: a partial validation that reported "valid" would be a lie, so
 * the command always covers the whole document.
 */
export async function validateDocument(handle: OpenDocument): Promise<ValidateResult> {
  const sink = new DiagnosticSink();
  const { doc } = handle;

  let taggedClaim: boolean;
  try {
    const markInfo = await handle.within(() => doc.getMarkInfo());
    taggedClaim = markInfo instanceof Map && markInfo.get("Marked") === true;
  } catch {
    taggedClaim = false;
  }

  let structured = 0;
  let probed = 0;

  for (let page = 1; page <= doc.numPages; page += 1) {
    try {
      const proxy = await handle.within(() => doc.getPage(page));
      try {
        await handle.within(() => proxy.getTextContent());
      } catch (error) {
        sink.add({
          code: CODES.contentUndecodable,
          severity: "error",
          quality: "unsupported",
          message: `The page's content stream could not be decoded: ${(error as Error).message}`,
          page,
        });
      }
      try {
        const tree = await handle.within(() => proxy.getStructTree());
        probed += 1;
        if (hasStructContent(tree)) structured += 1;
      } catch {
        probed += 1;
      }
      proxy.cleanup();
    } catch (error) {
      // The raw message, not `classify()`'s: that prefixes "Page N:" for callers
      // with nowhere else to put it, and the finding already carries `page`.
      sink.add({
        code: CODES.pageUnreadable,
        severity: "error",
        quality: "unsupported",
        message: (error as Error).message,
        page,
      });
    }
  }

  if (taggedClaim && structured === 0)
    sink.add({
      code: CODES.taggedButEmpty,
      quality: "approximate",
      message:
        "The document declares /MarkInfo <</Marked true>> but no page carries a usable structure tree",
    });
  if (structured > 0 && structured < probed)
    sink.add({
      code: CODES.structPartial,
      quality: "exact",
      message: `A structure tree is present on ${structured} of ${probed} pages`,
    });

  if (handle.encrypted)
    sink.add({
      code: CODES.encryptedOpenPassword,
      quality: "exact",
      message:
        "The document is encrypted but opened without a password, so its restrictions are advisory only",
    });

  // The captured-warning channel. Everything above is a structural probe; these
  // are conditions only the parser can see, and it only reports them in prose.
  const unmatched: string[] = [];
  for (const notice of handle.notices) {
    const match = WARNING_PATTERNS.find((candidate) => candidate.pattern.test(notice));
    if (match) sink.add({ code: match.code, quality: match.quality, message: match.message });
    else if (/^Warning:/i.test(notice)) unmatched.push(notice);
  }
  for (const notice of unmatched.slice(0, 10))
    sink.add({
      code: CODES.parserWarning,
      quality: "approximate",
      message: `The parser recovered from a condition this tool does not classify: ${notice.slice(0, 300)}`,
      construct: notice.slice(0, 60),
    });

  return { diagnostics: sink.all() };
}
