import type { OutputFormat } from "../types.js";

export type JsonSchema = Record<string, unknown>;

export interface SchemaEntry {
  /** CLI-facing id, e.g. "agent-result". */
  id: string;
  /** Canonical `$id` embedded in the document. */
  uri: string;
  title: string;
  /** Command ids that emit this shape. */
  commands: string[];
  schema: JsonSchema;
}

export type ContractStream = "stdout" | "stderr";

export interface ExitCodeMeaning {
  code: 0 | 1 | 2;
  meaning: string;
}

export interface CommandContract {
  /** Space-joined command path, e.g. "md graph". */
  id: string;
  /**
   * Accepted output formats, or null when the command has no output format at
   * all — `serve` speaks a protocol on stdout rather than writing a payload.
   * Null is not the same as undeclared; `describe` already reports null for a
   * command with no contract row, and its published schema permits both.
   */
  formats: readonly OutputFormat[] | null;
  /** Built-in default, before any project configuration is applied. */
  defaultFormat: OutputFormat | null;
  /** True when `.cairn.yml` may override the format for this command. */
  formatConfigurable: boolean;
  /** Schema id for `--format json`, or `null` when none is published yet. */
  outputSchema: string | null;
  /** Schema id for `--format jsonl`. */
  jsonlSchema?: string | null;
  /** External schema URI for `--format sarif`. */
  sarifSchema?: string | null;
  exitCodes: ExitCodeMeaning[];
  /**
   * Present only when the command forwards a child process's exit status
   * verbatim, which is outside the three declared codes. `exitCodes` still
   * describes the outcomes this tool decides itself.
   */
  exitCodePassthrough?: { min: number; max: number; description: string };
  /** Which stream carries the primary payload, per outcome. */
  stream: { success: ContractStream; findings?: ContractStream };
  /** True when the command may modify files on disk. */
  writes: boolean;
  stability: "stable" | "experimental";
  /**
   * Behavior a consumer would otherwise be surprised by. Recorded truthfully,
   * including current inconsistencies — changing them is a breaking change
   * under the rules in docs/contract.md.
   */
  notes?: string;
}
