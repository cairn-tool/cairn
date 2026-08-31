import type { MappingQuality } from "../../mapping-quality.js";

export type { MappingQuality } from "../../mapping-quality.js";

/** An ADF mark: inline formatting attached to a text node. */
export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * An ADF node.
 *
 * Deliberately structural rather than a discriminated union over the ~40 node
 * types. The converters branch on `type` through the profile's tables, and a
 * union would have to be widened every time Atlassian adds a node — which is
 * the case that must reach `AD100` rather than failing to compile.
 */
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
  /** Present only on `text` nodes. */
  text?: string;
}

/** The root of an ADF document. `version` is the document version, always 1. */
export interface AdfDocument extends AdfNode {
  version: number;
  type: "doc";
}

/**
 * A conversion finding.
 *
 * The third finding record in this tool, and not interchangeable with the other
 * two: `Issue` carries no severity or quality, and `AgentDiagnostic`'s published
 * schema pins `code` to `^AB[0-9]{3}$` and carries agent-bundle concepts in
 * `target` and `profile`. See docs/diagnostics.md.
 */
export interface ConversionDiagnostic {
  code: string;
  severity: "notice" | "warning" | "error";
  message: string;
  quality: MappingQuality;
  /** ADF node or mark type the finding concerns. */
  node?: string;
  /** Slash-joined ancestor types, e.g. `doc/bulletList/listItem`. */
  location?: string;
  remediation?: string;
}

export type AdfCommand = "to-markdown" | "from-markdown" | "validate" | "inspect";

/** One row of `jira adf inspect`'s inventory. */
export interface InventoryEntry {
  /** Node or mark type. */
  type: string;
  kind: "node" | "mark";
  count: number;
  /** How this construct survives a conversion to Markdown. */
  quality: MappingQuality;
  note: string;
}

export interface AdfResult {
  command: AdfCommand;
  ok: boolean;
  /** Input path, or `-` for stdin. */
  source: string;
  /** Emitted by `to-markdown`. */
  markdown?: string;
  /** Emitted by `from-markdown`. */
  adf?: AdfDocument;
  /** Emitted by `inspect`. */
  inventory?: InventoryEntry[];
  /** Where `--output` wrote, when it was given. */
  output?: string;
  diagnostics: ConversionDiagnostic[];
}
