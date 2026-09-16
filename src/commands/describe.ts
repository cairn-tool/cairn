import type { Command } from "commander";
import { renderText } from "@cairn-tool/cli-schema";
import { buildDescription, selectCommands } from "@cairn-tool/cli-schema-commander";
import { BASE_FORMATS } from "../formats.js";
import { walkOptions } from "../contract/walk-options.js";

export interface DescribeOptions {
  format: string;
  toolName: string;
  toolVersion: string;
}

/**
 * Describes the CLI contract as a cli-schema document. Reports the static
 * contract: project configuration is deliberately not applied, so a consumer
 * sees the same answer regardless of the directory it runs in.
 *
 * Registered by hand in `src/cli.ts` rather than through the library's
 * `addDescribeCommand`, which would need a static import there and so load the
 * library's validator on every invocation of every command.
 */
export async function describeAction(
  program: Command,
  commandPath: string[],
  opts: DescribeOptions,
): Promise<void> {
  const format = opts.format || "llm";
  // A contract command must not silently substitute a format it was not asked for.
  if (!BASE_FORMATS.includes(format as (typeof BASE_FORMATS)[number]))
    throw new Error(`Invalid output format: ${format}`);
  const full = buildDescription(
    program,
    { name: opts.toolName, version: opts.toolVersion },
    walkOptions(),
  );
  const result = commandPath.length ? selectCommands(full, commandPath) : full;
  process.stdout.write(
    format === "json"
      ? JSON.stringify(result, null, 2) + "\n"
      : renderText(result, format === "human"),
  );
}
