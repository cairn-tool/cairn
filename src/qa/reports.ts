import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fmtDuration } from "./format.js";
import { usageFragment, usageMd } from "./outcome.js";
import type { Usage } from "./outcome.js";

export interface Rec {
  name: string;
  /** The model this case actually ran under — cases no longer share one. */
  model: string;
  status: string;
  exitCode: number | null;
  /** Seconds from the start of the session to when this case was dispatched. */
  startedS: number;
  durationS: number;
  /** Python stores a literal int 0 for skipped rows; json.dumps renders that `0`, not `0.0`. */
  durationIsInt: boolean;
  usage: Usage | null;
  note: string;
  sessionId: string;
  logDir: string;
  tools: number;
}

export interface SessionStats {
  ok: number;
  fail: number;
  skipped: number;
  durationS: number;
  tools: number;
  usage: Usage | null;
  wallS: number;
}

export interface SessionInfo {
  runId: string;
  pid: number;
  /** What `--model` supplied; a case with its own `model:` key overrides it. */
  defaultModel: string;
  parallel: number;
  repo: string;
  runsDir: string;
  sessionLog: string;
  logRoot: string;
}

/** Python's repr for a float: an integral value keeps its `.0`. */
function pyFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

const FLOAT_PREFIX = "@@FLOAT:";
const FLOAT_SUFFIX = "@@";

/** A marker that survives JSON.stringify as a string and is unquoted afterwards. */
export const pyFloatMarker = (value: number): string =>
  `${FLOAT_PREFIX}${pyFloat(value)}${FLOAT_SUFFIX}`;

const FLOAT_RE = /"@@FLOAT:([^"@]*)@@"/g;
const NON_ASCII_RE = /[\u0080-\uffff]/g;

/**
 * json.dumps(payload, indent=2) — including ensure_ascii, which escapes every non-ASCII
 * character (the em dashes in `outcome` among them). JSON.stringify does not escape those.
 */
export function pyJsonDumps(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2).replace(FLOAT_RE, (_m, num: string) => num);
  return text.replace(NON_ASCII_RE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Python: round(x, 1) — half-to-even, though real durations never land on a midpoint. */
export function round1(value: number): number {
  const scaled = value * 10;
  const nearest = Math.round(scaled);
  const rounded =
    Math.abs(scaled - Math.trunc(scaled)) === 0.5 && nearest % 2 !== 0 ? nearest - 1 : nearest;
  return rounded / 10;
}

export function writeSummaryJson(
  info: SessionInfo,
  records: readonly Rec[],
  outcomeOf: (rec: Rec) => string,
): void {
  mkdirSync(info.logRoot, { recursive: true });
  const payload = {
    run_id: info.runId,
    pid: info.pid,
    default_model: info.defaultModel,
    parallel: info.parallel,
    repo: info.repo,
    runs_dir: info.runsDir,
    session_log: info.sessionLog,
    cases: records.map((r) => ({
      name: r.name,
      model: r.model,
      status: r.status,
      exit_code: r.exitCode,
      started_s: pyFloatMarker(round1(r.startedS)),
      duration_s: r.durationIsInt ? round1(r.durationS) : pyFloatMarker(round1(r.durationS)),
      tools: r.tools,
      usage: r.usage,
      note: r.note,
      session_id: r.sessionId,
      log_dir: r.logDir,
      outcome: outcomeOf(r),
    })),
  };
  writeFileSync(join(info.logRoot, "summary.json"), `${pyJsonDumps(payload)}\n`, "utf8");
}

export function renderSessionLog(
  info: SessionInfo,
  records: readonly Rec[],
  stats: SessionStats,
  outcomeOf: (rec: Rec) => string,
): string {
  const usage = stats.usage;
  const tok = usage ? usageFragment(usage) : "tokens —";
  const md = usageMd(usage);
  const lines: string[] = [
    `# cairn qa ${info.runId}  pid ${info.pid}`,
    "",
    `- **Launched:** ${info.runId} UTC`,
    `- **PID:** ${info.pid}`,
    `- **Default model:** \`${info.defaultModel}\``,
    `- **Repo:** \`${info.repo}\``,
    `- **Runs dir:** \`${info.runsDir}\``,
    `- **Parallel:** ${info.parallel}`,
    `- **Wall clock:** ${fmtDuration(stats.wallS)}`,
    "",
    "## Totals",
    "",
    `- **ok / fail / skipped:** ${stats.ok} / ${stats.fail} / ${stats.skipped}`,
    `- **Sum of case durations:** ${fmtDuration(stats.durationS)} ` +
      "(can exceed wall clock because cases run in parallel)",
    `- **Tools:** ${stats.tools}`,
    `- **Tokens:** ${tok}`,
    `  - in ${md.inn} · out ${md.out} · cache-r ${md.cache_r} · cache-w ${md.cache_w}`,
    "",
    "## Cases",
    "",
    "| Case | Model | Status | Outcome | Duration | Tools | In | Out | Cache-r | Cache-w | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const rec of records) {
    const cells = usageMd(rec.usage);
    const note = rec.note ? rec.note.replaceAll("|", "\\|") : "—";
    lines.push(
      `| ${rec.name} | ${rec.model} | ${rec.status} | ${outcomeOf(rec)} | ` +
        `${fmtDuration(rec.durationS)} | ${rec.tools} | ` +
        `${cells.inn} | ${cells.out} | ${cells.cache_r} | ${cells.cache_w} | ` +
        `${note} |`,
    );
  }
  if (records.length === 0) {
    lines.push("| — | — | — | — | — | — | — | — | — | — | " + "no cases finished yet |");
  }
  lines.push("");
  return lines.join("\n");
}

export function writeSessionLog(
  info: SessionInfo,
  records: readonly Rec[],
  stats: SessionStats,
  outcomeOf: (rec: Rec) => string,
): void {
  mkdirSync(dirname(info.sessionLog), { recursive: true });
  writeFileSync(info.sessionLog, renderSessionLog(info, records, stats, outcomeOf), "utf8");
}

export function consoleSummary(
  info: SessionInfo,
  stats: SessionStats,
  trackerPath: string | null,
): string {
  const usage = stats.usage;
  const tok = usage ? usageFragment(usage) : "tokens —";
  const lines = [
    `cairn qa ${info.runId}  pid ${info.pid}`,
    `${stats.ok} ok / ${stats.fail} fail / ${stats.skipped} skipped`,
    `elapsed ${fmtDuration(stats.wallS)}  ` +
      `case-time ${fmtDuration(stats.durationS)}  tools ${stats.tools}`,
    tok,
    `run log  ${info.sessionLog}`,
  ];
  if (trackerPath !== null) lines.push(`tracker  ${trackerPath}`);
  return lines.join("\n");
}
