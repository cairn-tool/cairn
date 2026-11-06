import { filterChain } from "./filters.js";
import type { ObjectStore } from "./store.js";
import {
  Lexer,
  isDict,
  isName,
  isRef,
  isStream,
  isWhitespace,
  operatorOf,
  parseObject,
} from "./syntax.js";
import type { PdfDict, PdfObject, PdfStream } from "./syntax.js";

/**
 * Walks a page's content streams for the images it paints.
 *
 * Only the operators that place an image are interpreted: `q`, `Q`, and `cm`
 * for the current transformation matrix, `Do` for an image or form XObject, and
 * `BI … ID … EI` for an inline image. Form XObjects are entered, with their
 * `/Matrix` and `/Resources`, so an image nested in a form is reported at the
 * place it actually lands. Annotation appearances, Type 3 glyph procedures, and
 * tiling patterns are not entered: they are not the page's own content.
 */

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` applied after `ctm`: the result of `m cm` when `ctm` is current. */
export function multiply(m: Matrix, ctm: Matrix): Matrix {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface Placement {
  /** The image stream; for an inline image, one synthesized from `BI … ID`. */
  stream: PdfStream;
  inline: boolean;
  /** The XObject resource name, e.g. `Im1`. Absent for inline images. */
  resourceName?: string;
  /** The image space unit square, mapped into default user space. */
  ctm: Matrix;
  /** Resources in scope where the image was painted, for colour space names. */
  resources: PdfDict | null;
  /** Form XObject resource names entered to reach the image, outermost first. */
  forms: string[];
}

export class ContentBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentBudgetExceeded";
  }
}

const MAX_FORM_DEPTH = 12;
const MAX_OPERATORS = 5_000_000;
const MAX_STACK = 256;

interface WalkState {
  operators: number;
  placements: Placement[];
  maxPlacements: number;
  check: () => void;
}

/** The decoded, concatenated content of a page: `/Contents` may be one stream or an array. */
export function pageContent(store: ObjectStore, page: PdfDict): Uint8Array {
  const contents = store.lookup(page, "Contents");
  const streams = Array.isArray(contents)
    ? contents.map((item) => store.resolve(item))
    : [contents];
  const parts: Uint8Array[] = [];
  for (const stream of streams) {
    if (!isStream(stream)) continue;
    parts.push(store.streamData(stream));
    // Streams are concatenated as though one; a separator stops a token spanning two.
    parts.push(Uint8Array.of(0x0a));
  }
  return Buffer.concat(parts);
}

export function walkImages(
  store: ObjectStore,
  page: PdfDict,
  resources: PdfDict | null,
  options: { maxPlacements: number; check: () => void },
): Placement[] {
  const state: WalkState = {
    operators: 0,
    placements: [],
    maxPlacements: options.maxPlacements,
    check: options.check,
  };
  walk(store, pageContent(store, page), resources, [...IDENTITY], [], new Set(), state);
  return state.placements;
}

function walk(
  store: ObjectStore,
  data: Uint8Array,
  resources: PdfDict | null,
  initial: Matrix,
  forms: string[],
  active: Set<number>,
  state: WalkState,
): void {
  const lexer = new Lexer(data);
  const operands: PdfObject[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = initial;

  while (lexer.pos < data.length) {
    lexer.skipWhitespace();
    if (lexer.pos >= data.length) break;
    const before = lexer.pos;
    let value: PdfObject;
    try {
      value = parseObject(lexer, { operators: true });
    } catch {
      lexer.pos = Math.max(before + 1, lexer.pos);
      operands.length = 0;
      continue;
    }
    if (lexer.pos === before) lexer.pos += 1;
    const op = operatorOf(value);
    if (op === null) {
      if (operands.length < 64) operands.push(value);
      continue;
    }
    state.operators += 1;
    if (state.operators > MAX_OPERATORS)
      throw new ContentBudgetExceeded(`More than ${MAX_OPERATORS} content operators`);
    if ((state.operators & 0xffff) === 0) state.check();

    switch (op) {
      case "q":
        if (stack.length < MAX_STACK) stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? ctm;
        break;
      case "cm":
        if (operands.length >= 6 && operands.slice(-6).every((item) => typeof item === "number"))
          ctm = multiply(operands.slice(-6) as Matrix, ctm);
        break;
      case "Do": {
        const target = operands[operands.length - 1];
        if (isName(target)) doXObject(store, target.name, resources, ctm, forms, active, state);
        break;
      }
      case "BI": {
        const inline = readInlineImage(store, lexer, resources);
        if (inline)
          push(state, { stream: inline, inline: true, ctm, resources, forms: [...forms] });
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

function push(state: WalkState, placement: Placement): void {
  if (state.placements.length >= state.maxPlacements)
    throw new ContentBudgetExceeded(`More than ${state.maxPlacements} images`);
  state.placements.push(placement);
}

function doXObject(
  store: ObjectStore,
  resourceName: string,
  resources: PdfDict | null,
  ctm: Matrix,
  forms: string[],
  active: Set<number>,
  state: WalkState,
): void {
  const xobjects = store.dictAt(resources, "XObject");
  const entry = xobjects?.map.get(resourceName);
  if (entry === undefined) return;
  const object = store.resolve(entry);
  if (!isStream(object)) return;
  const subtype = store.lookup(object.dict, "Subtype");
  if (isName(subtype, "Image")) {
    push(state, { stream: object, inline: false, resourceName, ctm, resources, forms: [...forms] });
    return;
  }
  if (!isName(subtype, "Form")) return;
  const num = isRef(entry) ? entry.num : -1;
  if (forms.length >= MAX_FORM_DEPTH || (num >= 0 && active.has(num))) return;
  const matrixValue = store.lookup(object.dict, "Matrix");
  const matrix =
    Array.isArray(matrixValue) &&
    matrixValue.length >= 6 &&
    matrixValue.every((item) => typeof item === "number")
      ? (matrixValue.slice(0, 6) as Matrix)
      : IDENTITY;
  const formResources = store.dictAt(object.dict, "Resources") ?? resources;
  if (num >= 0) active.add(num);
  try {
    walk(
      store,
      store.streamData(object),
      formResources,
      multiply(matrix, ctm),
      [...forms, resourceName],
      active,
      state,
    );
  } finally {
    if (num >= 0) active.delete(num);
  }
}

/** Abbreviated inline-image keys, expanded so the rest of the pipeline sees one vocabulary. */
const INLINE_KEYS: Record<string, string> = {
  BPC: "BitsPerComponent",
  CS: "ColorSpace",
  D: "Decode",
  DP: "DecodeParms",
  F: "Filter",
  H: "Height",
  W: "Width",
  IM: "ImageMask",
  I: "Interpolate",
  L: "Length",
};

/**
 * Reads `BI <dict> ID <data> EI` from just after `BI`.
 *
 * The data's length is known when the image is unfiltered; otherwise the end is
 * the first `EI` that stands alone as a token and is followed by something that
 * reads as content-stream text rather than more binary — the heuristic every
 * reader uses, because the format gives inline image data no length.
 */
function readInlineImage(
  store: ObjectStore,
  lexer: Lexer,
  resources: PdfDict | null,
): PdfStream | null {
  const map = new Map<string, PdfObject>();
  for (let guard = 0; guard < 256; guard += 1) {
    lexer.skipWhitespace();
    if (lexer.pos >= lexer.end) return null;
    const key = parseObject(lexer, { operators: true });
    const keyOperator = operatorOf(key);
    if (keyOperator !== null) {
      if (keyOperator === "ID") break;
      continue;
    }
    if (!isName(key)) continue;
    const value = parseObject(lexer, { operators: true });
    map.set(INLINE_KEYS[key.name] ?? key.name, value);
  }
  const { bytes } = lexer;
  let start = lexer.pos;
  // Exactly one whitespace byte separates ID from the data (CR LF tolerated).
  if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2;
  else if (isWhitespace(bytes[start])) start += 1;

  const dict: PdfDict = { kind: "dict", map };
  let stop = -1;
  const filters = filterChain(dict, (value) => store.resolve(value));
  const width = Number(map.get("Width")) || 0;
  const height = Number(map.get("Height")) || 0;
  const bpc = map.get("ImageMask") === true ? 1 : Number(map.get("BitsPerComponent")) || 8;
  if (!filters.length && width > 0 && height > 0) {
    let components = 1;
    const cs = map.get("ColorSpace");
    if (map.get("ImageMask") !== true) components = inlineComponents(store, cs ?? null, resources);
    const length = height * Math.ceil((width * components * bpc) / 8);
    const probe = new Lexer(bytes, start + length);
    const token = probe.next();
    if (token.type === "keyword" && token.value === "EI") {
      stop = start + length;
      lexer.pos = probe.pos;
    }
  }
  if (stop < 0) {
    for (let at = start; at + 1 < bytes.length; at += 1) {
      if (bytes[at] !== 0x45 || bytes[at + 1] !== 0x49) continue;
      if (at > start && !isWhitespace(bytes[at - 1])) continue;
      const after = bytes[at + 2];
      if (after !== undefined && !isWhitespace(after)) continue;
      if (!looksLikeText(bytes, at + 2)) continue;
      stop = at > start && isWhitespace(bytes[at - 1]) ? at - 1 : at;
      lexer.pos = at + 2;
      break;
    }
  }
  if (stop < 0) {
    lexer.pos = bytes.length;
    return null;
  }
  return { kind: "stream", dict, raw: bytes.subarray(start, stop) };
}

function inlineComponents(store: ObjectStore, value: PdfObject, resources: PdfDict | null): number {
  const resolved = store.resolve(value);
  if (isName(resolved)) {
    if (["G", "DeviceGray", "CalGray", "I", "Indexed"].includes(resolved.name)) return 1;
    if (["RGB", "DeviceRGB", "CalRGB", "Lab"].includes(resolved.name)) return 3;
    if (["CMYK", "DeviceCMYK"].includes(resolved.name)) return 4;
    const named = store.dictAt(resources, "ColorSpace")?.map.get(resolved.name);
    if (named !== undefined) return inlineComponents(store, named, resources);
    return 1;
  }
  if (Array.isArray(resolved)) {
    const family = store.resolve(resolved[0]);
    if (isName(family, "Indexed") || isName(family, "I") || isName(family, "Separation")) return 1;
    if (isName(family, "ICCBased")) {
      const stream = store.resolve(resolved[1]);
      const dict = isStream(stream) ? stream.dict : isDict(stream) ? stream : null;
      return Number(store.lookup(dict, "N")) || 1;
    }
    if (isName(family, "DeviceN")) {
      const names = store.resolve(resolved[1]);
      return Array.isArray(names) ? names.length : 1;
    }
    return inlineComponents(store, family, resources);
  }
  return 1;
}

/** The next few bytes after a candidate `EI` read as operators rather than binary. */
function looksLikeText(bytes: Uint8Array, from: number): boolean {
  const stop = Math.min(bytes.length, from + 16);
  for (let at = from; at < stop; at += 1) {
    const byte = bytes[at];
    if (byte >= 0x80 || (byte < 0x20 && !isWhitespace(byte))) return false;
  }
  return true;
}
