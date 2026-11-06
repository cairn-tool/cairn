import zlib from "node:zlib";

/**
 * A PNG encoder: one place every PNG this toolset writes is made.
 *
 * Written here rather than taken from the canvas so that the bytes depend on
 * the pixels and nothing else. A canvas's own PNG export can embed encoder
 * choices that change between releases; this writes the four chunks a PNG
 * needs (`IHDR`, optional `PLTE`, `IDAT`, `IEND`), no timestamps, no gamma, no
 * text, with a fixed per-row filter heuristic and a fixed zlib level. The same
 * pixels give the same file.
 *
 * zlib itself is Node's. Its output is stable for a given zlib build, which is
 * why determinism is claimed for a given cairn install rather than across every
 * Node release — see `docs/commands/pdf/render.md`.
 */

export type PngColor = "gray" | "gray-alpha" | "rgb" | "rgba" | "palette";

const COLOR_TYPE: Record<PngColor, number> = {
  gray: 0,
  rgb: 2,
  palette: 3,
  "gray-alpha": 4,
  rgba: 6,
};

const CHANNELS: Record<PngColor, number> = {
  gray: 1,
  rgb: 3,
  palette: 1,
  "gray-alpha": 2,
  rgba: 4,
};

export interface PngImage {
  width: number;
  height: number;
  color: PngColor;
  /** 1, 2, 4, or 8 for gray and palette; 8 otherwise. */
  bitDepth: number;
  /** Rows packed MSB-first, each `ceil(width * channels * bitDepth / 8)` bytes, no filter byte. */
  data: Uint8Array;
  /** RGB triples, for `palette`. */
  palette?: Uint8Array;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([header.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([header, body, crc]);
}

export function rowBytes(image: Pick<PngImage, "width" | "color" | "bitDepth">): number {
  return Math.ceil((image.width * CHANNELS[image.color] * image.bitDepth) / 8);
}

/**
 * Chooses each row's filter by the minimum sum of absolute differences — the
 * heuristic libpng recommends — except for sub-byte and palette images, where
 * filtering does not help and None is used.
 */
function filtered(image: PngImage): Uint8Array {
  const stride = rowBytes(image);
  const bpp = Math.max(1, Math.ceil((CHANNELS[image.color] * image.bitDepth) / 8));
  const out = new Uint8Array(image.height * (stride + 1));
  const adaptive = image.bitDepth === 8 && image.color !== "palette";
  const zero = new Uint8Array(stride);
  // One buffer per filter type, each filled by its own tight loop: a switch per
  // byte made this the dominant cost of writing a large scan.
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let row = 0; row < image.height; row += 1) {
    const current = image.data.subarray(row * stride, (row + 1) * stride);
    const target = row * (stride + 1);
    if (!adaptive) {
      out[target] = 0;
      out.set(current, target + 1);
      continue;
    }
    const previous = row > 0 ? image.data.subarray((row - 1) * stride, row * stride) : zero;
    const [none, sub, up, average, paeth] = candidates;
    none.set(current);
    // Costs are accumulated in the same pass: the sum of each byte read as signed.
    const scores = [0, 0, 0, 0, 0];
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bpp ? current[index - bpp] : 0;
      const above = previous[index];
      const upLeft = index >= bpp ? previous[index - bpp] : 0;
      const raw = current[index];
      const v1 = (raw - left) & 0xff;
      const v2 = (raw - above) & 0xff;
      const v3 = (raw - ((left + above) >> 1)) & 0xff;
      const estimate = left + above - upLeft;
      let pa = estimate - left;
      if (pa < 0) pa = -pa;
      let pb = estimate - above;
      if (pb < 0) pb = -pb;
      let pc = estimate - upLeft;
      if (pc < 0) pc = -pc;
      const v4 = (raw - (pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft)) & 0xff;
      sub[index] = v1;
      up[index] = v2;
      average[index] = v3;
      paeth[index] = v4;
      s0 += raw < 128 ? raw : 256 - raw;
      s1 += v1 < 128 ? v1 : 256 - v1;
      s2 += v2 < 128 ? v2 : 256 - v2;
      s3 += v3 < 128 ? v3 : 256 - v3;
      s4 += v4 < 128 ? v4 : 256 - v4;
    }
    scores[0] = s0;
    scores[1] = s1;
    scores[2] = s2;
    scores[3] = s3;
    scores[4] = s4;
    // Lowest sum wins; ties go to the lower type number.
    let bestType = 0;
    for (let type = 1; type < 5; type += 1) if (scores[type] < scores[bestType]) bestType = type;
    out[target] = bestType;
    out.set(candidates[bestType], target + 1);
  }
  return out;
}

export function encodePng(image: PngImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = image.bitDepth;
  header[9] = COLOR_TYPE[image.color];
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
  ];
  if (image.color === "palette" && image.palette) parts.push(chunk("PLTE", image.palette));
  parts.push(chunk("IDAT", zlib.deflateSync(filtered(image), { level: 6 })));
  parts.push(chunk("IEND", new Uint8Array(0)));
  return Buffer.concat(parts);
}
