import { severityFor } from "../mapping-quality.js";
import type { MappingQuality, PdfDiagnostic } from "./types.js";

/**
 * Every `AP###` code, grouped by where the condition is detected.
 *
 * The range follows the detection site, never the command the user typed — the
 * same rule the `AB` and `AD` families follow, which is why `AP020` is emitted
 * by both `pdf text` and `pdf validate`. A retired code is never reused: a
 * consumer may still be suppressing it.
 *
 * `tests/unit/diagnostic-codes.test.ts` fails on a code emitted here that
 * `docs/formats/diagnostic-codes.md` does not document, *and* on a documented
 * code nothing emits. Add both halves in the same change.
 */
export const CODES = {
  // AP0xx  invocation, input bounds, and opening the document
  failure: "AP001",
  notAPdf: "AP002",
  tooLarge: "AP003",
  notRegularFile: "AP004",
  timedOut: "AP005",
  emptyInput: "AP006",
  leadingBytesIgnored: "AP007",
  passwordRequired: "AP010",
  passwordIncorrect: "AP011",
  tooManyPages: "AP012",
  pageRangeInvalid: "AP013",

  // AP02x  the page tree and per-page decoding
  pageUnreadable: "AP020",
  contentUndecodable: "AP021",

  // AP05x  the text layer
  noTextLayer: "AP050",

  // AP08x  the outline
  destinationUnresolved: "AP080",
  outlineTooDeep: "AP081",

  // AP1xx  structural integrity, reported by validate
  unparseable: "AP100",
  xrefReconstructed: "AP101",
  fontSubstituted: "AP110",
  filterUnsupported: "AP111",
  metadataUnreadable: "AP112",
  encryptedOpenPassword: "AP113",
  taggedButEmpty: "AP114",
  structPartial: "AP115",
  parserWarning: "AP120",

  // AP2xx  conversion to Markdown
  conversionPath: "AP200",
  readingOrderUncertain: "AP201",
  tableFlattened: "AP202",
  rotatedTextDropped: "AP203",
  artifactsRemoved: "AP205",
  paragraphSpansPages: "AP206",
  pageSubsetConverted: "AP208",
  columnsDetected: "AP210",
  headingLevelsCollapsed: "AP211",
  listNumberingLost: "AP213",
  hyphenationRejoined: "AP214",
  figureTextOnly: "AP216",
  unknownRole: "AP219",
  cellSpanDropped: "AP220",
  headingLevelInferred: "AP224",
  listOrderingInferred: "AP225",
  inlineStyleInferred: "AP230",
  ligaturesExpanded: "AP231",
  controlCharactersStripped: "AP232",

  // AP3xx  embedded files and form fields
  attachmentUnreadable: "AP300",
  attachmentNameSanitized: "AP301",
  attachmentNameCollided: "AP302",
  attachmentPathRefused: "AP303",
  attachmentBudgetReached: "AP304",
  formXfa: "AP311",
  formFieldPageUnresolved: "AP312",
} as const;

export interface DiagnosticInput {
  code: string;
  message: string;
  quality: MappingQuality;
  page?: number;
  construct?: string;
  remediation?: string;
  /** Overrides the quality-derived severity. Use only to refuse. */
  severity?: DiagnosticSeverityOverride;
}

type DiagnosticSeverityOverride = PdfDiagnostic["severity"];

/**
 * Builds a finding, deriving severity from quality unless overridden.
 *
 * Optional fields are spread conditionally so an absent one never serializes as
 * `undefined` — the payload is published and a null-ish key is a contract
 * change nobody meant to make.
 */
export function diagnostic(input: DiagnosticInput): PdfDiagnostic {
  const { code, message, quality, severity, page, construct, remediation } = input;
  return {
    code,
    severity: severity ?? severityFor(quality),
    message,
    quality,
    ...(page !== undefined ? { page } : {}),
    ...(construct ? { construct } : {}),
    ...(remediation ? { remediation } : {}),
  };
}

/**
 * Collects findings, deduplicating and ordering them.
 *
 * Deliberately a copy of `src/jira/adf/diagnostics.ts`'s sink rather than a
 * shared generic. The two differ in the one place that matters: this one orders
 * by *numeric* page before the construct, because a bytewise sort puts page 10
 * before page 2 and a reader scanning a 300-page document's findings would be
 * reading them out of order. Parameterizing a shared sink on a key function and
 * a comparator is more type noise than the twenty-five duplicated lines remove.
 */
export class DiagnosticSink {
  private readonly items: PdfDiagnostic[] = [];
  private readonly seen = new Set<string>();

  add(input: DiagnosticInput): void {
    const key = `${input.code} ${input.construct ?? ""} ${input.page ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(diagnostic(input));
  }

  get length(): number {
    return this.items.length;
  }

  /**
   * A copy, ordered by code, then page, then construct.
   *
   * The construct comparison is byte comparison, never `localeCompare`: that is
   * ICU-build and locale dependent, so a differently configured CI runner would
   * reorder the payload.
   */
  all(): PdfDiagnostic[] {
    return [...this.items].sort((a, b) => {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      const pageA = a.page ?? 0;
      const pageB = b.page ?? 0;
      if (pageA !== pageB) return pageA - pageB;
      const left = a.construct ?? "";
      const right = b.construct ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
}
