import zlib from "node:zlib";

/**
 * A PNG reader for tests: enough to check pixels `pdf images` and `pdf render`
 * wrote. Handles the colour types and depths cairn's encoder emits — grey and
 * palette at 1, 2, 4, and 8 bits, and 8-bit grey-alpha, RGB, and RGBA — and
 * returns every image as RGBA so an assertion reads the same whatever was
 * written.
 */
export interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  /** RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(file: Buffer): DecodedPng {
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const type = raw[row * (stride + 1)];
    for (let index = 0; index < stride; index += 1) {
      const value = raw[row * (stride + 1) + 1 + index];
      const left = index >= bpp ? rows[row * stride + index - bpp] : 0;
      const up = row > 0 ? rows[(row - 1) * stride + index] : 0;
      const upLeft = row > 0 && index >= bpp ? rows[(row - 1) * stride + index - bpp] : 0;
      let out = value;
      if (type === 1) out = value + left;
      else if (type === 2) out = value + up;
      else if (type === 3) out = value + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      rows[row * stride + index] = out & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row: number, index: number): number => {
    if (bitDepth === 8) return rows[row * stride + index];
    const bit = index * bitDepth;
    return (rows[row * stride + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
  };
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (colorType === 0) {
        const value = Math.round((sample(y, x) * 255) / ((1 << bitDepth) - 1));
        rgba.set([value, value, value, 255], at);
      } else if (colorType === 3) {
        const index = sample(y, x);
        rgba.set([palette![index * 3], palette![index * 3 + 1], palette![index * 3 + 2], 255], at);
      } else if (colorType === 4) {
        const value = sample(y, x * 2);
        rgba.set([value, value, value, sample(y, x * 2 + 1)], at);
      } else if (colorType === 2) {
        rgba.set([sample(y, x * 3), sample(y, x * 3 + 1), sample(y, x * 3 + 2), 255], at);
      } else {
        rgba.set(
          [sample(y, x * 4), sample(y, x * 4 + 1), sample(y, x * 4 + 2), sample(y, x * 4 + 3)],
          at,
        );
      }
    }
  return { width, height, colorType, bitDepth, rgba };
}

/** The RGBA of one pixel. */
export function pixel(png: DecodedPng, x: number, y: number): number[] {
  const at = (y * png.width + x) * 4;
  return Array.from(png.rgba.subarray(at, at + 4));
}
