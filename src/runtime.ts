import type { ResolvedConfig } from "./config.js";
import { loadConfig, resolveCommandOptions, type PathStyle } from "./config.js";
import { Workspace, type WorkspaceOptions } from "./workspace.js";
import { ALL_FORMATS, supportsDiagnosticFormats } from "./formats.js";
import type { OutputFormat } from "./types.js";

export interface Runtime {
  config: ResolvedConfig;
  workspace: Workspace;
}

let activeRuntime: Runtime | undefined;

/**
 * Installs the process-wide runtime.
 *
 * `options` exists for the long-lived server: library helpers such as
 * `documentsReferencing` and `lintFile` reach for `runtime().workspace`, so a
 * bounded workspace has to be *the* workspace rather than a second instance
 * alongside it, or those helpers would quietly populate the unbounded one.
 */
export function initializeRuntime(config: ResolvedConfig, options?: WorkspaceOptions): Runtime {
  activeRuntime = { config, workspace: new Workspace(config, options) };
  return activeRuntime;
}

export function resetRuntime(): void {
  activeRuntime = undefined;
}

export function runtime(): Runtime {
  return activeRuntime ?? initializeRuntime(loadConfig({ disabled: true }));
}

export type ResolvedOptions<T extends Record<string, unknown>> = T & {
  format: OutputFormat;
  paths: PathStyle;
};

const OPTION_ALIASES: Record<string, string[]> = {
  format: ["-fh", "-fj"],
  style: ["-s"],
  external: ["-e"],
  anchors: ["-a"],
  images: ["-i"],
};

/**
 * Which of `cli`'s keys the user actually typed.
 *
 * Commander hands back defaults and typed values indistinguishably, so this
 * re-reads argv. Config resolution needs it to know what to override, and a
 * command that rejects conflicting options needs it to avoid misfiring on a
 * value that came from `.cairn.yml` rather than the command line.
 */
export function explicitOptionKeys(cli: Record<string, unknown>): Set<string> {
  const argv = process.argv.slice(2);
  return new Set(
    Object.keys(cli).filter((key) => {
      const kebab = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      return argv.some(
        (arg) =>
          arg === `--${kebab}` ||
          arg === `--no-${kebab}` ||
          arg.startsWith(`--${kebab}=`) ||
          (OPTION_ALIASES[key] ?? []).includes(arg),
      );
    }),
  );
}

export function commandOptions<T extends Record<string, unknown>>(
  command: string,
  builtins: T,
  cli: Record<string, unknown>,
): ResolvedOptions<T> {
  const typed = explicitOptionKeys(cli);
  const explicit = Object.fromEntries(Object.entries(cli).filter(([key]) => typed.has(key)));
  const resolved = resolveCommandOptions(runtime().config, command, builtins, explicit);
  if (!ALL_FORMATS.includes(resolved.format)) {
    throw new Error(`Invalid output format: ${String(resolved.format)}`);
  }
  if (
    (resolved.format === "jsonl" || resolved.format === "sarif") &&
    !supportsDiagnosticFormats(command)
  ) {
    throw new Error(`${resolved.format} output is not supported by md ${command}`);
  }
  if (resolved.paths !== "absolute" && resolved.paths !== "relative") {
    throw new Error(`Invalid path display style: ${String(resolved.paths)}`);
  }
  // The envelope is a JSON wrapper; there is nothing to wrap in the other
  // formats, so accepting it there would silently do nothing.
  if ((resolved as { envelope?: unknown }).envelope && resolved.format !== "json") {
    throw new Error("--envelope requires --format json");
  }
  return resolved;
}

export function displayPath(filePath: string, style?: PathStyle): string {
  return runtime().workspace.displayPath(filePath, style);
}

export function outputPath(filePath: string, options: object): string {
  const value = (options as { paths?: unknown }).paths;
  const style = value === "relative" || value === "absolute" ? value : undefined;
  return displayPath(filePath, style);
}
