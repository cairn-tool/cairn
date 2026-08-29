import {
  extractCodeBlocks,
  isLineInCodeBlock,
  parseMarkdown,
  type MdCodeBlock,
  type MdHeading,
} from "./markdown-ast.js";

export const TOC_START = "<!-- cairn:toc:start -->";
export const TOC_END = "<!-- cairn:toc:end -->";

/**
 * The pre-rename markers, still recognized so documents already carrying them
 * keep synchronizing.
 *
 * A found pair keeps its own spelling: `synchronizeToc` only ever rewrites the
 * interior between the markers, never the markers themselves. Migrating them on
 * `--write` would report every legacy document as stale for a change that alters
 * no table of contents, so the two spellings are equal forever and only an
 * inserted pair uses the current one.
 */
export const LEGACY_TOC_START = "<!-- claude-cli:toc:start -->";
export const LEGACY_TOC_END = "<!-- claude-cli:toc:end -->";

export function renderToc(headings: MdHeading[], ordered = false): string {
  if (!headings.length) return "";
  const baseDepth = Math.min(...headings.map((heading) => heading.depth));
  return headings
    .map(
      (heading) =>
        `${"  ".repeat(heading.depth - baseDepth)}${ordered ? "1." : "-"} [${heading.text}](#${heading.slug})`,
    )
    .join("\n");
}

/**
 * Offsets of the bytes strictly between the markers.
 *
 * Reported so a caller can express the update as a scoped edit rather than a
 * whole-file replacement; `synchronizeToc` computes it either way.
 */
export interface TocRange {
  start: number;
  end: number;
}

export type TocSynchronization =
  | { status: "missing" }
  | { status: "malformed"; message: string }
  | { status: "current"; content: string; block: string; range: TocRange }
  | {
      status: "stale";
      content: string;
      replacement: string;
      block: string;
      range: TocRange;
      /** The rendered interior that belongs between the markers. */
      interior: string;
    };

/** 1-based line containing `offset`. */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index++) {
    if (content[index] === "\n") line++;
  }
  return line;
}

/**
 * Locates the marker block, ignoring markers inside fenced code.
 *
 * Markers are found by scanning raw text, so a fenced block *documenting* the
 * syntax — as this project's own README and `md toc` page both do — would
 * otherwise look like a real pair, and writing a table of contents into a code
 * sample would corrupt it.
 *
 * `codeBlocks` is optional only so a caller that already parsed the document
 * can avoid a second parse. Omitting it parses rather than skipping the check,
 * so a caller cannot silently opt out.
 */
export function synchronizeToc(
  content: string,
  toc: string,
  codeBlocks?: readonly MdCodeBlock[],
): TocSynchronization {
  const fenced = codeBlocks ?? extractCodeBlocks(parseMarkdown(content));
  const outsideFence = (match: RegExpExecArray | RegExpMatchArray): boolean =>
    !isLineInCodeBlock(lineOf(content, match.index!), [...fenced]);

  const matches = (marker: string): RegExpExecArray[] =>
    [...content.matchAll(new RegExp(marker, "g"))].filter(outsideFence) as RegExpExecArray[];

  const starts = [...matches(TOC_START), ...matches(LEGACY_TOC_START)];
  const ends = [...matches(TOC_END), ...matches(LEGACY_TOC_END)];
  if (!starts.length && !ends.length) return { status: "missing" };
  if (starts.length !== 1 || ends.length !== 1)
    return { status: "malformed", message: "Expected exactly one TOC marker pair" };

  // Both spellings are read, but a pair may not mix them: the two halves of one
  // block always came from the same writer, so a mixed pair is a hand edit that
  // silently lost half a rename rather than something to guess at.
  const legacy = starts[0][0] === LEGACY_TOC_START;
  if (legacy !== (ends[0][0] === LEGACY_TOC_END))
    return { status: "malformed", message: "TOC start and end markers use different spellings" };
  const startMarker = legacy ? LEGACY_TOC_START : TOC_START;
  const endMarker = legacy ? LEGACY_TOC_END : TOC_END;

  const startEnd = starts[0].index! + startMarker.length;
  const endStart = ends[0].index!;
  if (endStart < startEnd)
    return { status: "malformed", message: "TOC end marker appears before start marker" };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalizedToc = toc.replace(/\r?\n/g, eol);
  const interior = `${eol}${normalizedToc}${normalizedToc ? eol : ""}`;
  const block = `${startMarker}${interior}${endMarker}`;
  const range = { start: startEnd, end: endStart };
  if (content.slice(startEnd, endStart) === interior)
    return { status: "current", content, block, range };
  return {
    status: "stale",
    content,
    replacement: content.slice(0, startEnd) + interior + content.slice(endStart),
    block,
    range,
    interior,
  };
}
