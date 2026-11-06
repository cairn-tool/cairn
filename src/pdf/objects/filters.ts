import zlib from "node:zlib";
import { hexValue, isDict, isName, isWhitespace } from "./syntax.js";
import type { PdfDict, PdfObject } from "./syntax.js";

/**
 * Stream filters: the general-purpose ones, decoded here, and the image codecs,
 * which are recognised and handed back undecoded.
 *
 * Decoding stops at the first image codec because that is the point at which a
 * stream's bytes become an image file in their own right — a `DCTDecode` body is
 * a JPEG, and `pdf images` writes it out byte for byte rather than re-encoding it.
 */

export const IMAGE_CODECS = new Set(["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"]);

/** The abbreviations inline images may use, expanded to the full filter names. */
const ABBREVIATIONS: Record<string, string> = {
  AHx: "ASCIIHexDecode",
  A85: "ASCII85Decode",
  LZW: "LZWDecode",
  Fl: "FlateDecode",
  RL: "RunLengthDecode",
  CCF: "CCITTFaxDecode",
  DCT: "DCTDecode",
};

export class FilterError extends Error {
  constructor(
    message: string,
    readonly filter: string,
  ) {
    super(message);
    this.name = "FilterError";
  }
}

/** Raised when decoded output would exceed the budget: a decompression bomb, or a lie. */
export class DecodeBudgetExceeded extends Error {
  constructor(readonly limit: number) {
    super(`Decoded data would exceed ${limit} bytes`);
    this.name = "DecodeBudgetExceeded";
  }
}

export interface FilterStep {
  name: string;
  parms: PdfDict | null;
}

/** The filter chain a stream dictionary declares, abbreviations expanded. */
export function filterChain(
  dict: PdfDict,
  resolve: (value: PdfObject) => PdfObject = (value) => value,
): FilterStep[] {
  const filter = resolve(dict.map.get("Filter") ?? dict.map.get("F") ?? null);
  const parms = resolve(dict.map.get("DecodeParms") ?? dict.map.get("DP") ?? null);
  const names = Array.isArray(filter) ? filter.map(resolve) : filter === null ? [] : [filter];
  const parmList = Array.isArray(parms) ? parms.map(resolve) : [parms];
  const steps: FilterStep[] = [];
  names.forEach((entry, index) => {
    if (!isName(entry)) return;
    const value = parmList[index] ?? null;
    steps.push({
      name: ABBREVIATIONS[entry.name] ?? entry.name,
      parms: isDict(value) ? value : null,
    });
  });
  return steps;
}

export interface Decoded {
  data: Uint8Array;
  /** The image codec decoding stopped at, with its parameters; absent when fully decoded. */
  codec?: FilterStep;
  /** Filters after the codec, which a well-formed file never has. */
  trailing: FilterStep[];
}

/**
 * Applies a filter chain up to the first image codec.
 *
 * `limit` bounds every intermediate result, which is what makes a Flate bomb a
 * finding rather than an out-of-memory abort.
 */
export function decodeChain(raw: Uint8Array, steps: FilterStep[], limit: number): Decoded {
  let data = raw;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (IMAGE_CODECS.has(step.name)) return { data, codec: step, trailing: steps.slice(index + 1) };
    data = applyFilter(data, step, limit);
  }
  return { data, trailing: [] };
}

function num(dict: PdfDict | null, key: string, fallback: number): number {
  const value = dict?.map.get(key);
  return typeof value === "number" ? value : fallback;
}

export function applyFilter(data: Uint8Array, step: FilterStep, limit: number): Uint8Array {
  switch (step.name) {
    case "FlateDecode":
      return predict(inflate(data, limit), step.parms, limit);
    case "LZWDecode":
      return predict(lzw(data, num(step.parms, "EarlyChange", 1), limit), step.parms, limit);
    case "ASCIIHexDecode":
      return asciiHex(data);
    case "ASCII85Decode":
      return ascii85(data, limit);
    case "RunLengthDecode":
      return runLength(data, limit);
    case "Crypt":
      // An Identity crypt filter is a no-op; a named one is applied by the store.
      return data;
    default:
      throw new FilterError(`The ${step.name} filter is not supported`, step.name);
  }
}

/**
 * zlib with a bounded output and a tolerant tail.
 *
 * `Z_SYNC_FLUSH` keeps what decoded before a truncation instead of throwing it
 * away, which is how pdf.js and every viewer treat a stream cut short. A
 * missing zlib header is retried as raw deflate.
 */
function inflate(data: Uint8Array, limit: number): Uint8Array {
  const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: limit };
  try {
    return new Uint8Array(zlib.inflateSync(data, options));
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw new DecodeBudgetExceeded(limit);
    try {
      return new Uint8Array(zlib.inflateRawSync(data.subarray(2), options));
    } catch (inner) {
      if ((inner as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
        throw new DecodeBudgetExceeded(limit);
      throw new FilterError(`FlateDecode failed: ${(error as Error).message}`, "FlateDecode");
    }
  }
}

/** TIFF predictor 2 and the PNG predictors 10–15, per row. */
function predict(data: Uint8Array, parms: PdfDict | null, limit: number): Uint8Array {
  const predictor = num(parms, "Predictor", 1);
  if (predictor <= 1) return data;
  const colors = Math.max(1, num(parms, "Colors", 1));
  const bpc = num(parms, "BitsPerComponent", 8);
  const columns = Math.max(1, num(parms, "Columns", 1));
  const pixelBytes = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    const out = Uint8Array.from(data);
    if (bpc === 8) {
      for (let row = 0; row + rowBytes <= out.length; row += rowBytes)
        for (let index = row + pixelBytes; index < row + rowBytes; index += 1)
          out[index] = (out[index] + out[index - pixelBytes]) & 0xff;
    } else if (bpc === 16) {
      for (let row = 0; row + rowBytes <= out.length; row += rowBytes)
        for (let index = row + 2 * colors; index + 1 < row + rowBytes; index += 2) {
          const value =
            ((out[index] << 8) | out[index + 1]) +
            ((out[index - 2 * colors] << 8) | out[index - 2 * colors + 1]);
          out[index] = (value >> 8) & 0xff;
          out[index + 1] = value & 0xff;
        }
    } else {
      // Sub-byte samples: decode each component against its left neighbour.
      const mask = (1 << bpc) - 1;
      for (let row = 0; row + rowBytes <= out.length; row += rowBytes) {
        const previous = new Array<number>(colors).fill(0);
        let bit = 0;
        for (let sample = 0; sample < columns * colors; sample += 1) {
          const byteIndex = row + (bit >> 3);
          const shift = 8 - bpc - (bit & 7);
          const value = (out[byteIndex] >> shift) & mask;
          const component = sample % colors;
          const decoded = (value + previous[component]) & mask;
          previous[component] = decoded;
          out[byteIndex] = (out[byteIndex] & ~(mask << shift)) | (decoded << shift);
          bit += bpc;
        }
      }
    }
    return out;
  }

  const rows = Math.floor(data.length / (rowBytes + 1));
  if (rows * rowBytes > limit) throw new DecodeBudgetExceeded(limit);
  const out = new Uint8Array(rows * rowBytes);
  let previous = new Uint8Array(rowBytes);
  for (let row = 0; row < rows; row += 1) {
    const source = row * (rowBytes + 1);
    const type = data[source];
    const current = out.subarray(row * rowBytes, (row + 1) * rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const raw = data[source + 1 + index];
      const left = index >= pixelBytes ? current[index - pixelBytes] : 0;
      const up = previous[index];
      const upLeft = index >= pixelBytes ? previous[index - pixelBytes] : 0;
      let value: number;
      switch (type) {
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const pa = Math.abs(estimate - left);
          const pb = Math.abs(estimate - up);
          const pc = Math.abs(estimate - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          value = raw;
      }
      current[index] = value & 0xff;
    }
    previous = current;
  }
  return out;
}

function lzw(data: Uint8Array, earlyChange: number, limit: number): Uint8Array {
  const out: number[] = [];
  let dictionary: number[][] = [];
  const reset = (): void => {
    dictionary = [];
    for (let code = 0; code < 256; code += 1) dictionary.push([code]);
    dictionary.push([], []);
  };
  reset();
  let codeLength = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let previous: number[] | null = null;
  for (let index = 0; index < data.length; index += 1) {
    bitBuffer = ((bitBuffer << 8) | data[index]) >>> 0;
    bitCount += 8;
    while (bitCount >= codeLength) {
      const code = (bitBuffer >>> (bitCount - codeLength)) & ((1 << codeLength) - 1);
      bitCount -= codeLength;
      bitBuffer &= (1 << bitCount) - 1;
      if (code === 256) {
        reset();
        codeLength = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      if (code < dictionary.length && dictionary[code].length) entry = dictionary[code];
      else if (previous) entry = [...previous, previous[0]];
      else throw new FilterError("LZWDecode met an undefined code", "LZWDecode");
      for (const byte of entry) out.push(byte);
      if (out.length > limit) throw new DecodeBudgetExceeded(limit);
      if (previous) dictionary.push([...previous, entry[0]]);
      previous = entry;
      const size = dictionary.length + earlyChange;
      if (size >= 4096) codeLength = 12;
      else if (size >= 2048) codeLength = 12;
      else if (size >= 1024) codeLength = 11;
      else if (size >= 512) codeLength = 10;
    }
  }
  return Uint8Array.from(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let high = -1;
  for (const byte of data) {
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

function ascii85(data: Uint8Array, limit: number): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  let start = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) start = 2;
  for (let index = start; index < data.length; index += 1) {
    const byte = data[index];
    if (byte === 0x7e) break;
    if (isWhitespace(byte)) continue;
    if (byte === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    group.push(byte - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group.length = 0;
      if (out.length > limit) throw new DecodeBudgetExceeded(limit);
    }
  }
  if (group.length > 1) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    out.push(...bytes.slice(0, count));
  }
  return Uint8Array.from(out);
}

function runLength(data: Uint8Array, limit: number): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < data.length) {
    const length = data[index];
    index += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let count = 0; count <= length && index < data.length; count += 1)
        out.push(data[index++]);
    } else {
      const value = data[index++];
      for (let count = 0; count < 257 - length; count += 1) out.push(value);
    }
    if (out.length > limit) throw new DecodeBudgetExceeded(limit);
  }
  return Uint8Array.from(out);
}
