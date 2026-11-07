import { CODES, type DiagnosticSink } from "./diagnostics.js";
import type { PositionedRun } from "./text.js";
import { round2, runsToText } from "./text.js";

/**
 * Reading order across columns.
 *
 * A page's runs carry positions and nothing else. Read top to bottom, a
 * two-column page interleaves its columns into text that reads like prose and
 * is not, and a quotation that spans a line break in one column is no longer
 * a substring of the text at all.
 *
 * The page's runs are cut into fragments at wide gaps on each line, and the
 * columns are found where the narrow fragments leave an x band empty: a gutter.
 * A line with a fragment across a gutter (a title, an abstract, a wide figure
 * caption) spans the page; the lines between two spanning stretches are read
 * column by column, and the stretches in turn. That is what lets a page whose
 * title runs the full width still be read as two columns below it, which a
 * gutter required to be empty from top to bottom never could.
 *
 * Pure: runs in, groups in reading order out, so each rule is testable alone.
 */

/** `--columns`: inferred from the page, or as many as asked (1 reads top to bottom). */
export type ColumnsOption = "auto" | number;

/** How a page was read, as `pdf text` reports it per page. */
export interface PageLayout {
  /** The most columns any stretch of the page was read in; 1 when read top to bottom. */
  columns: number;
  /** `auto`: inferred from the gaps between runs; `forced`: as `--columns` asked. */
  method: "auto" | "forced";
  /** The gutters' x positions in page-upright points, left to right. */
  gutters: number[];
  /** Lines read whole across the gutters (titles, wide captions). */
  spanning: number;
}

export interface ReadingOrder {
  /** The runs in reading order, a group per stretch read as one: buildLines or runsToText each. */
  groups: PositionedRun[][];
  layout: PageLayout;
  /** Auto found more gutters than it trusts (a table, a form): read top to bottom instead. */
  uncertain?: number;
}

/** Parses `--columns`: `auto`, or a whole number from 1 to {@link MAX_COLUMNS}. */
export function parseColumns(value: string | undefined): ColumnsOption {
  if (value === undefined || value === "auto") return "auto";
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COLUMNS)
    throw new Error(
      `Invalid --columns value: ${value} (expected auto or a whole number from 1 to ${MAX_COLUMNS})`,
    );
  return n;
}

export const MAX_COLUMNS = 6;
/** Auto trusts at most this many columns; more candidate gutters is a table or a form. */
const AUTO_MAX = 3;

interface Fragment {
  x0: number;
  x1: number;
  runs: PositionedRun[];
  chars: number;
}

interface PageLine {
  y: number;
  fragments: Fragment[];
}

const upright = (run: PositionedRun): boolean => run.angle === 0 && !run.vertical;

/** Runs on one baseline, by the tolerance `runsToText` and `buildLines` use. */
function linesOf(runs: PositionedRun[]): PositionedRun[][] {
  const ordered = [...runs].sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
  const lines: PositionedRun[][] = [];
  for (const run of ordered) {
    const line = lines[lines.length - 1];
    const previous = line?.[line.length - 1];
    if (previous && Math.abs(run.y - previous.y) <= Math.max(previous.size, run.size) * 0.35)
      line.push(run);
    else lines.push([run]);
  }
  return lines;
}

/** A line cut at each gap wider than an em: the pieces a gutter falls between. */
function fragmentsOf(line: PositionedRun[]): Fragment[] {
  const sorted = [...line].sort((a, b) => a.x - b.x || a.index - b.index);
  const out: Fragment[] = [];
  for (const run of sorted) {
    const last = out[out.length - 1];
    const gap = last ? run.x - last.x1 : Infinity;
    if (last && gap <= Math.max(3, run.size)) {
      last.runs.push(run);
      last.x1 = Math.max(last.x1, run.x + run.width);
      last.chars += run.text.length;
    } else
      out.push({
        x0: run.x,
        x1: run.x + Math.max(run.width, 0),
        runs: [run],
        chars: run.text.length,
      });
  }
  return out;
}

/** Empty x bands between the narrow fragments: [start, end] in points, widest first. */
function emptyBands(
  lines: PageLine[],
  left: number,
  right: number,
  minWidth: number,
): [number, number][] {
  const width = right - left;
  if (width <= 0) return [];
  const narrow = lines.flatMap((line) => line.fragments).filter((f) => f.x1 - f.x0 < width * 0.55);
  if (narrow.length === 0) return [];
  const cells = 400;
  const step = width / cells;
  const covered = new Array<boolean>(cells).fill(false);
  for (const f of narrow) {
    const from = Math.max(0, Math.floor((f.x0 - left) / step));
    const to = Math.min(cells - 1, Math.floor((f.x1 - left) / step));
    for (let index = from; index <= to; index += 1) covered[index] = true;
  }
  const bands: [number, number][] = [];
  let start = -1;
  for (let index = 0; index <= cells; index += 1) {
    if (index < cells && !covered[index]) {
      if (start === -1) start = index;
      continue;
    }
    // A band touching the content's edge is a margin, not a gutter.
    if (start > 0 && index < cells && (index - start) * step >= minWidth)
      bands.push([left + start * step, left + index * step]);
    start = -1;
  }
  return bands.sort((a, b) => b[1] - b[0] - (a[1] - a[0]) || a[0] - b[0]);
}

/**
 * Whether each side of the gutters holds a column: at least five lines, a sixth
 * of the text, a quarter of the page's height and a sixth of its width, and
 * lines of a dozen characters or more that fill it. The last two are what tell a
 * column of prose from a table's column of short cells, which would otherwise be
 * read down each column rather than across each row.
 */
function holdsColumns(
  lines: PageLine[],
  gutters: number[],
  width: number,
  height: number,
): boolean {
  const bounds = [-Infinity, ...gutters, Infinity];
  const total = lines.reduce((n, line) => n + line.fragments.reduce((m, f) => m + f.chars, 0), 0);
  for (let column = 0; column < bounds.length - 1; column += 1) {
    const inside = lines
      .map((line) => ({
        y: line.y,
        fragments: line.fragments.filter(
          (f) => f.x0 >= bounds[column] && f.x1 <= bounds[column + 1],
        ),
      }))
      .filter((line) => line.fragments.length > 0);
    if (inside.length < 5) return false;
    const pieces = inside.flatMap((line) => line.fragments);
    if (pieces.reduce((n, f) => n + f.chars, 0) < total / 6) return false;
    if (height > 0 && inside[inside.length - 1].y - inside[0].y < height * 0.25) return false;
    const span = Math.max(...pieces.map((f) => f.x1)) - Math.min(...pieces.map((f) => f.x0));
    if (span < width * 0.15) return false;
    const median = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    if (median(pieces.map((f) => f.x1 - f.x0)) < span * 0.5) return false;
    if (median(pieces.map((f) => f.chars)) < 12) return false;
  }
  return true;
}

/**
 * The runs of a page in reading order, and the layout it was read in.
 *
 * Rotated and vertical runs take no part in finding columns, and are read with
 * whatever stretch their baseline falls in.
 */
export function readingOrder(
  runs: PositionedRun[],
  pageWidth: number,
  option: ColumnsOption = "auto",
): ReadingOrder {
  const single = (method: PageLayout["method"], uncertain?: number): ReadingOrder => ({
    groups: runs.length ? [runs] : [],
    layout: { columns: 1, method, gutters: [], spanning: 0 },
    ...(uncertain ? { uncertain } : {}),
  });
  const method = option === "auto" ? "auto" : "forced";
  if (option === 1 || runs.filter(upright).length < 8) return single(method);

  const raw = linesOf(runs);
  const lines: PageLine[] = raw.map((line) => ({
    y: line[0].y,
    fragments: fragmentsOf(line.filter(upright)),
  }));
  const fragments = lines.flatMap((line) => line.fragments);
  if (fragments.length === 0) return single(method);
  const left = Math.min(...fragments.map((f) => f.x0));
  const right = Math.max(...fragments.map((f) => f.x1));
  const top = Math.min(...lines.map((line) => line.y));
  const height = Math.max(...lines.map((line) => line.y)) - top;
  const sizes = runs
    .filter(upright)
    .map((run) => run.size)
    .sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] ?? 10;
  const minWidth = Math.max(pageWidth * 0.015, body * 0.8);

  let gutters: number[];
  const bands = emptyBands(lines, left, right, minWidth);
  if (option === "auto") {
    if (bands.length === 0) return single(method);
    if (bands.length > AUTO_MAX) return single(method, bands.length + 1);
    gutters = bands.map(([a, b]) => (a + b) / 2).sort((a, b) => a - b);
    // Drop the narrowest gutter until every column holds a column's worth of text.
    while (gutters.length > 0 && !holdsColumns(lines, gutters, right - left, height)) {
      const narrowest = bands
        .filter(([a, b]) => gutters.includes((a + b) / 2))
        .sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0];
      gutters = gutters.filter((g) => g !== (narrowest[0] + narrowest[1]) / 2);
    }
    if (gutters.length === 0) return single(method);
  } else {
    const wanted = Math.min(option, MAX_COLUMNS) - 1;
    gutters = bands
      .slice(0, wanted)
      .map(([a, b]) => (a + b) / 2)
      .sort((a, b) => a - b);
    // Too few empty bands: equal columns across the content.
    if (gutters.length < wanted)
      gutters = Array.from(
        { length: wanted },
        (_, index) => left + ((right - left) * (index + 1)) / (wanted + 1),
      );
  }

  const bounds = [-Infinity, ...gutters, Infinity];
  const columnOf = (x: number): number => {
    for (let column = 0; column < bounds.length - 1; column += 1)
      if (x < bounds[column + 1]) return column;
    return bounds.length - 2;
  };
  const groups: PositionedRun[][] = [];
  let spanning = 0;
  let stretch: PositionedRun[][] = gutters.map(() => []).concat([[]]);
  const flush = () => {
    for (const column of stretch) if (column.length) groups.push(column);
    stretch = gutters.map(() => []).concat([[]]);
  };
  for (const [index, line] of lines.entries()) {
    const rotated = raw[index].filter((run) => !upright(run));
    const crosses = line.fragments.some((f) => gutters.some((g) => f.x0 < g && f.x1 > g));
    if (crosses) {
      flush();
      groups.push([...line.fragments.flatMap((f) => f.runs), ...rotated]);
      spanning += 1;
      continue;
    }
    for (const f of line.fragments) stretch[columnOf((f.x0 + f.x1) / 2)].push(...f.runs);
    stretch[0].push(...rotated);
  }
  flush();
  const used = Math.max(1, gutters.length + 1);
  return {
    groups,
    layout: { columns: used, method, gutters: gutters.map(round2), spanning },
  };
}

/** A page's reading order reported: AP210 when it was read in columns, AP201 when auto distrusted what it found. */
export function reportLayout(sink: DiagnosticSink, page: number, order: ReadingOrder): void {
  if (order.uncertain)
    sink.add({
      code: CODES.readingOrderUncertain,
      quality: "approximate",
      message: `Found ${order.uncertain} candidate columns; the page was read top to bottom instead`,
      page,
      remediation: "Name the layout with --columns if the page is in columns.",
    });
  else if (order.layout.columns > 1)
    sink.add({
      code: CODES.columnsDetected,
      quality: "exact",
      message:
        `Read as ${order.layout.columns} columns` +
        (order.layout.method === "forced" ? " (--columns)" : "") +
        (order.layout.spanning ? `, ${order.layout.spanning} line(s) across them read whole` : ""),
      page,
    });
}

/** A page's text in reading order: each stretch's lines, the stretches in turn. */
export function orderedText(order: ReadingOrder): string {
  return order.groups
    .map((group) => runsToText(group))
    .filter((text) => text.length > 0)
    .join("\n");
}
