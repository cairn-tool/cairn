import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "../config.js";
import type { Workspace } from "../workspace.js";

/**
 * The tool contract, split out from `tools.ts` so a second tool module can
 * implement it without importing the array it is registered into — which would
 * be a cycle.
 */

export interface ServeContext {
  workspace: Workspace;
  config: ResolvedConfig;
  /** Confinement boundary, already resolved through symlinks. */
  root: string;
  /** Upper bound on parallel lints, so a large audit cannot starve the transport. */
  concurrency: number;
}

export interface ServeTool {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  handler: (args: Record<string, unknown>, context: ServeContext) => Promise<unknown> | unknown;
}
