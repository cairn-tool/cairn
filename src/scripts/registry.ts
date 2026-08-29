import { knownKeys, object, optionalString } from "../config-schema.js";

/**
 * Parsing and validation for the `scripts:` block of a `.cairn.yml` file.
 *
 * This module is deliberately pure — no filesystem access, no child process, no
 * knowledge of how a configuration file is discovered. That seam is what lets
 * `loadConfig`, which reads only the nearest file, and the chain walk in
 * `./resolve.ts`, which reads several, share one validator. It also keeps
 * `node:child_process` off the import path of every command that merely loads
 * configuration.
 */

/** Where the child process runs. `path` is registry-relative. */
export type ScriptCwd =
  { kind: "registry" } | { kind: "invocation" } | { kind: "path"; value: string };

export interface ScriptDefinition {
  name: string;
  description?: string;
  /** Exactly one of `run` and `exec` is set; the parser guarantees the xor. */
  run?: string;
  exec?: readonly string[];
  /** Shell for `run`, defaulting to `/bin/sh`. Ignored for `exec`. */
  shell?: string;
  cwd: ScriptCwd;
}

export interface ScriptRegistry {
  /** Absolute path of the `.cairn.yml` that declared these scripts. */
  file: string;
  /** Directory of that file; the default working directory for its scripts. */
  directory: string;
  /** Declaration order preserved. */
  scripts: ReadonlyMap<string, ScriptDefinition>;
}

/**
 * Names are restricted to what reads unambiguously on a command line and in a
 * hook definition: no path separators, no `..`, no shell metacharacters, no
 * leading or trailing punctuation.
 */
export const SCRIPT_NAME = /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/;
export const MAX_SCRIPT_NAME_LENGTH = 64;

const SCRIPT_KEYS = new Set(["run", "exec", "shell", "cwd", "description"]);

/** Reserved `cwd:` values; anything else is a registry-relative path. */
const CWD_REGISTRY = "registry";
const CWD_INVOCATION = "invocation";

export function emptyRegistry(file: string, directory: string): ScriptRegistry {
  return { file, directory, scripts: new Map() };
}

function execArgv(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a list of strings`);
  }
  const argv = [...value] as string[];
  if (argv.length === 0) throw new Error(`${name} must be a non-empty list of strings`);
  if (argv[0].length === 0) throw new Error(`${name}[0] must be a non-empty program name`);
  // A NUL byte makes `spawn` throw a TypeError from deep inside libuv rather
  // than reporting which script is at fault.
  if (argv.some((item) => item.includes("\0"))) {
    throw new Error(`${name} must not contain NUL bytes`);
  }
  return argv;
}

function scriptCwd(value: unknown, name: string): ScriptCwd {
  const raw = optionalString(value, name);
  if (raw === undefined || raw === CWD_REGISTRY) return { kind: "registry" };
  if (raw === CWD_INVOCATION) return { kind: "invocation" };
  if (raw.length === 0) throw new Error(`${name} must be a non-empty string`);
  // Containment of the resolved directory is enforced in `./resolve.ts`; this
  // only rejects the spelling that could never be meant relatively.
  if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error(`${name} must be relative to the registry`);
  }
  return { kind: "path", value: raw };
}

function scriptDefinition(name: string, value: unknown): ScriptDefinition {
  const label = `scripts.${name}`;
  const entry = object(value, label);
  knownKeys(entry, SCRIPT_KEYS, label);

  const hasRun = entry.run !== undefined;
  const hasExec = entry.exec !== undefined;
  if (hasRun === hasExec) {
    throw new Error(`${label} must set exactly one of run or exec`);
  }

  const definition: ScriptDefinition = {
    name,
    cwd: scriptCwd(entry.cwd, `${label}.cwd`),
  };

  const description = optionalString(entry.description, `${label}.description`);
  if (description !== undefined) definition.description = description;

  if (hasRun) {
    const run = optionalString(entry.run, `${label}.run`);
    if (!run || run.trim().length === 0) {
      throw new Error(`${label}.run must be a non-empty string`);
    }
    definition.run = run;
    const shell = optionalString(entry.shell, `${label}.shell`);
    if (shell !== undefined) {
      if (shell.length === 0) throw new Error(`${label}.shell must be a non-empty string`);
      definition.shell = shell;
    }
  } else {
    if (entry.shell !== undefined) {
      throw new Error(`${label}.shell applies to run, not exec`);
    }
    definition.exec = execArgv(entry.exec, `${label}.exec`);
  }

  return definition;
}

/**
 * Validates an already-parsed `scripts:` value.
 *
 * An absent block yields an empty registry rather than throwing, so a
 * configuration file with no scripts is not a special case at either call site.
 */
export function parseScriptsBlock(
  value: unknown,
  context: { file: string; directory: string },
): ScriptRegistry {
  if (value === undefined) return emptyRegistry(context.file, context.directory);

  const block = object(value, "scripts");
  const scripts = new Map<string, ScriptDefinition>();
  for (const [name, entry] of Object.entries(block)) {
    if (name.length > MAX_SCRIPT_NAME_LENGTH || !SCRIPT_NAME.test(name)) {
      throw new Error(`Invalid script name: ${name}`);
    }
    scripts.set(name, scriptDefinition(name, entry));
  }
  return { file: context.file, directory: context.directory, scripts };
}
