import {
  BOLD,
  DIM,
  GREEN,
  RED,
  RESET,
  YELLOW,
  clipAnsi,
  displayWidth,
  flatten,
  fmtBytes,
  fmtDuration,
  invertBar,
  padClip,
  pyStrip,
  wrapAnsi,
} from "./format.js";
import { DONE_FAIL, DONE_OK, MAX_ZOOM_KEYS } from "./config.js";
import { OUTCOME_COLOR, STATUS_COLOR, usageFragment } from "./outcome.js";
import type { Usage } from "./outcome.js";
import type { SlotStatus } from "./slot.js";

/** Everything the pane renderer needs from a Slot — plain data, no processes or filesystem. */
export interface PaneView {
  /** The stable slot id. Zoom pins to this, not to a position in a list that comes and goes. */
  slot: number;
  name: string | null;
  /** The model this case is running under — panes no longer share one. */
  model: string;
  status: SlotStatus;
  elapsedSeconds: number;
  tools: number;
  streamedBytes: number;
  usage: Usage | null;
  note: string;
  transcript: readonly string[];
  thinking: string;
}

export interface TableRow {
  name: string;
  status: string;
  outcome: string;
  duration: string;
  tools: string;
  inn: string;
  out: string;
  cache_r: string;
  cache_w: string;
}

export interface ViewModel {
  mode: "panes" | "table";
  /** The slot id being zoomed, or null. */
  zoom: number | null;
  scroll: number;
  running: number;
  parallel: number;
  queued: number;
  paused: boolean;
  draining: boolean;
  /** Only the slots worth showing — normally the running ones. */
  panes: PaneView[];
  /** Shown in place of the panes when `panes` is empty. */
  panesNote: string;
  table: TableRow[];
  totals: TableRow;
  statusLeft: string;
}

/** Python: field(text, width, color) */
export function padField(text: string, width: number, color = ""): string {
  let body: string;
  if (displayWidth(text) > width) {
    const clipped = clipAnsi(text, width);
    body = clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
  } else {
    body = text + " ".repeat(width - displayWidth(text));
  }
  return color ? `${color}${body}${RESET}` : body;
}

/** Python: field_right(text, width, color) */
export function padFieldRight(text: string, width: number, color = ""): string {
  let body: string;
  if (displayWidth(text) > width) {
    const clipped = clipAnsi(text, width);
    body = " ".repeat(Math.max(0, width - displayWidth(clipped))) + clipped;
  } else {
    body = " ".repeat(width - displayWidth(text)) + text;
  }
  return color ? `${color}${body}${RESET}` : body;
}

const padLeftNum = (n: number, width: number): string => String(n).padStart(width, " ");
const padRightStr = (s: string, width: number): string => s.padEnd(width, " ");

/** Minimum run-state text kept before the model is dropped, and the gap that separates them. */
const HEADER_MIN_LEFT = 16;
const HEADER_GAP = 2;

/**
 * Right-align `model` on the same line, clipping the left text if the two would collide.
 * On a narrow terminal the model is dropped entirely rather than crowding out the run state
 * or butting up against it with no separator.
 */
function withModel(left: string, model: string, width: number): string {
  if (!model || width <= 0) return left;
  const right = `${model} `;
  const rightW = displayWidth(right);
  const budget = width - rightW - HEADER_GAP;
  if (budget < HEADER_MIN_LEFT) return left;
  const leftC = clipAnsi(left, budget);
  const gap = Math.max(HEADER_GAP, width - displayWidth(leftC) - rightW);
  return `${leftC}${" ".repeat(gap)}${right}`;
}

/**
 * `ordinal` is the pane's 1-based position on screen, which is also its zoom key — the slot id
 * would drift from the digit you press as panes come and go.
 */
export function headerFor(pane: PaneView, ordinal = 1, width = 0): string {
  const model = pane.model;
  const n = padLeftNum(ordinal, 2);
  // An idle pane is not running anything, so there is no model to name.
  if (pane.name === null) return ` ${n}  —       idle`;
  const name = padRightStr(pane.name, 7);
  const elapsed = fmtDuration(pane.elapsedSeconds);
  const status = pane.status;

  let left: string;
  if (status === "run") {
    left =
      ` ${n}  ${name} ${YELLOW}* run${RESET}   ${elapsed}   ` +
      `${pane.tools} tools   ${fmtBytes(pane.streamedBytes)}`;
  } else if (status === DONE_OK) {
    const usage = pane.usage ? usageFragment(pane.usage) : "tokens n/a";
    left = ` ${n}  ${name} ${GREEN}ok     ${RESET} ${elapsed}   ${usage}`;
  } else {
    const color = DONE_FAIL.has(status) ? RED : DIM;
    const extra = pane.usage ? usageFragment(pane.usage) : pane.note || "";
    left = ` ${n}  ${name} ${color}${padRightStr(status, 7)}${RESET} ${elapsed}   ${extra}`;
  }
  return withModel(left, model, width);
}

export function composeStatus(left: string, right: string, width: number): string {
  const rightW = displayWidth(right);
  if (rightW >= width) return invertBar(right, width);
  const leftC = clipAnsi(left, width - rightW);
  const padding = Math.max(0, width - displayWidth(leftC) - rightW);
  return invertBar(leftC + " ".repeat(padding) + right, width);
}

/** `panes` is how many are on screen right now — the zoom keys are 1..panes. */
export function shortcutsFor(mode: "panes" | "table", zoom: number | null, panes = 0): string {
  if (mode === "table") return "q quit  d drain  p pause  r panes  ↑↓ PgUp/PgDn Home/End";
  if (zoom !== null) return "q quit  d drain  p pause  r table  0/esc unzoom";
  const keys = Math.min(panes, MAX_ZOOM_KEYS);
  if (keys < 2) return "q quit  d drain  p pause  r table";
  return `q quit  d drain  p pause  r table  1-${keys} zoom`;
}

export function paneBody(pane: PaneView, bodyRows: number, width: number): string[] {
  if (bodyRows <= 0) return [];
  const indent = "    ";
  const inner = Math.max(8, width - displayWidth(indent));
  const items = [...pane.transcript];
  if (pyStrip(pane.thinking) !== "") {
    items.push(`${DIM}> ${RESET}${flatten(pane.thinking)} …`);
  }
  let wrapped: string[] = [];
  for (const raw of items) {
    const chunks = wrapAnsi(raw, inner);
    if (chunks.length === 0) continue;
    for (const chunk of chunks) wrapped.push(indent + chunk);
  }
  if (wrapped.length > bodyRows) wrapped = wrapped.slice(-bodyRows);
  const out = wrapped.map((line) => padClip(line, width));
  while (out.length < bodyRows) out.push(" ".repeat(width));
  return out;
}

export interface PanesOptions {
  running: number;
  parallel: number;
  queued: number;
  paused: boolean;
  draining: boolean;
  note: string;
  zoom: number | null;
}

export function layoutPanes(
  panes: readonly PaneView[],
  opts: PanesOptions,
  rows: number,
  cols: number,
): string[] {
  const width = Math.max(1, cols);
  const flags: string[] = [];
  if (opts.paused) flags.push(`${YELLOW}PAUSED${RESET}`);
  if (opts.draining) flags.push(`${YELLOW}DRAINING${RESET}`);
  const suffix = flags.length > 0 ? `  ${flags.join("  ")}` : "";
  // No single model to name any more — each pane header carries its own, right-aligned.
  const counts = `${BOLD}${opts.running}/${opts.parallel}${RESET} agents  ${opts.queued} queued`;
  const title = invertBar(` cairn qa  ${counts}  Run Everything${suffix}`, width);
  const remaining = Math.max(0, rows - 1);

  // Zoom names a slot, not a position: the list is filtered and reorders as cases finish.
  const zoomed = opts.zoom === null ? undefined : panes.find((p) => p.slot === opts.zoom);
  const chosen = zoomed !== undefined ? [zoomed] : [...panes];

  const lines: string[] = [title];
  if (chosen.length === 0) {
    lines.push(padClip(`${DIM}  ${opts.note}${RESET}`, width));
    while (lines.length < rows) lines.push(" ".repeat(width));
    return lines.slice(0, rows);
  }

  const n = chosen.length;
  const compact = remaining < n * 3;

  if (compact) {
    lines.push(
      padClip(
        `${DIM}grow the window for live transcripts (need ~${1 + n * 3} rows)${RESET}`,
        width,
      ),
    );
    for (const [i, pane] of chosen.entries()) {
      lines.push(invertBar(headerFor(pane, i + 1, width), width));
    }
    while (lines.length < rows) lines.push(" ".repeat(width));
    return lines.slice(0, rows);
  }

  const paneH = Math.floor(remaining / n);
  const leftover = remaining - paneH * n;
  for (const [i, pane] of chosen.entries()) {
    const h = paneH + (i < leftover ? 1 : 0);
    lines.push(invertBar(headerFor(pane, i + 1, width), width));
    lines.push(...paneBody(pane, Math.max(0, h - 1), width));
  }
  while (lines.length < rows) lines.push(" ".repeat(width));
  return lines.slice(0, rows);
}

export const COL_TC = 7;
export const COL_STATUS = 7;
export const COL_OUTCOME = 10;
export const COL_DURATION = 8;
export const COL_TOOLS = 5;
export const COL_IO = 6;
export const COL_CACHE = 7;

export const TABLE_HEAD: TableRow = {
  name: "TC",
  status: "Status",
  outcome: "Outcome",
  duration: "Duration",
  tools: "Tools",
  inn: "In",
  out: "Out",
  cache_r: "Cache-r",
  cache_w: "Cache-w",
};

export const BLANK_METRICS = {
  duration: "—",
  tools: "—",
  inn: "—",
  out: "—",
  cache_r: "—",
  cache_w: "—",
} as const;

export function composeTableLine(row: TableRow, color = true): string {
  const st = row.status ?? "";
  const oc = row.outcome ?? "";
  return (
    " " +
    padField(row.name ?? "", COL_TC) +
    "  " +
    padField(st, COL_STATUS, color ? (STATUS_COLOR[st] ?? "") : "") +
    "  " +
    padField(oc, COL_OUTCOME, color ? (OUTCOME_COLOR[oc] ?? "") : "") +
    "  " +
    padFieldRight(row.duration ?? "", COL_DURATION) +
    "  " +
    padFieldRight(row.tools ?? "", COL_TOOLS) +
    "  " +
    padFieldRight(row.inn ?? "", COL_IO) +
    "  " +
    padFieldRight(row.out ?? "", COL_IO) +
    "  " +
    padFieldRight(row.cache_r ?? "", COL_CACHE) +
    "  " +
    padFieldRight(row.cache_w ?? "", COL_CACHE)
  );
}

export function tableHeader(cols: number): string {
  return invertBar(composeTableLine(TABLE_HEAD, false), cols);
}

export function formatTableRow(row: TableRow, cols: number): string {
  return padClip(composeTableLine(row, true), cols);
}

export interface TableLayout {
  lines: string[];
  scroll: number;
  page: number;
}

/**
 * Header frozen on row 0; the Total row sits immediately below the last case row rather than
 * being pushed to the bottom of the window. Once the table is long enough to fill the view the
 * last case row already reaches the bottom, so the Total row stays pinned there as before.
 */
export function layoutTable(
  rowsData: readonly TableRow[],
  totals: TableRow,
  scroll: number,
  rows: number,
  cols: number,
): TableLayout {
  const width = Math.max(1, cols);
  const header = tableHeader(width);
  const footer = invertBar(composeTableLine(totals, false), width);
  if (rows <= 0) return { lines: [], scroll: 0, page: 1 };
  if (rows === 1) return { lines: [header], scroll: 0, page: 1 };
  if (rows === 2) return { lines: [header, footer], scroll: 0, page: 1 };
  const view = rows - 2;
  const maxScroll = Math.max(0, rowsData.length - view);
  const clamped = Math.max(0, Math.min(scroll, maxScroll));
  const window = rowsData.slice(clamped, clamped + view);
  const lines: string[] = [header];
  for (const row of window) lines.push(formatTableRow(row, width));
  lines.push(footer);
  while (lines.length < rows) lines.push(" ".repeat(width));
  return { lines: lines.slice(0, rows), scroll: clamped, page: view };
}

/** The whole screen: body rows plus the reverse-video status bar on the last line. */
export function frame(vm: ViewModel, rows: number, cols: number): TableLayout {
  const width = Math.max(1, cols);
  const bodyRows = Math.max(0, rows - 1);
  let lines: string[];
  let scroll = vm.scroll;
  let page = 10;

  if (vm.mode === "table") {
    const laid = layoutTable(vm.table, vm.totals, vm.scroll, bodyRows, width);
    lines = laid.lines;
    scroll = laid.scroll;
    page = laid.page;
  } else {
    lines = layoutPanes(
      vm.panes,
      {
        running: vm.running,
        parallel: vm.parallel,
        queued: vm.queued,
        paused: vm.paused,
        draining: vm.draining,
        note: vm.panesNote,
        zoom: vm.zoom,
      },
      bodyRows,
      width,
    );
  }

  const out = lines.slice(0, bodyRows);
  while (out.length < bodyRows) out.push(" ".repeat(width));
  out.push(composeStatus(vm.statusLeft, shortcutsFor(vm.mode, vm.zoom, vm.panes.length), width));
  return { lines: out, scroll, page };
}
