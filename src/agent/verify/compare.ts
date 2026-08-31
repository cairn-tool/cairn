import fs from "node:fs";
import path from "node:path";
import { isInside } from "../../config-schema.js";
import { profileFor } from "../targets/index.js";
import type { AgentProfile, AgentTarget, Artifact } from "../types.js";
import { INSTALL_MANIFEST, LEGACY_INSTALL_MANIFEST } from "../install/index.js";

/**
 * Compares a tree a host actually reads — `.claude/skills/…` at a repository
 * root, say — against the artifacts that should produce it.
 *
 * This cannot be {@link diffOutput}, which assumes an
 * `<output>/<target>/<profile>/` conversion root and walks those roots
 * exhaustively. A merge install has no such prefix, and an unbounded walk from
 * a repository root would enumerate `node_modules`, `.git`, and every source
 * file as unmanaged. The containment rule below is what replaces that
 * assumption.
 */

/** A directory holding more files than this is not a generated tree. */
const MAX_WALK_ENTRIES = 20_000;

export interface TreeDiff {
  /** Expected artifacts absent from the tree, or present but not a regular file. */
  missing: string[];
  /** Expected artifacts whose bytes or permission bits differ. */
  changed: string[];
  /** Recorded in a prior install's inventory, but no longer rendered. */
  orphaned: string[];
  /** Inside managed territory, accounted for by neither the render nor the inventory. */
  unmanaged: string[];
}

/** Byte comparison, never `localeCompare`: sort order must not depend on the ICU build. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The longest leading run of segments containing no wildcard.
 *
 * `.claude/skills/{name}/**` yields `.claude/skills`; `.mcp.json` yields itself,
 * which is how a wholly-literal pattern is recognized as a leaf file rather
 * than a directory to walk.
 */
export function literalPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (segment.includes("*") || segment.includes("{")) break;
    literal.push(segment);
  }
  return literal.join("/");
}

/**
 * The directories a hand-added file could hide in.
 *
 * Derived from the target profile's own declared output patterns, so it can
 * never claim a surface the renderer does not describe. Three filters matter,
 * and each one is load-bearing:
 *
 * - a wholly-literal pattern is a *leaf file* (`AGENTS.md`, `.mcp.json`,
 *   `.claude/settings.json`). It is compared byte for byte by the expected-set
 *   pass and never walked.
 * - an empty prefix would make the destination root itself a walk root, which
 *   is precisely the repository-enumeration failure this function exists to
 *   prevent. No shipped profile declares such a pattern; the guard is here so a
 *   future one cannot introduce the bug silently.
 * - a prefix the render did not populate is not this bundle's territory. A
 *   repository keeping its own `assets/` is only walked when the bundle
 *   actually renders assets there.
 */
export function walkRootsFor(
  target: AgentTarget,
  profile: AgentProfile,
  expected: readonly string[],
): string[] {
  const patterns = profileFor(target).outputs[profile] ?? [];
  const roots = new Set<string>();
  for (const { pattern } of patterns) {
    const prefix = literalPrefix(pattern);
    if (!prefix || prefix === pattern) continue;
    if (!expected.some((candidate) => candidate.startsWith(`${prefix}/`))) continue;
    roots.add(prefix);
  }
  return [...roots].sort(byBytes);
}

function walk(directory: string, root: string, onFile: (relative: string) => void): number {
  let seen = 0;
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, dirent.name);
    // Dirent is lstat-based, so a symlinked directory reports false here and is
    // never descended into.
    if (dirent.isDirectory()) {
      seen += walk(full, root, onFile);
    } else {
      seen += 1;
      onFile(path.relative(root, full).split(path.sep).join("/"));
    }
    if (seen > MAX_WALK_ENTRIES)
      throw new Error(`Refusing to walk more than ${MAX_WALK_ENTRIES} files under ${root}`);
  }
  return seen;
}

/**
 * The install manifest is never compared by bytes, and never reported missing.
 *
 * It embeds the generator version, so byte-comparing it would report every tree
 * as drifted after any CLI upgrade — the same concession `payloadMatches` and
 * `diffOutput` both make, for the same reason. It is bookkeeping rather than
 * agent content, so a repository that ignores it is not drifted; the cost is
 * orphan detection, reported once as AB426.
 */
function existenceOnly(relative: string): boolean {
  return relative === INSTALL_MANIFEST || relative === LEGACY_INSTALL_MANIFEST;
}

export interface TreeDiffOptions {
  /** `off` skips both extra-file passes; `orphaned` reads only the inventory. */
  unmanaged: "off" | "orphaned" | "strict";
  /**
   * This entry's own prior record, destination-relative. The orphan source: a
   * sibling install's files are not this bundle's orphans.
   */
  priorInventory?: readonly string[];
  /**
   * Every record's paths at this destination. The `strict` walk's allowlist,
   * which must be the union or a co-resident install's files all report as
   * unmanaged. Defaults to `priorInventory`.
   */
  managedPaths?: readonly string[];
  /** Directory prefixes a `strict` walk may descend into. */
  walkRoots?: readonly string[];
}

export function diffTree(
  destination: string,
  artifacts: readonly Artifact[],
  options: TreeDiffOptions,
): TreeDiff {
  const diff: TreeDiff = { missing: [], changed: [], orphaned: [], unmanaged: [] };
  const expected = new Set(artifacts.map((artifact) => artifact.path));

  for (const artifact of artifacts) {
    const file = path.join(destination, artifact.path);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = undefined;
    }
    if (!stat || !stat.isFile()) {
      // An absent install manifest is bookkeeping, not drift: a repository may
      // legitimately commit the generated tree while ignoring the manifest.
      // Its absence is reported once, as AB426, and costs only orphan
      // detection.
      if (!existenceOnly(artifact.path)) diff.missing.push(artifact.path);
      continue;
    }
    if (existenceOnly(artifact.path)) continue;
    if (
      !fs.readFileSync(file).equals(artifact.content) ||
      (stat.mode & 0o777) !== (artifact.mode & 0o777)
    )
      diff.changed.push(artifact.path);
  }

  if (options.unmanaged !== "off")
    for (const recorded of options.priorInventory ?? [])
      if (!expected.has(recorded) && !existenceOnly(recorded)) diff.orphaned.push(recorded);

  if (options.unmanaged === "strict") {
    const inventory = new Set(options.managedPaths ?? options.priorInventory ?? []);
    for (const root of options.walkRoots ?? []) {
      const absolute = path.join(destination, root);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) continue;
      // A walk root reached through a symlink could leave the destination
      // entirely; refuse rather than report someone else's files.
      if (!isInside(fs.realpathSync(destination), fs.realpathSync(absolute))) continue;
      walk(absolute, destination, (relative) => {
        if (expected.has(relative) || inventory.has(relative) || existenceOnly(relative)) return;
        diff.unmanaged.push(relative);
      });
    }
  }

  diff.missing.sort(byBytes);
  diff.changed.sort(byBytes);
  diff.orphaned.sort(byBytes);
  diff.unmanaged.sort(byBytes);
  return diff;
}

/** True when the tree matches the artifacts exactly. */
export function treeMatches(diff: TreeDiff): boolean {
  return (
    !diff.missing.length && !diff.changed.length && !diff.orphaned.length && !diff.unmanaged.length
  );
}
