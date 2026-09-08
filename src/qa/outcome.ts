import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DIM, GREEN, RED, YELLOW, fmtCount } from "./format.js";
import { DONE_OK, REPORT, RESULTS } from "./config.js";
import type { Case } from "./cases.js";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageCells {
  inn: string;
  out: string;
  cache_r: string;
  cache_w: string;
}

const VERDICTS = ["PASS", "FAIL", "UNVERIFIED"] as const;
const DASH = "—";

/** PASS / FAIL / UNVERIFIED from `_results.md`, or — if unreadable. */
export function readVerdict(folder: string): string {
  const path = join(folder, RESULTS);
  let text: string;
  try {
    // No statSync guard: readFileSync already throws ENOENT for a missing file
    // and EISDIR for a directory, both of which land here as DASH. Checking
    // first bought nothing and opened a window between the check and the read.
    text = readFileSync(path, "utf8");
  } catch {
    return DASH;
  }
  if (text.includes("## 4.")) {
    const after = text.slice(text.indexOf("## 4.") + "## 4.".length);
    const fifth = after.indexOf("## 5.");
    const body = fifth === -1 ? after : after.slice(0, fifth);
    for (const verdict of VERDICTS) {
      if (new RegExp(String.raw`^\*\*${verdict}\*\*`, "m").test(body)) return verdict;
    }
  }
  const match = /\*\*Verdict\*\*\s*\|\s*([^|\n]+)/.exec(text);
  if (match) {
    const cell = match[1]!.trim();
    const word = cell ? (cell.replace(/^\*+|\*+$/g, "").split(/\s+/)[0] ?? "") : "";
    if ((VERDICTS as readonly string[]).includes(word)) return word;
  }
  return DASH;
}

const int = (value: number | undefined): number => Math.trunc(value ?? 0);

/** Returns null only when NO usage object was seen at all — zeros are meaningful. */
export function usageTotal(usages: readonly (Usage | null | undefined)[]): Usage | null {
  let inn = 0;
  let out = 0;
  let cacheR = 0;
  let cacheW = 0;
  let found = false;
  for (const usage of usages) {
    if (!usage) continue;
    found = true;
    inn += int(usage.inputTokens);
    out += int(usage.outputTokens);
    cacheR += int(usage.cacheReadTokens);
    cacheW += int(usage.cacheWriteTokens);
  }
  if (!found) return null;
  return { inputTokens: inn, outputTokens: out, cacheReadTokens: cacheR, cacheWriteTokens: cacheW };
}

export function usageFragment(usage: Usage): string {
  const inn = fmtCount(int(usage.inputTokens));
  const out = fmtCount(int(usage.outputTokens));
  const cacheR = fmtCount(int(usage.cacheReadTokens));
  const cacheW = fmtCount(int(usage.cacheWriteTokens));
  return `in ${inn}  out ${out}  cache-r ${cacheR}  cache-w ${cacheW}`;
}

export function usageCells(usage: Usage | null | undefined): UsageCells {
  if (!usage) return { inn: DASH, out: DASH, cache_r: DASH, cache_w: DASH };
  return {
    inn: fmtCount(int(usage.inputTokens)),
    out: fmtCount(int(usage.outputTokens)),
    cache_r: fmtCount(int(usage.cacheReadTokens)),
    cache_w: fmtCount(int(usage.cacheWriteTokens)),
  };
}

/** Exact token counts for markdown logs, or em dashes. */
export function usageMd(usage: Usage | null | undefined): UsageCells {
  if (!usage) return { inn: DASH, out: DASH, cache_r: DASH, cache_w: DASH };
  return {
    inn: String(int(usage.inputTokens)),
    out: String(int(usage.outputTokens)),
    cache_r: String(int(usage.cacheReadTokens)),
    cache_w: String(int(usage.cacheWriteTokens)),
  };
}

export function outcomeLabel(verdict: string): string {
  if (verdict === "PASS") return "Passed";
  if (verdict === "FAIL") return "Failed";
  if (verdict === "UNVERIFIED") return "Unverified";
  return verdict;
}

export const FAIL_OUTCOME: Readonly<Record<string, string>> = {
  timeout: "Timeout",
  error: "Error",
  "no-output": "No output",
  "no-folder": "No folder",
};

export const STATUS_COLOR: Readonly<Record<string, string>> = {
  Prior: DIM,
  Pending: "",
  Running: YELLOW,
  Done: GREEN,
  Failed: RED,
};

export const OUTCOME_COLOR: Readonly<Record<string, string>> = {
  Passed: GREEN,
  Failed: RED,
  Unverified: YELLOW,
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Return [status, note]. Promotes `tc-N-temp/` to `tc-N/` only on a clean success.
 * The order of these checks is load-bearing.
 */
export function classify(kase: Case, exitCode: number | null, timedOut: boolean): [string, string] {
  if (timedOut) return ["timeout", ""];
  if (exitCode !== 0 && exitCode !== null) return ["error", ""];
  if (!isDir(kase.tempDir)) return ["no-folder", "agent never created the temp folder"];
  if (!(isFile(join(kase.tempDir, REPORT)) && isFile(join(kase.tempDir, RESULTS)))) {
    return ["no-output", "temp folder is missing _report.md or _results.md"];
  }
  if (existsSync(kase.outDir)) {
    return [
      "error",
      `${basename(kase.outDir)}/ already exists; left ${basename(kase.tempDir)}/ in place`,
    ];
  }
  try {
    renameSync(kase.tempDir, kase.outDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      "error",
      `could not rename ${basename(kase.tempDir)}/ to ${basename(kase.outDir)}/: ${message}`,
    ];
  }
  return [DONE_OK, ""];
}
