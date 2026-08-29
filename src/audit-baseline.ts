import fs from "node:fs";
import path from "node:path";
import type { Issue } from "./types.js";

/** The discriminator every document this module writes carries. */
export const BASELINE_FORMAT = "cairn-md-audit-baseline";

/** The pre-rename discriminator, still accepted on committed baselines. */
export const LEGACY_BASELINE_FORMAT = "claude-cli-md-audit-baseline";

/** True for a document either spelling of this tool wrote. */
export function isBaselineFormat(value: unknown): boolean {
  return value === BASELINE_FORMAT || value === LEGACY_BASELINE_FORMAT;
}

/** The structure version of the baseline document, not the package version. */
export const BASELINE_VERSION = "1";

export interface BaselineEntry {
  checker: string;
  /** Workspace-relative, with `/` separators. */
  file: string;
  message: string;
  /** How many times the finding was recorded, so a new duplicate still fails. */
  count: number;
}

export interface BaselineDocument {
  baselineFormat?: string;
  version?: string;
  generator?: { name: string; version: string };
  entries?: BaselineEntry[];
}

export interface BaselineApplication {
  kept: Issue[];
  suppressed: number;
  matched: number;
  /** Entries that matched nothing, reported but never blocking. */
  stale: BaselineEntry[];
  /** True when the document is not one this tool wrote. */
  foreign: boolean;
}

/**
 * The finding identity a baseline is keyed on.
 *
 * Deliberately excludes the line number. A finding does not become a different
 * finding because unrelated prose was inserted above it, and a line-sensitive
 * key would turn every reflow into a wall of regressions and force a baseline
 * refresh on commits that fixed nothing.
 *
 * The cost is that two identical findings in one file collapse to one entry;
 * `count` carries the multiplicity so the second one is still reported.
 */
function key(checker: string, file: string, message: string): string {
  return `${checker}\0${file}\0${message}`;
}

/** Byte comparison, so ordering never depends on the runner's ICU build. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Workspace-relative, `/`-separated.
 *
 * A baseline holding absolute paths would match nothing after a checkout into
 * a different directory, which is the normal case in CI.
 */
export function baselinePath(file: string, root: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Reads a baseline document.
 *
 * A missing or unparseable file throws, matching how `agent audit --baseline`
 * treats a path that is not there. A *foreign* document is reported as a
 * finding by `applyBaseline` instead, because guessing at another tool's schema
 * would produce suppression nobody can trust.
 */
export function readBaseline(file: string): BaselineDocument {
  if (!fs.existsSync(file)) throw new Error(`--baseline file does not exist: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`--baseline is not valid JSON: ${file}`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`--baseline is not a baseline document: ${file}`);
  return parsed as BaselineDocument;
}

/** Builds the document `--write-baseline` records. */
export function buildBaseline(
  findings: readonly Issue[],
  root: string,
  generator: { name: string; version: string },
): BaselineDocument {
  const counts = new Map<string, BaselineEntry>();
  for (const issue of findings) {
    const file = baselinePath(issue.file, root);
    const id = key(issue.checker, file, issue.message);
    const entry = counts.get(id);
    if (entry) entry.count++;
    else counts.set(id, { checker: issue.checker, file, message: issue.message, count: 1 });
  }
  return {
    baselineFormat: BASELINE_FORMAT,
    version: BASELINE_VERSION,
    generator,
    entries: [...counts.values()].sort(
      (a, b) =>
        byBytes(a.checker, b.checker) || byBytes(a.file, b.file) || byBytes(a.message, b.message),
    ),
  };
}

/**
 * Partitions findings into those the baseline already recorded and those it did
 * not.
 *
 * Findings are consumed in the order given, so with a baseline `count` of one
 * and two matching findings the first is suppressed and the second reported.
 */
export function applyBaseline(
  findings: readonly Issue[],
  document: BaselineDocument,
  root: string,
): BaselineApplication {
  if (!isBaselineFormat(document.baselineFormat))
    return { kept: [...findings], suppressed: 0, matched: 0, stale: [], foreign: true };

  const remaining = new Map<string, number>();
  const entries = new Map<string, BaselineEntry>();
  for (const entry of document.entries ?? []) {
    const id = key(entry.checker, entry.file, entry.message);
    remaining.set(id, (remaining.get(id) ?? 0) + Math.max(0, entry.count));
    entries.set(id, entry);
  }

  const kept: Issue[] = [];
  let suppressed = 0;
  for (const issue of findings) {
    const id = key(issue.checker, baselinePath(issue.file, root), issue.message);
    const left = remaining.get(id) ?? 0;
    if (left > 0) {
      remaining.set(id, left - 1);
      suppressed++;
    } else kept.push(issue);
  }

  const stale = [...remaining]
    .filter(([, left]) => left > 0)
    .map(([id, left]) => ({ ...entries.get(id)!, count: left }))
    .sort(
      (a, b) =>
        byBytes(a.checker, b.checker) || byBytes(a.file, b.file) || byBytes(a.message, b.message),
    );

  return { kept, suppressed, matched: suppressed, stale, foreign: false };
}

/** Writes a baseline document, replacing any existing one. */
export function writeBaseline(file: string, document: BaselineDocument): void {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n");
  fs.renameSync(temporary, target);
}
