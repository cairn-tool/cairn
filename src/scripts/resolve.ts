import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configIn, findConfig } from "../config.js";
import type { ConfigSelection } from "../config.js";
import { isInside, object } from "../config-schema.js";
import { repositoryFor } from "../git.js";
import { emptyRegistry, parseScriptsBlock } from "./registry.js";
import type { ScriptDefinition, ScriptRegistry } from "./registry.js";

/**
 * Resolves a script name to the definition that wins for a given working
 * directory.
 *
 * The walk here is deliberately not `findConfig`, which returns the nearest
 * `.cairn.yml` and stops. A nested configuration that exists but does not
 * define the requested name must not shadow an ancestor that does, so every file
 * from the invocation directory up to the boundary is consulted and the nearest
 * *definition of the name* wins.
 */

/** A registry file larger than this is not one anybody wrote by hand. */
const MAX_REGISTRY_BYTES = 1024 * 1024;

/** Enough of the head to catch a binary file mistakenly named `.cairn.yml`. */
const NUL_PROBE_BYTES = 8 * 1024;

export type ScriptBoundaryKind =
  "explicit-root" | "git-root" | "nearest-config" | "single-config" | "disabled";

export interface ScriptBoundary {
  /** Absolute and symlink-resolved. The walk never reads above this directory. */
  directory: string;
  kind: ScriptBoundaryKind;
}

export interface ScriptsWalkOptions {
  /** Invocation directory; defaults to the process working directory. */
  cwd?: string;
  /** `--root <dir>`, resolved against `cwd` by the caller. */
  root?: string;
  /** `--config` / `--no-config`, as parsed by `selectConfig`. */
  selection?: ConfigSelection;
}

export type ConsultedStatus =
  /** Declares the requested name — the winner, or a shadowed definition. */
  | "defines"
  /** Parsed and has a `scripts:` block, but not the requested name. */
  | "declares"
  /** Parsed, with no `scripts:` block at all. */
  | "no-scripts"
  /** Unreadable YAML, or a `scripts:` block that failed validation. */
  | "invalid"
  /** Failed a read guard, or sits under `node_modules`. */
  | "skipped";

export interface ConsultedFile {
  file: string;
  directory: string;
  /** Directory levels above the invocation directory; 0 is the directory itself. */
  distance: number;
  status: ConsultedStatus;
  /** Set for `invalid` and `skipped`. */
  reason?: string;
  /** Script names the file declares, sorted. Empty unless it parsed. */
  names: string[];
}

export interface ScriptWinner {
  definition: ScriptDefinition;
  registry: ScriptRegistry;
  /** Absolute, resolved, and already checked against the boundary. */
  workingDirectory: string;
}

export interface ShadowedDefinition {
  file: string;
  directory: string;
  description?: string;
}

export interface ScriptResolution {
  name: string;
  boundary: ScriptBoundary;
  invokedFrom: string;
  /** Nearest first — exactly the files the walk opened. */
  consulted: ConsultedFile[];
  winner?: ScriptWinner;
  /** Files that also define the name but lost, nearest first. */
  shadowed: ShadowedDefinition[];
}

export interface ScriptListingEntry {
  name: string;
  description?: string;
  form: "run" | "exec";
  run?: string;
  exec?: readonly string[];
  shell?: string;
  file: string;
  directory: string;
  workingDirectory: string;
  /** Files whose same-named definition this one shadows. */
  shadows: string[];
}

export interface ScriptListing {
  boundary: ScriptBoundary;
  invokedFrom: string;
  consulted: ConsultedFile[];
  scripts: ScriptListingEntry[];
}

/** Byte comparison; never `localeCompare`, which is ICU-build dependent. */
function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function realpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function hasNodeModules(directory: string): boolean {
  return directory.split(path.sep).includes("node_modules");
}

export function resolveBoundary(options: ScriptsWalkOptions = {}): ScriptBoundary {
  const invokedFrom = realpath(path.resolve(options.cwd ?? process.cwd()));
  const selection = options.selection;

  if (selection?.disabled) return { directory: invokedFrom, kind: "disabled" };
  if (selection?.explicitPath) {
    return { directory: path.dirname(realpath(selection.explicitPath)), kind: "single-config" };
  }

  const candidates: ScriptBoundary[] = [];
  if (options.root) {
    const root = realpath(path.resolve(options.root));
    if (!isInside(root, invokedFrom)) {
      throw new Error(`--root is not an ancestor of the working directory: ${options.root}`);
    }
    candidates.push({ directory: root, kind: "explicit-root" });
  }
  try {
    candidates.push({ directory: repositoryFor(invokedFrom).root, kind: "git-root" });
  } catch {
    // Not a repository, or git is not on PATH. Both are ordinary here.
  }

  if (candidates.length > 0) {
    // The deeper of the two stops the walk sooner, so it is the safer reading of
    // "whichever is found first" while ascending.
    return candidates.reduce((deepest, candidate) =>
      candidate.directory.length > deepest.directory.length ? candidate : deepest,
    );
  }

  const nearest = findConfig(invokedFrom);
  return {
    directory: nearest ? path.dirname(realpath(nearest)) : invokedFrom,
    kind: "nearest-config",
  };
}

interface WalkStep {
  consulted: ConsultedFile;
  registry?: ScriptRegistry;
}

/**
 * Reads one candidate registry file.
 *
 * The guards mirror `readSnippetSource` in `src/snippets.ts`: realpath first,
 * then containment, then a regular-file check — a FIFO would block the read
 * forever and wedge a hook with no output — then a size cap and a NUL probe.
 */
function readRegistry(file: string, boundary: string, distance: number): WalkStep {
  const directory = path.dirname(file);
  const base: ConsultedFile = { file, directory, distance, status: "skipped", names: [] };

  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return { consulted: { ...base, reason: "Unreadable" } };
  }
  if (!isInside(boundary, real)) {
    return { consulted: { ...base, reason: "Resolves outside the boundary" } };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(real);
  } catch {
    return { consulted: { ...base, reason: "Unreadable" } };
  }
  if (!stat.isFile()) {
    return { consulted: { ...base, reason: "Not a regular file" } };
  }
  if (stat.size > MAX_REGISTRY_BYTES) {
    return { consulted: { ...base, reason: `Larger than ${MAX_REGISTRY_BYTES} bytes` } };
  }

  let contents: string;
  try {
    const buffer = fs.readFileSync(real);
    if (buffer.subarray(0, NUL_PROBE_BYTES).includes(0)) {
      return { consulted: { ...base, reason: "Not a text file" } };
    }
    contents = buffer.toString("utf-8");
  } catch {
    return { consulted: { ...base, reason: "Unreadable" } };
  }

  let registry: ScriptRegistry;
  try {
    const parsed = object(parseYaml(contents), "configuration");
    if (parsed.scripts === undefined) {
      return {
        consulted: { ...base, status: "no-scripts" },
        registry: emptyRegistry(file, directory),
      };
    }
    registry = parseScriptsBlock(parsed.scripts, { file, directory });
  } catch (error) {
    const reason = (error as Error).message.split("\n")[0];
    return { consulted: { ...base, status: "invalid", reason } };
  }

  const names = [...registry.scripts.keys()].sort(byteOrder);
  return { consulted: { ...base, status: "declares", names }, registry };
}

/**
 * Walks from the invocation directory to the boundary, inclusive, nearest first.
 *
 * Only the `scripts:` block of each file is validated. An ancestor belongs to a
 * different project, and a malformed `urls:` block there is none of this
 * command's business — failing on it would make one broken package configuration
 * break `scripts run` for every sibling.
 */
function walk(boundary: ScriptBoundary, options: ScriptsWalkOptions): WalkStep[] {
  if (boundary.kind === "disabled") return [];
  if (boundary.kind === "single-config") {
    const file = realpath(options.selection?.explicitPath ?? "");
    if (!fs.existsSync(file)) {
      throw new Error(`Configuration file not found: ${options.selection?.explicitPath}`);
    }
    return [readRegistry(file, boundary.directory, 0)];
  }

  const invokedFrom = realpath(path.resolve(options.cwd ?? process.cwd()));
  const steps: WalkStep[] = [];
  let current = invokedFrom;
  let distance = 0;
  while (true) {
    // A vendored package that ships a `.cairn.yml` would otherwise win over
    // the project's own registry for any invocation inside it.
    if (!hasNodeModules(current)) {
      // `configIn` stops at the first name it finds, so a directory holding both
      // the current and the legacy filename contributes one step rather than two
      // — the legacy file must not read as a registry the new one shadows.
      const candidate = configIn(current);
      if (candidate) steps.push(readRegistry(candidate, boundary.directory, distance));
    }
    if (current === boundary.directory) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    distance++;
  }
  return steps;
}

/**
 * The directory a script runs in.
 *
 * Containment is checked on the *resolved* directory, not on the spelling: `cwd`
 * decides where the script's own relative paths land, which makes it the more
 * attractive escape of the two paths this module resolves.
 */
function workingDirectoryFor(
  definition: ScriptDefinition,
  registry: ScriptRegistry,
  invokedFrom: string,
  boundary: ScriptBoundary,
): string {
  const target =
    definition.cwd.kind === "registry"
      ? registry.directory
      : definition.cwd.kind === "invocation"
        ? invokedFrom
        : path.resolve(registry.directory, definition.cwd.value);
  const resolved = realpath(target);

  if (boundary.kind !== "disabled" && !isInside(boundary.directory, resolved)) {
    throw new Error(
      `Script '${definition.name}' resolves a working directory outside the boundary: ${resolved}`,
    );
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(
      `Script '${definition.name}' has a working directory that does not exist: ${resolved}`,
    );
  }
  return resolved;
}

export function resolveScript(name: string, options: ScriptsWalkOptions = {}): ScriptResolution {
  const invokedFrom = realpath(path.resolve(options.cwd ?? process.cwd()));
  const boundary = resolveBoundary(options);
  const steps = walk(boundary, options);

  const consulted: ConsultedFile[] = [];
  const definitions: Array<{ definition: ScriptDefinition; registry: ScriptRegistry }> = [];
  for (const step of steps) {
    const declares = step.registry?.scripts.has(name) ?? false;
    consulted.push(declares ? { ...step.consulted, status: "defines" } : step.consulted);
    if (declares && step.registry) {
      definitions.push({ definition: step.registry.scripts.get(name)!, registry: step.registry });
    }
  }

  const resolution: ScriptResolution = {
    name,
    boundary,
    invokedFrom,
    consulted,
    shadowed: definitions.slice(1).map(({ registry, definition }) => ({
      file: registry.file,
      directory: registry.directory,
      ...(definition.description ? { description: definition.description } : {}),
    })),
  };

  const nearest = definitions[0];
  if (nearest) {
    resolution.winner = {
      definition: nearest.definition,
      registry: nearest.registry,
      workingDirectory: workingDirectoryFor(
        nearest.definition,
        nearest.registry,
        invokedFrom,
        boundary,
      ),
    };
  }
  return resolution;
}

/**
 * The first invalid file that could have changed the answer, if any.
 *
 * A file farther from the invocation directory than the winner cannot have won,
 * so it must not break the run. A nearer one might have defined the name, and
 * running the wrong script is precisely the failure this design exists to
 * prevent.
 */
export function shadowingFailure(resolution: ScriptResolution): ConsultedFile | undefined {
  const winnerDistance = resolution.consulted.find((file) => file.status === "defines")?.distance;
  return resolution.consulted.find(
    (file) =>
      file.status === "invalid" && (winnerDistance === undefined || file.distance < winnerDistance),
  );
}

export function listScripts(options: ScriptsWalkOptions = {}): ScriptListing {
  const invokedFrom = realpath(path.resolve(options.cwd ?? process.cwd()));
  const boundary = resolveBoundary(options);
  const steps = walk(boundary, options);

  const entries = new Map<string, ScriptListingEntry>();
  for (const step of steps) {
    if (!step.registry) continue;
    for (const [name, definition] of step.registry.scripts) {
      const existing = entries.get(name);
      if (existing) {
        // Nearest wins; a farther definition only records that it was shadowed.
        existing.shadows.push(step.registry.file);
        continue;
      }
      let workingDirectory: string;
      try {
        workingDirectory = workingDirectoryFor(definition, step.registry, invokedFrom, boundary);
      } catch {
        // `list` reports what is declared; a bad `cwd` is `run`'s problem to
        // refuse, and hiding the entry here would make it harder to diagnose.
        workingDirectory = step.registry.directory;
      }
      entries.set(name, {
        name,
        ...(definition.description ? { description: definition.description } : {}),
        form: definition.run !== undefined ? "run" : "exec",
        ...(definition.run !== undefined ? { run: definition.run } : {}),
        ...(definition.exec !== undefined ? { exec: definition.exec } : {}),
        ...(definition.shell !== undefined ? { shell: definition.shell } : {}),
        file: step.registry.file,
        directory: step.registry.directory,
        workingDirectory,
        shadows: [],
      });
    }
  }

  return {
    boundary,
    invokedFrom,
    consulted: steps.map((step) => step.consulted),
    scripts: [...entries.values()].sort((left, right) => byteOrder(left.name, right.name)),
  };
}
