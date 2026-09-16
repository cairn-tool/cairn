import type {
  CommandContract,
  ContractStream,
  ExitCodeMeaning,
  SchemaRef,
} from "@cairn-tool/cli-schema";
import type { OutputFormat } from "../types.js";

export type {
  AdvisoryOutput,
  Arity,
  CommandContract,
  CommandContractRegistry,
  ContractStream,
  DescribeResult,
  DescribedArgument,
  DescribedCommand,
  DescribedOption,
  ExitCodeMeaning,
  SchemaRef,
  Stability,
} from "@cairn-tool/cli-schema";

export type JsonSchema = Record<string, unknown>;

/** A schema authored in this repository: the reference plus the document itself. */
export type SchemaEntry = SchemaRef & { schema: JsonSchema };

/**
 * A schema another project owns and this CLI re-serves. The body is loaded on
 * demand because the one such document lives behind `@cairn-tool/cli-schema`,
 * whose index compiles an Ajv validator at import, and this module sits under
 * `src/result.ts` on every command's path.
 */
export type ExternalSchemaEntry = SchemaRef & { load: () => Promise<JsonSchema> };

/**
 * A registry row: the library's contract plus the id it is keyed by, narrowed
 * to what this CLI always declares. The library permits `stream` and `writes`
 * to be null for a tool that has not decided; every row here has.
 */
export interface ContractRow extends CommandContract {
  /** Space-joined command path, e.g. "md graph". */
  id: string;
  /**
   * Accepted output formats, or null when the command has no output format at
   * all — `serve` speaks a protocol on stdout rather than writing a payload.
   * Null is not the same as undeclared; `describe` already reports null for a
   * command with no contract row, and the published schema permits both.
   */
  formats: readonly OutputFormat[] | null;
  /** Built-in default, before any project configuration is applied. */
  defaultFormat: OutputFormat | null;
  /** The three codes this tool decides itself; see `exitCodePassthrough`. */
  exitCodes: Array<ExitCodeMeaning & { code: 0 | 1 | 2 }>;
  /** Which stream carries the primary payload, per outcome. */
  stream: { success: ContractStream; findings?: ContractStream };
  /** True when the command may modify files on disk. */
  writes: boolean;
}
