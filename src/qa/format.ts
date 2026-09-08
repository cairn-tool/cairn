import { eastAsianWidthType } from "get-east-asian-width";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const REV = "\x1b[7m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";

/** Sticky so `exec` anchors at `lastIndex`, matching Python's `CSI.match(text, i)`. */
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;]*[A-Za-z]/y;

/** Python: unicodedata.category(ch) in ("Mn", "Me", "Cf") */
const ZERO_CATEGORY = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Python's whitespace set for `str` — what `str.strip()` and `re.sub(r"\s+")` act on.
 * Spelled out rather than reusing JS `\s`, which differs at both ends: it omits
 * \x1c-\x1f and \x85, and it *adds* \ufeff (the BOM), which Python treats as ordinary.
 */
const PY_WS =
  "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_SPACE = new RegExp(`[${PY_WS}]`, "u");
const PY_SPACE_RUN = new RegExp(`[${PY_WS}]+`, "gu");
const PY_BLANK = new RegExp(`^[${PY_WS}]*$`, "u");

const bmpCache = new Int8Array(0x10000).fill(-1);

function computeWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0;
  if (ZERO_CATEGORY.test(String.fromCodePoint(cp))) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  const eaw = eastAsianWidthType(cp);
  if (eaw === "fullwidth" || eaw === "wide") return 2;
  if (cp >= 0x1f300) return 2;
  return 1;
}

/** Terminal cell width of one code point: 0, 1, or 2. Python: char_width. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x10000) {
    const cached = bmpCache[cp]!;
    if (cached >= 0) return cached as 0 | 1 | 2;
    const width = computeWidth(cp);
    bmpCache[cp] = width;
    return width;
  }
  return computeWidth(cp);
}

export interface Token {
  readonly text: string;
  readonly w: number;
  readonly ansi: boolean;
}

/**
 * One pass over `text`, yielding either a whole CSI sequence (width 0) or a single CODE POINT.
 * Every width-aware function goes through here — Python iterates code points, and JS string
 * indexing iterates UTF-16 units, so a naive port splits every astral emoji in half.
 */
export function* tokens(text: string): Generator<Token> {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      CSI.lastIndex = i;
      const match = CSI.exec(text);
      if (match) {
        yield { text: match[0], w: 0, ansi: true };
        i = CSI.lastIndex;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const s = String.fromCodePoint(cp);
    yield { text: s, w: charWidth(cp), ansi: false };
    i += s.length;
  }
}

/** Visible cell width, ignoring CSI. Wide glyphs count as 2. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const token of tokens(text)) width += token.w;
  return width;
}

/** Keep at most `width` display cells, preserving CSI, and always reset. */
export function clipAnsi(text: string, width: number): string {
  if (width <= 0) return RESET;
  const out: string[] = [];
  let vis = 0;
  for (const token of tokens(text)) {
    if (vis >= width) break;
    if (token.ansi) {
      out.push(token.text);
      continue;
    }
    if (vis + token.w > width) break;
    out.push(token.text);
    vis += token.w;
  }
  return out.join("") + RESET;
}

/** Full-width reverse-video bar. Re-opens reverse after any RESET in `text`. */
export function invertBar(text: string, width: number): string {
  const clipped = clipAnsi(text, width);
  const pad = " ".repeat(Math.max(0, width - displayWidth(clipped)));
  const body = clipped.replaceAll(RESET, RESET + REV) + pad;
  return `${REV}${body}${RESET}`;
}

export function padClip(text: string, width: number): string {
  const clipped = clipAnsi(text, width);
  const pad = width - displayWidth(clipped);
  return pad > 0 ? clipped + " ".repeat(pad) : clipped;
}

/** Python: text.strip(" ") / text.rstrip(" ") — U+0020 ONLY, never .trim(). */
const stripSpaces = (s: string): string => s.replace(/^ +/, "").replace(/ +$/, "");
const rstripSpaces = (s: string): string => s.replace(/ +$/, "");

/** Wrap `text` to `width` display cells, breaking on spaces when possible. */
export function wrapAnsi(text: string, width: number): string[] {
  if (width < 1) return [];
  if (displayWidth(text) <= width) return text ? [text] : [];

  const toks = [...tokens(text)];
  const lines: string[] = [];
  let current: Token[] = [];
  let currentW = 0;
  let spaceAt = -1;

  const emit = (parts: readonly Token[]): void => {
    const line = parts.map((t) => t.text).join("");
    if (stripSpaces(line) || parts.some((t) => t.ansi)) lines.push(rstripSpaces(line));
  };

  for (const token of toks) {
    const { w } = token;
    if (w > 0 && currentW + w > width && current.length > 0) {
      if (spaceAt >= 0) {
        emit(current.slice(0, spaceAt + 1));
        const rest = current.slice(spaceAt + 1);
        current = rest.filter((t) => !(t.text === " " && t.w === 1));
        currentW = current.reduce((sum, t) => sum + t.w, 0);
        spaceAt = -1;
      } else {
        emit(current);
        current = [];
        currentW = 0;
        spaceAt = -1;
      }
      if (w > 0 && currentW + w > width) {
        emit([token]);
        continue;
      }
    }
    current.push(token);
    currentW += w;
    if (token.text === " " && w === 1) spaceAt = current.length - 1;
  }
  if (current.length > 0) emit(current);
  return lines.length > 0 ? lines : text ? [text] : [];
}

export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/**
 * Python f"{x:.1f}". Both `toFixed` and Python's formatter round the *exact* double, and they
 * only disagree on a true midpoint — which needs value = odd/20, never a dyadic rational, so it
 * cannot arise from the n/1000 and n/1000000 divisions here. Do NOT pre-scale by 10: that
 * collapses 1.05000000000000004 to exactly 10.5 and rounds the wrong way.
 */
const fixed1 = (value: number): string => value.toFixed(1);

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${fixed1(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fixed1(n / 1_000)}k`;
  return String(n);
}

export function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${fixed1(n / 1_000_000)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

export function flatten(text: string): string {
  return text.replace(PY_SPACE_RUN, " ").replace(/^ +| +$/g, "");
}

/** Python: `not line.strip()` */
export function isBlank(text: string): boolean {
  return PY_BLANK.test(text);
}

/** Python: text.strip() — the wide whitespace set. */
export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_SPACE.test(text[start]!)) start += 1;
  while (end > start && PY_SPACE.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}
