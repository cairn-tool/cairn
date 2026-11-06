/**
 * PDF object syntax: a lexer and an object parser over raw bytes.
 *
 * This is the object layer `pdf images` needs and the pdf.js public API cannot
 * supply: pdf.js hands images over already decoded to RGBA, so neither the
 * original JPEG bytes, the filter chain, the colour space, nor the object number
 * an image came from is reachable through it. Everything here reads; nothing
 * writes a PDF.
 *
 * The parser is lenient in the ways real files require — a missing `endobj`, a
 * wrong stream `/Length`, junk between objects — and strict about bounds: every
 * loop advances, nesting is capped, and a malformed token ends the object rather
 * than the process.
 */

export interface PdfName {
  kind: "name";
  name: string;
}

export interface PdfString {
  kind: "string";
  bytes: Uint8Array;
}

export interface PdfRef {
  kind: "ref";
  num: number;
  gen: number;
}

export interface PdfDict {
  kind: "dict";
  map: Map<string, PdfObject>;
}

export interface PdfStream {
  kind: "stream";
  dict: PdfDict;
  /** The stream's bytes exactly as stored: still encoded, and still encrypted. */
  raw: Uint8Array;
  /** The indirect object this stream is, when it is one. Inline images have none. */
  ref?: { num: number; gen: number };
}

/** A bare keyword. Only content streams and `R`/`obj` scaffolding produce these. */
export interface PdfOperator {
  kind: "op";
  op: string;
}

export type PdfObject =
  null | boolean | number | PdfName | PdfString | PdfRef | PdfObject[] | PdfDict | PdfStream;

/** Raised for syntax this parser cannot read. Callers turn it into an `AP` finding. */
export class PdfSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfSyntaxError";
  }
}

/** Arrays and dictionaries deeper than this are refused: the structure is attacker-chosen. */
const MAX_NESTING = 64;

const WHITESPACE = new Uint8Array(256);
for (const byte of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITESPACE[byte] = 1;
const DELIMITER = new Uint8Array(256);
for (const char of "()<>[]{}/%") DELIMITER[char.charCodeAt(0)] = 1;

export function isWhitespace(byte: number): boolean {
  return WHITESPACE[byte] === 1;
}

export function isDelimiter(byte: number): boolean {
  return DELIMITER[byte] === 1;
}

export function isRegular(byte: number): boolean {
  return WHITESPACE[byte] === 0 && DELIMITER[byte] === 0;
}

export const name = (value: string): PdfName => ({ kind: "name", name: value });

export function isName(value: unknown, expected?: string): value is PdfName {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PdfName).kind === "name" &&
    (expected === undefined || (value as PdfName).name === expected)
  );
}

export function isDict(value: unknown): value is PdfDict {
  return typeof value === "object" && value !== null && (value as PdfDict).kind === "dict";
}

export function isStream(value: unknown): value is PdfStream {
  return typeof value === "object" && value !== null && (value as PdfStream).kind === "stream";
}

export function isRef(value: unknown): value is PdfRef {
  return typeof value === "object" && value !== null && (value as PdfRef).kind === "ref";
}

export function isString(value: unknown): value is PdfString {
  return typeof value === "object" && value !== null && (value as PdfString).kind === "string";
}

/**
 * The operator a content-stream parse produced, or null for an operand.
 *
 * Operators travel through `parseObject` as a `PdfOperator` smuggled in the
 * `PdfObject` slot, because only content-stream mode produces them and widening
 * the union would make every object-layer caller handle a case it never sees.
 */
export function operatorOf(value: unknown): string | null {
  return typeof value === "object" && value !== null && (value as PdfOperator).kind === "op"
    ? (value as PdfOperator).op
    : null;
}

/** Reports a reference the way every other PDF tool prints one: `12 0 R`. */
export function refLabel(ref: { num: number; gen: number }): string {
  return `${ref.num} ${ref.gen} R`;
}

type Token =
  | { type: "number"; value: number; integer: boolean; start: number }
  | { type: "name"; value: string; start: number }
  | { type: "string"; value: Uint8Array; start: number }
  | { type: "keyword"; value: string; start: number }
  | { type: "punct"; value: "[" | "]" | "<<" | ">>" | "{" | "}"; start: number }
  | { type: "eof"; start: number };

/**
 * A byte-level tokenizer with a movable position.
 *
 * Positions are absolute offsets into the buffer it was given, which is what
 * lets the object store seek to a cross-reference offset and parse from there.
 */
export class Lexer {
  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
    readonly end = bytes.length,
  ) {}

  skipWhitespace(): void {
    const { bytes, end } = this;
    while (this.pos < end) {
      const byte = bytes[this.pos];
      if (byte === 0x25) {
        // A comment runs to the end of the line.
        while (this.pos < end && bytes[this.pos] !== 0x0a && bytes[this.pos] !== 0x0d)
          this.pos += 1;
      } else if (WHITESPACE[byte]) this.pos += 1;
      else break;
    }
  }

  peekByte(): number {
    return this.pos < this.end ? this.bytes[this.pos] : -1;
  }

  next(): Token {
    this.skipWhitespace();
    const { bytes, end } = this;
    const start = this.pos;
    if (start >= end) return { type: "eof", start };
    const byte = bytes[start];

    if (byte === 0x2f) return { type: "name", value: this.readName(), start };
    if (byte === 0x28) return { type: "string", value: this.readLiteral(), start };
    if (byte === 0x3c) {
      if (bytes[start + 1] === 0x3c) {
        this.pos += 2;
        return { type: "punct", value: "<<", start };
      }
      return { type: "string", value: this.readHex(), start };
    }
    if (byte === 0x3e) {
      if (bytes[start + 1] === 0x3e) {
        this.pos += 2;
        return { type: "punct", value: ">>", start };
      }
      // A lone `>` is junk; consume it so the caller's loop still advances.
      this.pos += 1;
      return { type: "keyword", value: ">", start };
    }
    if (byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d) {
      this.pos += 1;
      return { type: "punct", value: String.fromCharCode(byte) as "[" | "]" | "{" | "}", start };
    }
    if (byte === 0x29) {
      this.pos += 1;
      return { type: "keyword", value: ")", start };
    }

    // A regular-character run: a number or a keyword.
    let stop = start;
    while (stop < end && isRegular(bytes[stop])) stop += 1;
    this.pos = stop;
    const text = latin1(bytes, start, stop);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
      const value = Number(text);
      return {
        type: "number",
        value: Number.isFinite(value) ? value : 0,
        integer: /^[+-]?\d+$/.test(text),
        start,
      };
    }
    // Some producers write numbers like `--5` or `1.2.3`; read the leading number.
    const leading = /^[+-]*(\d+\.?\d*|\.\d+)/.exec(text);
    if (leading && /\d/.test(text[0] ?? "")) {
      return {
        type: "number",
        value: Number(leading[1]),
        integer: !leading[1].includes("."),
        start,
      };
    }
    return { type: "keyword", value: text, start };
  }

  private readName(): string {
    const { bytes, end } = this;
    this.pos += 1;
    const out: number[] = [];
    while (this.pos < end && isRegular(bytes[this.pos])) {
      const byte = bytes[this.pos];
      if (byte === 0x23 && this.pos + 2 < end) {
        const hex = latin1(bytes, this.pos + 1, this.pos + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      out.push(byte);
      this.pos += 1;
    }
    return Buffer.from(out).toString("latin1");
  }

  private readLiteral(): Uint8Array {
    const { bytes, end } = this;
    this.pos += 1;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < end) {
      const byte = bytes[this.pos];
      this.pos += 1;
      if (byte === 0x5c) {
        if (this.pos >= end) break;
        const escaped = bytes[this.pos];
        this.pos += 1;
        switch (escaped) {
          case 0x6e:
            out.push(0x0a);
            break;
          case 0x72:
            out.push(0x0d);
            break;
          case 0x74:
            out.push(0x09);
            break;
          case 0x62:
            out.push(0x08);
            break;
          case 0x66:
            out.push(0x0c);
            break;
          case 0x0d:
            // A line continuation; swallow an LF after the CR too.
            if (bytes[this.pos] === 0x0a) this.pos += 1;
            break;
          case 0x0a:
            break;
          default:
            if (escaped >= 0x30 && escaped <= 0x37) {
              let value = escaped - 0x30;
              for (let digits = 1; digits < 3; digits += 1) {
                const next = bytes[this.pos];
                if (next < 0x30 || next > 0x37) break;
                value = value * 8 + (next - 0x30);
                this.pos += 1;
              }
              out.push(value & 0xff);
            } else out.push(escaped);
        }
        continue;
      }
      if (byte === 0x28) depth += 1;
      else if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) break;
      }
      out.push(byte);
    }
    return Uint8Array.from(out);
  }

  private readHex(): Uint8Array {
    const { bytes, end } = this;
    this.pos += 1;
    const out: number[] = [];
    let high = -1;
    while (this.pos < end) {
      const byte = bytes[this.pos];
      this.pos += 1;
      if (byte === 0x3e) break;
      const digit = hexValue(byte);
      if (digit < 0) continue;
      if (high < 0) high = digit;
      else {
        out.push((high << 4) | digit);
        high = -1;
      }
    }
    if (high >= 0) out.push(high << 4);
    return Uint8Array.from(out);
  }
}

export function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

export function latin1(bytes: Uint8Array, start: number, stop: number): string {
  let out = "";
  for (let index = start; index < stop; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

/** Resolves a stream's `/Length` when it is an indirect reference. */
export type LengthResolver = (ref: PdfRef) => number | undefined;

/** Turns a string or stream body into plaintext; identity for an unencrypted file. */
export interface Decryptor {
  string(bytes: Uint8Array, num: number, gen: number): Uint8Array;
}

export interface ParseContext {
  resolveLength?: LengthResolver;
  /** The object being parsed, for decrypting its strings. */
  owner?: { num: number; gen: number };
  decryptor?: Decryptor;
  /** Content-stream mode: bare keywords become operators instead of ending the object. */
  operators?: boolean;
}

/**
 * Parses one PDF object starting at the lexer's position.
 *
 * Integer pairs followed by `R` are folded into a reference by looking ahead
 * with a saved position, which is cheaper and clearer than a token queue.
 */
export function parseObject(lexer: Lexer, context: ParseContext = {}, depth = 0): PdfObject {
  if (depth > MAX_NESTING) throw new PdfSyntaxError("Object nesting is deeper than allowed");
  const token = lexer.next();
  switch (token.type) {
    case "eof":
      throw new PdfSyntaxError("Unexpected end of data");
    case "number": {
      if (token.integer && token.value >= 0 && !context.operators) {
        const saved = lexer.pos;
        const second = lexer.next();
        if (second.type === "number" && second.integer && second.value >= 0) {
          const third = lexer.next();
          if (third.type === "keyword" && third.value === "R")
            return { kind: "ref", num: token.value, gen: second.value };
        }
        lexer.pos = saved;
      }
      return token.value;
    }
    case "name":
      return name(token.value);
    case "string": {
      const { decryptor, owner } = context;
      const bytes =
        decryptor && owner ? decryptor.string(token.value, owner.num, owner.gen) : token.value;
      return { kind: "string", bytes };
    }
    case "punct": {
      if (token.value === "[") {
        const items: PdfObject[] = [];
        for (;;) {
          lexer.skipWhitespace();
          const byte = lexer.peekByte();
          if (byte === -1) break;
          if (byte === 0x5d) {
            lexer.pos += 1;
            break;
          }
          const before = lexer.pos;
          const item = parseObjectOrKeyword(lexer, context, depth + 1);
          if (item === END) break;
          if (item !== SKIP) items.push(item);
          if (lexer.pos === before) lexer.pos += 1;
        }
        return items;
      }
      if (token.value === "<<") return parseDictBody(lexer, context, depth);
      // `{`/`}` only appear inside PostScript functions, which are parsed elsewhere.
      return null;
    }
    case "keyword":
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "null") return null;
      if (context.operators) return { kind: "op", op: token.value } as unknown as PdfObject;
      throw new PdfSyntaxError(`Unexpected keyword '${token.value.slice(0, 32)}'`);
  }
}

const END = Symbol("end");
const SKIP = Symbol("skip");

/**
 * Inside an array or dictionary an unexpected keyword is skipped rather than
 * fatal, except the ones that prove the container was never closed.
 */
function parseObjectOrKeyword(
  lexer: Lexer,
  context: ParseContext,
  depth: number,
): PdfObject | typeof END | typeof SKIP {
  const saved = lexer.pos;
  const token = lexer.next();
  if (token.type === "keyword" && !["true", "false", "null"].includes(token.value)) {
    if (["endobj", "stream", "obj", "endstream", "ID"].includes(token.value)) {
      lexer.pos = saved;
      return END;
    }
    return SKIP;
  }
  if (token.type === "punct" && (token.value === ">>" || token.value === "]")) {
    lexer.pos = saved;
    return END;
  }
  lexer.pos = saved;
  return parseObject(lexer, context, depth);
}

function parseDictBody(lexer: Lexer, context: ParseContext, depth: number): PdfDict {
  const map = new Map<string, PdfObject>();
  for (;;) {
    lexer.skipWhitespace();
    const byte = lexer.peekByte();
    if (byte === -1) break;
    if (byte === 0x3e && lexer.bytes[lexer.pos + 1] === 0x3e) {
      lexer.pos += 2;
      break;
    }
    const before = lexer.pos;
    const key = lexer.next();
    if (key.type !== "name") {
      if (key.type === "keyword" && ["endobj", "stream", "obj", "endstream"].includes(key.value)) {
        lexer.pos = before;
        break;
      }
      if (lexer.pos === before) lexer.pos += 1;
      continue;
    }
    lexer.skipWhitespace();
    if (lexer.peekByte() === 0x3e && lexer.bytes[lexer.pos + 1] === 0x3e) {
      map.set(key.value, null);
      continue;
    }
    const value = parseObjectOrKeyword(lexer, context, depth + 1);
    if (value === END) {
      map.set(key.value, null);
      continue;
    }
    if (value !== SKIP) map.set(key.value, value);
  }
  return { kind: "dict", map };
}

/** Finds `needle` at or after `from`; -1 when absent. */
export function indexOf(
  bytes: Uint8Array,
  needle: string,
  from: number,
  until = bytes.length,
): number {
  const first = needle.charCodeAt(0);
  const limit = Math.min(until, bytes.length) - needle.length;
  outer: for (let index = from; index <= limit; index += 1) {
    if (bytes[index] !== first) continue;
    for (let offset = 1; offset < needle.length; offset += 1)
      if (bytes[index + offset] !== needle.charCodeAt(offset)) continue outer;
    return index;
  }
  return -1;
}

/**
 * Parses `num gen obj … endobj` at `offset`, reading a stream body when one follows.
 *
 * The stream's `/Length` is trusted only when `endstream` is where it says;
 * otherwise the body runs to the next `endstream`, which is how every reader
 * survives a producer that wrote the length wrong.
 */
export function parseIndirect(
  bytes: Uint8Array,
  offset: number,
  context: ParseContext = {},
): { num: number; gen: number; value: PdfObject } {
  const lexer = new Lexer(bytes, offset);
  const num = lexer.next();
  const gen = lexer.next();
  const keyword = lexer.next();
  if (
    num.type !== "number" ||
    gen.type !== "number" ||
    keyword.type !== "keyword" ||
    keyword.value !== "obj"
  )
    throw new PdfSyntaxError(`No object header at offset ${offset}`);
  const owner = { num: num.value, gen: gen.value };
  const value = parseObject(lexer, { ...context, owner });

  if (isDict(value)) {
    const saved = lexer.pos;
    const next = lexer.next();
    if (next.type === "keyword" && next.value === "stream") {
      let start = lexer.pos;
      if (bytes[start] === 0x0d) start += 1;
      if (bytes[start] === 0x0a) start += 1;
      let length: number | undefined;
      const declared = value.map.get("Length");
      if (typeof declared === "number") length = declared;
      else if (isRef(declared)) length = context.resolveLength?.(declared);

      let stop = -1;
      if (length !== undefined && length >= 0 && start + length <= bytes.length) {
        const probe = new Lexer(bytes, start + length);
        const after = probe.next();
        if (after.type === "keyword" && after.value.startsWith("endstream")) stop = start + length;
      }
      if (stop < 0) {
        const found = indexOf(bytes, "endstream", start);
        stop = found < 0 ? bytes.length : found;
        // Drop the end-of-line marker that precedes the keyword.
        if (stop > start && bytes[stop - 1] === 0x0a) stop -= 1;
        if (stop > start && bytes[stop - 1] === 0x0d) stop -= 1;
      }
      return {
        ...owner,
        value: { kind: "stream", dict: value, raw: bytes.subarray(start, stop), ref: owner },
      };
    }
    lexer.pos = saved;
  }
  return { ...owner, value };
}
