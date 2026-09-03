import { CODES, DiagnosticSink } from "./diagnostics.js";
import type { PageRuns, PositionedRun } from "./text.js";
import { round2 } from "./text.js";
import type { Block, InlineSpan } from "./types.js";

/**
 * Geometric structure inference.
 *
 * A PDF has no paragraphs, no headings, and no lists — only positioned glyph
 * runs — so everything here is inference from geometry and font metrics. The
 * stages are exported as pure functions taking and returning plain data, which
 * is what makes each one testable on its own and lets them be reviewed one at a
 * time.
 *
 * Every sort ends with an explicit `(page, index)` tie-break. A heuristic whose
 * output flips between runs is worse than one that is wrong consistently.
 */

/** A line: runs sharing a baseline, ordered left to right. */
export interface Line {
  page: number;
  y: number;
  runs: PositionedRun[];
  text: string;
  /** Left edge, for indent comparisons. */
  x: number;
  /** The modal font size across the line's runs. */
  size: number;
  bold: boolean;
  /** x positions where a gap wider than 1.5em opened — the only table signal. */
  gaps: number[];
}

const byPosition = (a: PositionedRun, b: PositionedRun): number =>
  a.page - b.page || a.y - b.y || a.x - b.x || a.index - b.index;

/**
 * The value occurring most often.
 *
 * The tie-break direction is a real decision, not a detail. For a *size* the
 * larger value wins, because a tie between body and caption should read as the
 * body. For a *spacing* the smaller wins: line spacing within a paragraph is the
 * tightest recurring gap, and heading-to-body gaps tie with it on any document
 * short enough that body lines do not outnumber them — at which point picking
 * the larger elects the heading gap as the body leading and no paragraph ever
 * breaks.
 */
function mode(values: number[], prefer: "largest" | "smallest" = "largest"): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [value, count] of counts) {
    const wins =
      count > bestCount ||
      (count === bestCount && (prefer === "largest" ? value > best : value < best));
    if (wins) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Stage 1 — normalize
 * ------------------------------------------------------------------ */

export interface NormalizeResult {
  body: PositionedRun[];
  dropped: number;
}

/**
 * Splits out runs no axis-aligned heuristic can place.
 *
 * Text at an arbitrary angle and vertical writing are excluded rather than
 * folded in at the wrong position, and reported. Every stage after this may
 * assume upright, left-to-right runs.
 */
export function normalize(runs: PositionedRun[], sink: DiagnosticSink): NormalizeResult {
  const body: PositionedRun[] = [];
  let dropped = 0;
  for (const run of runs) {
    if (run.angle === null || run.angle !== 0 || run.vertical) {
      dropped += 1;
      sink.add({
        code: CODES.rotatedTextDropped,
        quality: "unsupported",
        message: "Rotated or vertical text cannot be placed in reading order and was excluded",
        page: run.page,
      });
      continue;
    }
    body.push(run);
  }
  return { body, dropped };
}

/* ------------------------------------------------------------------ *
 * Stage 2 — running headers and footers
 * ------------------------------------------------------------------ */

/** Digits masked, so `Page 3 of 40` and `Page 4 of 40` land in one bucket. */
function artifactKey(run: PositionedRun): string {
  return `${Math.round(run.y / 2)}|${run.text.trim().replace(/\d+/g, "#")}`;
}

/**
 * Removes text that repeats at the same height on most pages.
 *
 * Requires at least four pages: below that, repetition is not evidence. A bucket
 * that repeats but is *not* near an edge is left alone — that is a section title
 * or a watermark, and dropping it would delete content.
 */
export function removeArtifacts(
  runs: PositionedRun[],
  pageCount: number,
  pageHeight: number,
  sink: DiagnosticSink,
): PositionedRun[] {
  if (pageCount < 4) return runs;

  const pagesFor = new Map<string, Set<number>>();
  for (const run of runs) {
    const key = artifactKey(run);
    const seen = pagesFor.get(key);
    if (seen) seen.add(run.page);
    else pagesFor.set(key, new Set([run.page]));
  }

  const edge = pageHeight * 0.12;
  const artifacts = new Set<string>();
  for (const [key, pages] of pagesFor) {
    // 40%, not a majority. A bound book alternates its running heads between
    // verso and recto — the title on one side, the chapter on the other — so
    // each appears on about half the pages and a majority threshold catches
    // neither. Content that genuinely repeats at a fixed height within the top
    // or bottom eighth of two pages in five is a running head by any reading.
    if (pages.size / pageCount < 0.4) continue;
    const y = Number(key.split("|")[0]) * 2;
    if (y > edge && y < pageHeight - edge) continue;
    artifacts.add(key);
  }
  if (artifacts.size === 0) return runs;

  const kept = runs.filter((run) => !artifacts.has(artifactKey(run)));
  sink.add({
    code: CODES.artifactsRemoved,
    quality: "exact",
    message: `Removed ${runs.length - kept.length} running header or footer run(s) repeating across pages`,
  });
  return kept;
}

/* ------------------------------------------------------------------ *
 * Stage 3 — columns
 * ------------------------------------------------------------------ */

/**
 * Splits a page's runs into columns, or reports that it could not.
 *
 * Reading a two-column page top to bottom interleaves the columns into text that
 * reads like prose and is not — a degradation indistinguishable from success, so
 * refusing to look is not the safe option. Looking, with a reported failure
 * mode, is.
 *
 * A gutter is a vertical band at least 3% of the page wide containing no run and
 * spanning at least 70% of the content's height. A candidate is rejected when
 * the resulting sides differ by more than 6:1, which is a hanging indent or a
 * figure rather than a gutter.
 */
export function splitColumns(
  runs: PositionedRun[],
  pageWidth: number,
  sink: DiagnosticSink,
  page: number,
): PositionedRun[][] {
  if (runs.length < 8) return [runs];

  const minGutter = pageWidth * 0.03;
  const left = Math.min(...runs.map((run) => run.x));
  const right = Math.max(...runs.map((run) => run.x + run.width));
  const top = Math.min(...runs.map((run) => run.y));
  const bottom = Math.max(...runs.map((run) => run.y));
  const span = bottom - top;

  // Sample the content band; a column boundary is an x with no ink either side.
  const step = Math.max(1, Math.floor((right - left) / 200));
  const occupied: boolean[] = [];
  for (let x = left; x <= right; x += step) {
    const index = Math.floor((x - left) / step);
    occupied[index] = runs.some((run) => run.x <= x && run.x + run.width >= x);
  }

  const gutters: number[] = [];
  let runStart = -1;
  for (let index = 0; index < occupied.length; index += 1) {
    if (!occupied[index]) {
      if (runStart === -1) runStart = index;
      continue;
    }
    if (runStart !== -1) {
      const width = (index - runStart) * step;
      if (width >= minGutter && runStart > 0)
        gutters.push(left + (runStart + (index - runStart) / 2) * step);
      runStart = -1;
    }
  }

  if (gutters.length === 0 || gutters.length > 2) {
    if (gutters.length > 2)
      sink.add({
        code: CODES.readingOrderUncertain,
        quality: "approximate",
        message: `Found ${gutters.length + 1} candidate columns; the page was read top to bottom instead`,
        page,
      });
    return [runs];
  }

  const bounds = [left - 1, ...gutters, right + 1];
  const columns: PositionedRun[][] = [];
  for (let index = 0; index < bounds.length - 1; index += 1)
    columns.push(runs.filter((run) => run.x > bounds[index] && run.x <= bounds[index + 1]));

  const sizes = columns.map((column) => column.length).filter((count) => count > 0);
  if (sizes.length < 2 || Math.max(...sizes) / Math.min(...sizes) > 6 || span <= 0) return [runs];

  sink.add({
    code: CODES.columnsDetected,
    quality: "exact",
    message: `Read as ${columns.length} columns`,
    page,
  });
  return columns.filter((column) => column.length > 0);
}

/* ------------------------------------------------------------------ *
 * Stage 4 — lines
 * ------------------------------------------------------------------ */

/** Groups runs into lines and records the wide gaps within each. */
export function buildLines(runs: PositionedRun[]): Line[] {
  if (runs.length === 0) return [];
  const ordered = [...runs].sort(byPosition);
  const groups: PositionedRun[][] = [[ordered[0]]];

  for (const run of ordered.slice(1)) {
    const group = groups[groups.length - 1];
    const previous = group[group.length - 1];
    const tolerance = Math.max(previous.size, run.size) * 0.35;
    if (run.page === previous.page && Math.abs(run.y - previous.y) <= tolerance) group.push(run);
    else groups.push([run]);
  }

  return groups.map((group) => {
    const sorted = [...group].sort((a, b) => a.x - b.x || a.index - b.index);
    const gaps: number[] = [];
    let text = sorted[0].text;
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const run = sorted[index];
      const gap = run.x - (previous.x + previous.width);
      if (gap > previous.size * 1.5) gaps.push(round2(run.x));
      const needsSpace = gap > previous.size * 0.25 && !/\s$/.test(text) && !/^\s/.test(run.text);
      text += needsSpace ? ` ${run.text}` : run.text;
    }
    return {
      page: sorted[0].page,
      y: sorted[0].y,
      runs: sorted,
      text: text.trim(),
      x: round2(sorted[0].x),
      size: mode(sorted.map((run) => run.size)),
      bold: sorted.every((run) => run.bold),
      gaps,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Stages 5-9 — blocks
 * ------------------------------------------------------------------ */

const BULLETS = /^[•‣▪◦·⁃∙*–—-]\s*$/;
const ORDINAL = /^\(?(\d{1,3}|[ivxlcdm]{1,7}|[A-Za-z])[.)]$/;

/**
 * A line whose first run is a list marker.
 *
 * `rest` is the line's text with the marker consumed. Keeping it would render
 * `- • The first finding`, because remark-stringify supplies the bullet and the
 * source's own marker is then duplicated inside the item.
 */
function markerOf(line: Line): { ordered: boolean; textX: number; rest: string } | null {
  const first = line.runs[0];
  if (!first) return null;
  const token = first.text.trim();
  const withoutFirstRun = (): string =>
    line.runs
      .slice(1)
      .map((run) => run.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  if (line.runs.length >= 2) {
    const next = line.runs[1];
    if (BULLETS.test(token)) return { ordered: false, textX: next.x, rest: withoutFirstRun() };
    if (ORDINAL.test(token)) return { ordered: true, textX: next.x, rest: withoutFirstRun() };
  }
  const inline = /^([•‣▪◦·*]|\(?\d{1,3}[.)])\s+/.exec(line.text);
  if (inline)
    return {
      ordered: /\d/.test(inline[1]),
      textX: line.x + first.size,
      rest: line.text.slice(inline[0].length).trim(),
    };
  return null;
}

/** Tokens seen hyphenated mid-line, which must not be rejoined at a line end. */
function realHyphenations(lines: Line[]): Set<string> {
  const seen = new Set<string>();
  for (const line of lines)
    for (const match of line.text.matchAll(/(\w+-\w+)/g)) seen.add(match[1].toLowerCase());
  return seen;
}

export interface LayoutOptions {
  /** Outline titles to level, used to pin heading levels where they agree. */
  headingLevels?: Map<string, number>;
}

/**
 * Turns one document's pages into blocks.
 *
 * Column splitting, line grouping, and paragraph breaking are per page; the
 * modal body size and the heading size ranking are computed across the whole
 * document, because a per-page ranking makes heading levels drift between pages
 * of the same document.
 */
export function blocksFromLayout(
  pages: PageRuns[],
  sink: DiagnosticSink,
  options: LayoutOptions = {},
): Block[] {
  const allRuns = pages.flatMap((page) => page.runs);
  if (allRuns.length === 0) return [];

  const { body } = normalize(allRuns, sink);
  if (body.length === 0) return [];

  const pageHeight = mode(pages.map((page) => page.height));
  const kept = removeArtifacts(body, pages.length, pageHeight, sink);

  // Weighted by characters, not by run count: a document full of tiny footnote
  // runs would otherwise elect the footnote size as the body size.
  const weights = new Map<number, number>();
  for (const run of kept) {
    const bucket = Math.round(run.size * 4) / 4;
    weights.set(bucket, (weights.get(bucket) ?? 0) + run.text.length);
  }
  let bodySize = 0;
  let bodyWeight = -1;
  for (const [size, weight] of weights)
    if (weight > bodyWeight || (weight === bodyWeight && size > bodySize)) {
      bodySize = size;
      bodyWeight = weight;
    }

  const lines: Line[] = [];
  for (const page of pages) {
    const pageRuns = kept.filter((run) => run.page === page.page);
    if (pageRuns.length === 0) continue;
    for (const column of splitColumns(pageRuns, page.width, sink, page.page))
      lines.push(...buildLines(column));
  }
  if (lines.length === 0) return [];

  // Heading level by rank, never by ratio. A ratio produces H1/H3/H6 with no H2,
  // which markdownlint flags — and a converted document has to lint clean where
  // it lands.
  const candidateSizes = [
    ...new Set(
      lines
        .filter((line) => line.size >= bodySize * 1.15 || (line.bold && line.size >= bodySize))
        .map((line) => line.size),
    ),
  ].sort((a, b) => b - a);
  const levelFor = new Map<number, number>();
  candidateSizes.forEach((size, index) => levelFor.set(size, Math.min(index + 1, 6)));
  if (candidateSizes.length > 6)
    sink.add({
      code: CODES.headingLevelsCollapsed,
      quality: "approximate",
      message: `${candidateSizes.length} distinct heading sizes; the smallest were collapsed to level 6`,
    });

  const hyphenated = realHyphenations(lines);
  // `bodySize` is bucketed to a quarter point and a line's size is a mode of
  // 2-dp run sizes, so `line.size === bodySize` is almost never true on a real
  // document — a 10.91pt body never equals its own 11.0 bucket. Comparing with
  // the bucket width instead is what keeps the two statistics below from being
  // computed over an empty set, which is silent and makes every paragraph split
  // after one line.
  const isBody = (line: Line): boolean => Math.abs(line.size - bodySize) <= 0.25;
  // Measured only between consecutive *body-size* lines. A heading-to-body gap is
  // not line spacing, and on any document with more headings than paragraphs it
  // outnumbers the real leading and elects itself — after which no paragraph ever
  // breaks, because every real gap is smaller than the "modal" one.
  const spacings: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const line = lines[index];
    if (line.page !== previous.page) continue;
    if (!isBody(line) || !isBody(previous)) continue;
    const delta = line.y - previous.y;
    if (delta > 0) spacings.push(Math.round(delta * 2) / 2);
  }
  const modalSpacing = mode(spacings, "smallest") || bodySize * 1.2;

  // The body's left margin, taken over body-size lines. A first-line indent is
  // measured *against this*, not against the previous line: in a typeset
  // document the first line of a paragraph is the indented one, so comparing
  // neighbours makes every continuation line — which sits back at the margin —
  // look like a fresh paragraph, and every paragraph splits after one line.
  const modalLeft = mode(
    lines.filter(isBody).map((line) => Math.round(line.x)),
    "smallest",
  );

  const blocks: Block[] = [];
  let rejoined = 0;
  let paragraph: Line[] = [];
  let listItems: { lines: Line[]; ordered: boolean }[] = [];
  let listOrdered = false;

  const provenance = (quality: Block["provenance"]["quality"], pageNumbers: number[]) => ({
    path: "geometric" as const,
    quality,
    pages: [...new Set(pageNumbers)].sort((a, b) => a - b),
  });

  const spansFrom = (group: Line[]): InlineSpan[] => {
    let text = "";
    for (const line of group) {
      if (!text) {
        text = line.text;
        continue;
      }
      const match = /(\w+)-$/.exec(text);
      if (match && /^[a-z]/.test(line.text) && !hyphenated.has(`${match[1].toLowerCase()}-`)) {
        text = `${text.slice(0, -1)}${line.text}`;
        rejoined += 1;
      } else text += ` ${line.text}`;
    }
    const bold = group.every((line) => line.bold);
    return text ? [{ text, bold, italic: false, code: false }] : [];
  };

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const spans = spansFrom(paragraph);
    if (spans.length)
      blocks.push({
        kind: "paragraph",
        spans,
        children: [],
        provenance: provenance(
          "approximate",
          paragraph.map((line) => line.page),
        ),
      });
    paragraph = [];
  };

  const flushList = (): void => {
    if (listItems.length === 0) return;
    blocks.push({
      kind: "list",
      ordered: listOrdered,
      spans: [],
      children: listItems.map((item) => ({
        kind: "listItem" as const,
        spans: spansFrom(item.lines),
        children: [],
        provenance: provenance(
          "approximate",
          item.lines.map((line) => line.page),
        ),
      })),
      provenance: provenance(
        "approximate",
        listItems.flatMap((item) => item.lines.map((l) => l.page)),
      ),
    });
    if (listOrdered)
      sink.add({
        code: CODES.listNumberingLost,
        quality: "exact",
        message: "An ordered list's original numbering is renumbered on output",
      });
    listItems = [];
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  // Tabular runs are detected, flattened, and reported — never reconstructed.
  // A geometric table gets merged cells, wrapped cell text, and rules drawn as
  // vector paths wrong, and produces a confidently wrong table the consumer
  // cannot tell from a right one. Real tables come from the structure tree.
  const tabular = new Set<number>();
  for (let index = 0; index + 2 < lines.length; index += 1) {
    const window = [lines[index], lines[index + 1], lines[index + 2]];
    if (!window.every((line) => line.gaps.length >= 2)) continue;
    const first = window[0].gaps;
    const consistent = window.every((line) =>
      line.gaps.every((gap) => first.some((reference) => Math.abs(gap - reference) <= 2)),
    );
    if (consistent) for (let offset = 0; offset < 3; offset += 1) tabular.add(index + offset);
  }
  if (tabular.size > 0)
    sink.add({
      code: CODES.tableFlattened,
      quality: "approximate",
      message: `Tabular content on ${tabular.size} line(s) was emitted as one paragraph per row`,
      remediation:
        "A geometric table cannot be reconstructed faithfully; only a tagged PDF's tables are.",
    });

  lines.forEach((line, index) => {
    const previous = index > 0 ? lines[index - 1] : null;
    const level = levelFor.get(line.size);
    const marker = markerOf(line);
    const isHeading =
      level !== undefined &&
      line.runs.length > 0 &&
      !marker &&
      line.text.length > 0 &&
      line.size > bodySize;

    if (isHeading) {
      flushAll();
      const pinned = options.headingLevels?.get(line.text);
      blocks.push({
        kind: "heading",
        level: Math.min(pinned ?? level, 6),
        // Not bold: the heading level already carries the emphasis, and wrapping
        // the text in `**` as well renders `# **Title**`.
        spans: [{ text: line.text, bold: false, italic: false, code: false }],
        children: [],
        provenance: provenance(pinned ? "exact" : "approximate", [line.page]),
      });
      return;
    }

    if (marker) {
      flushParagraph();
      if (listItems.length === 0) listOrdered = marker.ordered;
      listItems.push({ lines: [{ ...line, text: marker.rest }], ordered: marker.ordered });
      return;
    }

    if (listItems.length > 0) {
      const last = listItems[listItems.length - 1];
      const itemX = last.lines[0].runs[1]?.x ?? last.lines[0].x;
      if (previous && line.page === previous.page && Math.abs(line.x - itemX) <= 1.5) {
        last.lines.push(line);
        return;
      }
      flushList();
    }

    if (previous) {
      const delta = line.page === previous.page ? line.y - previous.y : 0;
      // Indented *past* the margin, which is what a paragraph's first line does.
      // A line returning to the margin is a continuation and must not break.
      const indented = paragraph.length > 0 && line.x > modalLeft + Math.max(2, bodySize * 0.4);
      // A tolerance, not equality: a line carrying an inline code span or a
      // symbol run has a slightly different modal size and is not a new block.
      const fontChanged = Math.abs(line.size - previous.size) > 0.5;
      const shortAndFinal =
        /[.!?]["')\]]?$/.test(previous.text) && previous.text.length < line.text.length * 0.85;
      // All four are needed: leading alone misses indent-led paragraphs, indent
      // alone splits hanging indents, and terminal punctuation alone splits at
      // every abbreviation.
      if (delta > modalSpacing * 1.35 || indented || fontChanged || (delta > 0 && shortAndFinal))
        flushParagraph();
      else if (line.page !== previous.page && paragraph.length > 0) {
        const ends = /[.!?]["')\]]?$/.test(previous.text);
        if (ends) flushParagraph();
        else
          sink.add({
            code: CODES.paragraphSpansPages,
            quality: "exact",
            message: `A paragraph continuing across the page ${previous.page} boundary was rejoined`,
            page: line.page,
          });
      }
    }
    paragraph.push(line);
  });

  flushAll();

  if (rejoined > 0)
    sink.add({
      code: CODES.hyphenationRejoined,
      quality: "exact",
      message: `Rejoined ${rejoined} word(s) split by a line-end hyphen`,
    });

  return blocks;
}
