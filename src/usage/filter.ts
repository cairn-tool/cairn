import path from "node:path";
import type { FileAggregate } from "./events.js";

/**
 * Window and scope selection.
 *
 * Everything here is pure: it decides which day buckets and which files a report
 * covers, without touching the filesystem.
 */

const RELATIVE = /^(\d+)\s*([dwmy])$/i;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const UNIT_DAYS: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };

/**
 * Resolves `--since` / `--until` to a UTC calendar day.
 *
 * Accepts a relative span (`7d`, `2w`, `3m`, `1y`) or an ISO date. Both resolve
 * to a day rather than an instant: the index stores day buckets, so a finer
 * boundary would be a promise the data cannot keep. `m` is 30 days and `y` is
 * 365 — a span, not a calendar month or year.
 */
export function parseDay(value: string, label: string, now = new Date()): string {
  const trimmed = value.trim();
  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    const span = Number(relative[1]) * UNIT_DAYS[relative[2].toLowerCase()];
    const day = new Date(now.getTime() - span * 86_400_000);
    return day.toISOString().slice(0, 10);
  }
  if (ISO_DAY.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    if (Number.isFinite(parsed)) return trimmed;
  }
  throw new Error(
    `Invalid ${label} value: ${value} (expected a relative span such as 7d, 2w, 3m, 1y, or an ISO date such as 2026-08-01)`,
  );
}

export interface Window {
  since: string | null;
  until: string | null;
}

export function resolveWindow(
  since: string | undefined,
  until: string | undefined,
  now = new Date(),
): Window {
  const window: Window = {
    since: since === undefined ? null : parseDay(since, "--since", now),
    until: until === undefined ? null : parseDay(until, "--until", now),
  };
  if (window.since && window.until && window.since > window.until) {
    throw new Error(`--since ${window.since} is after --until ${window.until}`);
  }
  return window;
}

/** Both bounds are inclusive, which is what a day-granular window should mean. */
export function dayInWindow(day: string, window: Window): boolean {
  if (window.since && day < window.since) return false;
  if (window.until && day > window.until) return false;
  return true;
}

/**
 * The earliest file mtime that could still hold a record inside the window.
 *
 * A transcript is append-only, so a file last modified before the start of the
 * window has nothing in it. Pruning by mtime before opening anything is what
 * makes `--since 7d` cheap over a corpus of thousands of files. One day of slack
 * absorbs any timezone or clock skew between the record timestamps and the
 * filesystem.
 */
export function modifiedSinceFor(window: Window): number | undefined {
  if (!window.since) return undefined;
  return Date.parse(`${window.since}T00:00:00Z`) - 86_400_000;
}

/**
 * Normalizes a `--project` selector.
 *
 * `.` and a relative path resolve against the working directory. A bare token
 * with no separator is treated as a directory-name or slug fragment, so
 * `--project claude-cli` works without spelling out the whole path.
 */
export interface ProjectSelector {
  raw: string;
  absolute: string | null;
  fragment: string;
}

export function parseProject(value: string, cwd = process.cwd()): ProjectSelector {
  const raw = value.trim();
  if (raw === "." || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("~")) {
    const expanded = raw.startsWith("~")
      ? path.join(process.env.HOME ?? "", raw.slice(1))
      : path.resolve(cwd, raw);
    return { raw, absolute: expanded, fragment: path.basename(expanded).toLowerCase() };
  }
  return { raw, absolute: null, fragment: raw.toLowerCase() };
}

export function matchesProject(project: string, selectors: readonly ProjectSelector[]): boolean {
  if (selectors.length === 0) return true;
  const lower = project.toLowerCase();
  return selectors.some((selector) => {
    if (selector.absolute) {
      return project === selector.absolute || project.startsWith(`${selector.absolute}/`);
    }
    return lower.includes(selector.fragment);
  });
}

/** Keeps only the day buckets inside the window; returns null when nothing remains. */
export function clipToWindow(aggregate: FileAggregate, window: Window): FileAggregate | null {
  if (!window.since && !window.until) {
    return Object.keys(aggregate.days).length > 0 ? aggregate : null;
  }
  const days = Object.fromEntries(
    Object.entries(aggregate.days).filter(([day]) => dayInWindow(day, window)),
  );
  if (Object.keys(days).length === 0) return null;
  return { ...aggregate, days };
}
