import fs from "node:fs";
import path from "node:path";
import { configIn } from "../../config.js";
import { hasNodeModules } from "../../config-schema.js";
import { readAgentDocument } from "../verify/resolve.js";
import { parseGuardBlock } from "./config.js";
import type { GuardConfig } from "./config.js";

/**
 * Finds the document declaring `agent.guard`.
 *
 * The walk stops at the *nearest* document that declares the block, the same
 * rule `agent verify` follows: entries describe one repository, and merging two
 * repositories' lists would guard trees the nearer document never mentioned.
 *
 * Unlike `resolveVerifyConfig` this one skips `node_modules`, for the reason
 * `src/scripts/resolve.ts` does — a vendored `.cairn.yml` must not be able to
 * win by being nearest — and it *returns undefined* rather than throwing when
 * nothing declares a block. The guard runs inside a `PreToolUse` hook on every
 * write in every repository the plugin is installed for; an unguarded
 * repository is the overwhelmingly common case and is not an error.
 */
export function resolveGuardConfig(
  selection: { explicitPath?: string; cwd?: string } = {},
): GuardConfig | undefined {
  if (selection.explicitPath) {
    const file = path.resolve(selection.explicitPath);
    if (!fs.existsSync(file)) throw new Error(`Configuration file not found: ${file}`);
    const directory = path.dirname(file);
    const document = readAgentDocument(file);
    return parseGuardBlock(document.agent, { file, directory });
  }

  let current = path.resolve(selection.cwd ?? process.cwd());
  while (true) {
    if (!hasNodeModules(current)) {
      const candidate = configIn(current);
      if (candidate) {
        const file = path.resolve(candidate);
        const document = readAgentDocument(file);
        const config = parseGuardBlock(document.agent, { file, directory: path.dirname(file) });
        if (config) return config;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
