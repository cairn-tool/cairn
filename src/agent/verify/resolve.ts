import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configIn } from "../../config.js";
import { object } from "../../config-schema.js";
import { parseVerifyBlock } from "./config.js";
import type { VerifyConfig } from "./config.js";

/**
 * Finds the document declaring `agent.verify`.
 *
 * Unlike the `scripts` walk this stops at the *nearest* document that declares
 * the block. Entries are a set describing one repository, not a name lookup, so
 * there is nothing for a farther ancestor to contribute — and merging two
 * repositories' entry lists would verify trees the nearer document never
 * mentioned.
 */

/** A configuration file larger than this is not one anybody wrote by hand. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Enough of the head to catch a binary file mistakenly named `.cairn.yml`. */
const NUL_PROBE_BYTES = 8 * 1024;

export interface VerifySelection {
  /** `--config <file>`, resolved against the working directory. */
  explicitPath?: string;
  /** Invocation directory; defaults to the process working directory. */
  cwd?: string;
}

function readDocument(file: string): Record<string, unknown> {
  // The guards mirror `readRegistry` in `src/scripts/resolve.ts`: realpath, a
  // regular-file check so a FIFO cannot wedge the process, a size cap, and a
  // NUL probe.
  const real = fs.realpathSync(file);
  const stat = fs.lstatSync(real);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
  if (stat.size > MAX_CONFIG_BYTES)
    throw new Error(`Configuration file is larger than ${MAX_CONFIG_BYTES} bytes: ${file}`);
  const buffer = fs.readFileSync(real);
  if (buffer.subarray(0, NUL_PROBE_BYTES).includes(0)) throw new Error(`Not a text file: ${file}`);
  return object(parseYaml(buffer.toString("utf-8")), "configuration");
}

function parseAt(file: string): VerifyConfig | undefined {
  const directory = path.dirname(path.resolve(file));
  const document = readDocument(file);
  if (document.agent === undefined) return undefined;
  return parseVerifyBlock(document.agent, { file: path.resolve(file), directory });
}

export function resolveVerifyConfig(selection: VerifySelection = {}): VerifyConfig {
  if (selection.explicitPath) {
    const file = path.resolve(selection.explicitPath);
    if (!fs.existsSync(file)) throw new Error(`Configuration file not found: ${file}`);
    const config = parseAt(file);
    if (!config) throw new Error(`No 'agent.verify' block in ${file}`);
    return config;
  }

  let current = path.resolve(selection.cwd ?? process.cwd());
  while (true) {
    const candidate = configIn(current);
    if (candidate) {
      const config = parseAt(candidate);
      if (config) return config;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    "No 'agent.verify' block found. Declare one in .cairn.yml, or pass --config <file>.",
  );
}
