import { severityFor } from "../../mapping-quality.js";
import type { MappingQuality } from "../../mapping-quality.js";
import type { ConversionDiagnostic } from "./types.js";

/**
 * Conversion diagnostic codes.
 *
 * Ranges, and the rule that picks one, are in docs/diagnostics.md: a code is
 * chosen by where the condition is detected, never renumbered, never reused.
 *
 * - `AD0xx` invocation, I/O, and input bounds
 * - `AD1xx` ADF source validation
 * - `AD2xx` ADF to Markdown mapping
 * - `AD3xx` Markdown to ADF mapping and degradation
 * - `AD4xx` reserved for the deferred round-trip fidelity mode
 */
export const CODES = {
  // AD0xx
  failure: "AD001",
  notADocument: "AD002",
  tooLarge: "AD003",
  tooDeep: "AD004",
  notJson: "AD005",
  // AD1xx
  unknownNode: "AD100",
  unknownMark: "AD101",
  illegalContent: "AD110",
  missingContent: "AD111",
  badAttribute: "AD112",
  // AD2xx
  tableFlattened: "AD200",
  taskListApproximated: "AD201",
  panelApproximated: "AD202",
  expandApproximated: "AD203",
  mediaApproximated: "AD204",
  mediaUnresolvable: "AD205",
  decisionApproximated: "AD206",
  layoutCollapsed: "AD207",
  cardApproximated: "AD208",
  inlineApproximated: "AD209",
  extensionDropped: "AD210",
  markDropped: "AD211",
  // AD3xx
  headingFlattened: "AD300",
  blockquoteUnwrapped: "AD301",
  tableFlattenedToRows: "AD302",
  contentDropped: "AD304",
  paragraphSplit: "AD305",
  htmlPreserved: "AD306",
  footnoteApproximated: "AD308",
  frontmatterDropped: "AD309",
  alignmentDropped: "AD310",
  listSplit: "AD311",
} as const;

export interface DiagnosticInput {
  code: string;
  message: string;
  quality: MappingQuality;
  node?: string;
  location?: string;
  remediation?: string;
  /** Overrides the quality-derived severity. Use only to refuse. */
  severity?: ConversionDiagnostic["severity"];
}

export function diagnostic(input: DiagnosticInput): ConversionDiagnostic {
  const { severity, ...rest } = input;
  return {
    code: rest.code,
    severity: severity ?? severityFor(rest.quality),
    message: rest.message,
    quality: rest.quality,
    ...(rest.node ? { node: rest.node } : {}),
    ...(rest.location ? { location: rest.location } : {}),
    ...(rest.remediation ? { remediation: rest.remediation } : {}),
  };
}

/**
 * Collects diagnostics, deduplicated by code, node, and location.
 *
 * Without this a document with 200 flattened table cells reports the condition
 * 200 times and buries every other finding under it.
 */
export class DiagnosticSink {
  private readonly items: ConversionDiagnostic[] = [];
  private readonly seen = new Set<string>();

  add(input: DiagnosticInput): void {
    const key = `${input.code} ${input.node ?? ""} ${input.location ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(diagnostic(input));
  }

  get length(): number {
    return this.items.length;
  }

  /**
   * Sorted by code then location, both by byte comparison rather than
   * `localeCompare`, which is ICU-build dependent and would reorder output on a
   * differently configured runner.
   */
  all(): ConversionDiagnostic[] {
    return [...this.items].sort((a, b) => {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      const left = a.location ?? "";
      const right = b.location ?? "";
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
  }
}
