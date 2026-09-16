import type { Option } from "commander";
import type { WalkOptions } from "@cairn-tool/cli-schema-commander";
import { collect } from "../option-utils.js";
import { NOTIFIER_CONTRACT } from "../update-notifier.js";
import { COMMAND_CONTRACTS } from "./registry.js";
import { SCHEMA_REFS } from "./schemas/index.js";

/** The argv rewrites `src/cli.ts` applies before commander parses. */
export const FORMAT_SHORTHANDS: Record<string, string> = {
  "-fh": "--format=human",
  "-fj": "--format=json",
};

/**
 * Repeatable options accumulate through `collect`; comparing by identity avoids
 * inferring repeatability from description text. The library's own default is
 * `option.variadic` alone, which this CLI never uses, so without this hook every
 * repeatable option would be reported with `arity.max: 1`.
 */
export const isRepeatable = (option: Option): boolean => option.parseArg === collect;

/**
 * Everything the cli-schema walker needs beyond the commander tree, in one
 * place so `describe` and `completion` cannot disagree. Only type imports reach
 * the library from here: this module sits on the completion and describe paths
 * only, but its dependencies are on every command's.
 */
export function walkOptions(): WalkOptions {
  return {
    registry: COMMAND_CONTRACTS,
    advisoryOutput: NOTIFIER_CONTRACT,
    schemas: SCHEMA_REFS.map((entry) => ({ ...entry })),
    formatShorthands: FORMAT_SHORTHANDS,
    isRepeatable,
  };
}
