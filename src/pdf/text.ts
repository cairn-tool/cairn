import type { OpenDocument, PdfPageHandle, PdfTextItem, PdfTextStyle } from "./document.js";

/** Two decimal places, applied wherever a float reaches a payload or a compare. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One positioned run of text, in page-upright coordinates.
 *
 * `x`/`y` are the baseline origin with y increasing **downwards** from the top
 * left, which is what lets every comparison downstream read as "smaller y is
 * higher on the page".
 */
export interface PositionedRun {
  page: number;
  /** Order within the page as pdf.js emitted it: the final sort tie-break. */
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Effective font size in user units. */
  size: number;
  /**
   * Document-stable font identity.
   *
   * `TextItem.fontName` is a *per-page* internal id (`g_d10_f1`) and the same id
   * means different fonts on different pages, so keying anything document-wide
   * on it is silently wrong past page one. That failure presents as "headings
   * detected inconsistently", which is very hard to attribute, so the raw id
   * never leaves this module.
   */
  fontKey: string;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  vertical: boolean;
  /** Right angles only; null means an arbitrary rotation, excluded from layout. */
  angle: 0 | 90 | 180 | 270 | null;
  hasEOL: boolean;
  /** Marked-content id, when the caller asked for marked content. */
  mcid: string | null;
}

export interface PageRuns {
  page: number;
  runs: PositionedRun[];
  width: number;
  height: number;
  rotation: number;
  /** Non-whitespace code points across the whole page, including dropped runs. */
  characters: number;
}

const BOLD = /bold|black|heavy|semibold|demi/i;
const ITALIC = /italic|oblique/i;

function nonWhitespace(text: string): number {
  let count = 0;
  for (const char of text) if (!/\s/.test(char)) count += 1;
  return count;
}

/**
 * Snaps a rotation to a right angle, or reports that it is not one.
 *
 * Text at an arbitrary angle cannot participate in line grouping — every
 * geometric assumption downstream is axis-aligned — so it is excluded and
 * reported rather than being folded in at the wrong position.
 */
function angleOf(transform: number[]): 0 | 90 | 180 | 270 | null {
  const degrees = (Math.atan2(transform[1] ?? 0, transform[0] ?? 1) * 180) / Math.PI;
  const normalized = ((degrees % 360) + 360) % 360;
  for (const candidate of [0, 90, 180, 270] as const) {
    const delta = Math.abs(normalized - candidate);
    if (delta <= 1 || delta >= 359) return candidate;
  }
  return normalized > 359 || normalized < 1 ? 0 : null;
}

function isTextItem(item: PdfTextItem): boolean {
  return typeof item.str === "string" && item.type === undefined;
}

/**
 * Extracts one page's runs.
 *
 * Position comes from `viewport.convertToViewportPoint`, never from a
 * hand-rolled matrix: `transform[4]`/`[5]` are PDF user space — y-up, origin
 * bottom-left, `/Rotate` not applied — and the viewport applies the rotation and
 * the flip in one call that cannot drift from pdf.js's own convention.
 */
export async function extractPage(
  handle: OpenDocument,
  page: number,
  options: { markedContent?: boolean } = {},
): Promise<PageRuns> {
  const proxy: PdfPageHandle = await handle.within(() => handle.doc.getPage(page));
  try {
    const viewport = proxy.getViewport({ scale: 1 });
    const content = await handle.within(() =>
      proxy.getTextContent({ includeMarkedContent: Boolean(options.markedContent) }),
    );

    const runs: PositionedRun[] = [];
    let characters = 0;
    // Only `beginMarkedContentProps` carries an id, so the stack records the
    // innermost id-bearing frame and text inherits it.
    const stack: (string | null)[] = [];
    let index = 0;

    for (const item of content.items) {
      if (item.type !== undefined) {
        if (item.type.startsWith("begin")) stack.push(item.id ?? null);
        else if (item.type.startsWith("end")) stack.pop();
        continue;
      }
      if (!isTextItem(item)) continue;

      const text = item.str ?? "";
      characters += nonWhitespace(text);
      if (text.trim() === "") continue;

      const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
      const [x, y] = viewport.convertToViewportPoint(transform[4] ?? 0, transform[5] ?? 0);
      const style: PdfTextStyle = content.styles[item.fontName ?? ""] ?? {};
      const family = style.fontFamily ?? "";
      const matrixSize = Math.hypot(transform[1] ?? 0, transform[3] ?? 1);
      const size = round2(item.height && item.height > 0 ? item.height : matrixSize);

      let mcid: string | null = null;
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth]) {
          mcid = stack[depth];
          break;
        }
      }

      runs.push({
        page,
        index,
        text,
        x: round2(x),
        y: round2(y),
        width: round2(item.width ?? 0),
        height: round2(item.height ?? 0),
        size,
        fontKey: `${family}@${size}`,
        fontFamily: family,
        // The only weight signal `getTextContent` offers. It works for embedded
        // fonts with descriptive names and never for the standard 14, which
        // pdf.js reports as a generic CSS family ("sans-serif") regardless of
        // weight — so size stays the primary heading signal and this is a hint.
        bold: BOLD.test(family),
        italic: ITALIC.test(family),
        vertical: Boolean(style.vertical),
        angle: angleOf(transform),
        hasEOL: Boolean(item.hasEOL),
        mcid,
      });
      index += 1;
    }

    return {
      page,
      runs,
      width: round2(viewport.width),
      height: round2(viewport.height),
      rotation: viewport.rotation,
      characters,
    };
  } finally {
    // The per-page font and glyph caches. Without this a 900-page document
    // exhausts memory on a machine that has plenty.
    proxy.cleanup();
  }
}

/**
 * Renders one page's runs as plain text.
 *
 * Line grouping only — no paragraph, heading, or list inference, which is
 * `to-markdown`'s job. Runs are ordered top to bottom then left to right, and a
 * new line starts when the baseline moves by more than a third of the run
 * height, which is the same tolerance `layout.ts` uses so the two agree about
 * what a line is.
 */
export function runsToText(runs: PositionedRun[]): string {
  if (runs.length === 0) return "";
  const ordered = [...runs].sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
  const lines: string[] = [];
  let current: PositionedRun[] = [ordered[0]];

  for (const run of ordered.slice(1)) {
    const previous = current[current.length - 1];
    const tolerance = Math.max(previous.size, run.size) * 0.35;
    if (Math.abs(run.y - previous.y) <= tolerance) current.push(run);
    else {
      lines.push(joinLine(current));
      current = [run];
    }
  }
  lines.push(joinLine(current));
  return lines.join("\n");
}

/**
 * Joins one line's runs, reconstructing word spacing from glyph advances.
 *
 * A PDF carries no spaces between separately positioned runs; the gap between
 * where one run ends and the next begins is the only evidence, measured in
 * multiples of the font size so it holds at any scale.
 */
function joinLine(runs: PositionedRun[]): string {
  const ordered = [...runs].sort((a, b) => a.x - b.x || a.index - b.index);
  let text = ordered[0].text;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const run = ordered[index];
    const gap = run.x - (previous.x + previous.width);
    const needsSpace = gap > previous.size * 0.25 && !/\s$/.test(text) && !/^\s/.test(run.text);
    text += needsSpace ? ` ${run.text}` : run.text;
  }
  return text.trimEnd();
}
