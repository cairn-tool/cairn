import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAtomically } from "../atomic-write.js";
import { decodeCcitt, decodeJbig2, decodeJpeg, decodeJpx } from "./codecs.js";
import { CODES, DiagnosticSink } from "./diagnostics.js";
import { ColorSpaceUnsupported, DEVICE_GRAY, resolveColorSpace } from "./objects/colorspace.js";
import type { ColorSpace } from "./objects/colorspace.js";
import { ContentBudgetExceeded, apply, walkImages } from "./objects/content.js";
import type { Matrix, Placement } from "./objects/content.js";
import { DecodeBudgetExceeded, FilterError, decodeChain, filterChain } from "./objects/filters.js";
import type { FilterStep } from "./objects/filters.js";
import { ObjectStore, UnsupportedEncryption, pageList } from "./objects/store.js";
import { isStream, refLabel } from "./objects/syntax.js";
import type { PdfDict, PdfObject, PdfStream } from "./objects/syntax.js";
import { encodePng } from "./png.js";
import type { PdfDiagnostic, PdfImage } from "./types.js";

/**
 * `pdf images`: every raster image a page paints, written out, with an index.
 *
 * Read through the object layer in `./objects/` rather than through pdf.js,
 * whose public API hands images over already decoded to RGBA — so the original
 * JPEG bytes, the filter chain, the colour space, and the object number would
 * all be unreachable. A `DCTDecode` image is written as the JPEG it already is;
 * everything else is decoded and written as PNG.
 */

/** Decoded bytes one image may occupy. A larger image is reported, not decoded. */
export const MAX_IMAGE_BYTES = 256 * 1024 * 1024;

/** Images one run will place, across every selected page. */
export const MAX_IMAGES = 50_000;

export interface ImagesOptions {
  /** 1-based pages to read. */
  pages: number[];
  /** The directory images and `images.json` are written into. */
  out: string;
  /** Images whose smaller pixel dimension is below this are indexed and not written. */
  minSize: number;
  /** Throws when the run's deadline has passed. */
  check: () => void;
}

export interface ImagesResult {
  images: PdfImage[];
  diagnostics: PdfDiagnostic[];
}

/** Rounds to 3 dp, and never emits `-0`, so coordinates are byte-stable. */
function r3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

/** The axis-aligned bounds of the unit square under `ctm`, in default user space. */
export function placementBox(ctm: Matrix): [number, number, number, number] {
  const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r3) as [
    number,
    number,
    number,
    number,
  ];
}

class ImageUndecodable extends Error {
  constructor(
    message: string,
    readonly construct?: string,
  ) {
    super(message);
    this.name = "ImageUndecodable";
  }
}

interface Written {
  file: string;
  format: "png" | "jpeg" | "jp2";
  bytes: number;
  sha256: string;
  mask?: { file: string };
}

interface ImageFacts {
  width: number;
  height: number;
  bpc: number;
  imageMask: boolean;
  space: ColorSpace | null;
  spaceError: string | null;
  filters: FilterStep[];
  decode: number[] | null;
}

function facts(store: ObjectStore, stream: PdfStream, resources: PdfDict | null): ImageFacts {
  const dict = stream.dict;
  const width = Math.trunc(Number(store.lookup(dict, "Width"))) || 0;
  const height = Math.trunc(Number(store.lookup(dict, "Height"))) || 0;
  const imageMask = store.lookup(dict, "ImageMask") === true;
  const filters = filterChain(dict, (value) => store.resolve(value));
  const declaredBpc = Number(store.lookup(dict, "BitsPerComponent"));
  const jpx = filters.some((step) => step.name === "JPXDecode");
  const bpc = imageMask ? 1 : declaredBpc || 8;
  let space: ColorSpace | null = null;
  let spaceError: string | null = null;
  if (!imageMask) {
    const value = dict.map.get("ColorSpace");
    if (value === undefined || value === null) {
      // A JPX image may carry its colour space in the codestream; anything
      // else without one is malformed, and DeviceGray is the reader's fallback.
      space = jpx ? null : DEVICE_GRAY;
      if (!jpx) spaceError = "The image declares no colour space; DeviceGray was assumed";
    } else {
      try {
        space = resolveColorSpace(store, value, resources);
      } catch (error) {
        if (!(error instanceof ColorSpaceUnsupported)) throw error;
        spaceError = error.message;
      }
    }
  }
  const decodeValue = store.lookup(dict, "Decode");
  const decode = Array.isArray(decodeValue)
    ? decodeValue.map((item) => (typeof item === "number" ? item : 0))
    : null;
  return { width, height, bpc, imageMask, space, spaceError, filters, decode };
}

/** Unpacks samples of any depth into integers, row by row. */
function samplesOf(
  data: Uint8Array,
  width: number,
  height: number,
  components: number,
  bpc: number,
): Uint16Array {
  const perRow = width * components;
  const stride = Math.ceil((perRow * bpc) / 8);
  const out = new Uint16Array(perRow * height);
  for (let row = 0; row < height; row += 1) {
    const base = row * stride;
    for (let sample = 0; sample < perRow; sample += 1) {
      let value: number;
      if (bpc === 8) value = data[base + sample] ?? 0;
      else if (bpc === 16)
        value = ((data[base + sample * 2] ?? 0) << 8) | (data[base + sample * 2 + 1] ?? 0);
      else {
        const bit = sample * bpc;
        const byte = data[base + (bit >> 3)] ?? 0;
        value = (byte >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
      }
      out[row * perRow + sample] = value;
    }
  }
  return out;
}

function expectedLength(width: number, height: number, components: number, bpc: number): number {
  return height * Math.ceil((width * components * bpc) / 8);
}

/** Nearest-neighbour resample of one channel to the base image's size. */
function resample(
  channel: Uint8Array,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): Uint8Array {
  if (fromW === toW && fromH === toH) return channel;
  const out = new Uint8Array(toW * toH);
  for (let y = 0; y < toH; y += 1) {
    const sy = Math.min(fromH - 1, Math.floor((y * fromH) / toH));
    for (let x = 0; x < toW; x += 1) {
      const sx = Math.min(fromW - 1, Math.floor((x * fromW) / toW));
      out[y * toW + x] = channel[sy * fromW + sx];
    }
  }
  return out;
}

interface Pixels {
  width: number;
  height: number;
  /** 1 (gray) or 3 (rgb) channels, 8-bit. */
  channels: 1 | 3;
  data: Uint8Array;
}

export class ImageExtractor {
  private readonly sink = new DiagnosticSink();
  private readonly byObject = new Map<string, Written>();

  constructor(
    private readonly store: ObjectStore,
    private readonly options: ImagesOptions,
  ) {}

  private note(input: Parameters<DiagnosticSink["add"]>[0]): void {
    this.sink.add(input);
  }

  /** The stream's data decoded up to its image codec. */
  private decoded(stream: PdfStream, facts: ImageFacts): { data: Uint8Array; codec?: FilterStep } {
    const raw = this.store.decrypted(stream);
    const result = decodeChain(raw, facts.filters, MAX_IMAGE_BYTES);
    if (result.trailing.length)
      throw new ImageUndecodable(
        `A filter follows the ${result.codec?.name} codec, which a well-formed image never has`,
        result.codec?.name,
      );
    return result;
  }

  /** 1-bit or n-bit samples for a non-DCT, non-JPX image: what every pixel path starts from. */
  private async rawSamples(
    stream: PdfStream,
    facts: ImageFacts,
    components: number,
  ): Promise<{ data: Uint8Array; codec?: string }> {
    const { data, codec } = this.decoded(stream, facts);
    if (!codec) return { data };
    const parms = codec.parms;
    const get = (key: string): PdfObject => this.store.lookup(parms, key);
    if (codec.name === "CCITTFaxDecode") {
      const samples = await decodeCcitt(data, facts.width, facts.height, {
        K: Number(get("K")) || 0,
        EndOfLine: get("EndOfLine") === true,
        EncodedByteAlign: get("EncodedByteAlign") === true,
        BlackIs1: get("BlackIs1") === true,
        Columns: Number(get("Columns")) || 1728,
        Rows: Number(get("Rows")) || facts.height,
      });
      return { data: samples, codec: codec.name };
    }
    if (codec.name === "JBIG2Decode") {
      const globalsValue = get("JBIG2Globals");
      const globals = isStream(globalsValue) ? this.store.streamData(globalsValue) : null;
      return {
        data: await decodeJbig2(data, facts.width, facts.height, globals),
        codec: codec.name,
      };
    }
    if (codec.name === "DCTDecode") {
      // Only reached for a mask or an image that must be composed: decode the JPEG.
      const jpeg = await decodeJpeg(data, facts.width, facts.height);
      if (jpeg.components !== components)
        throw new ImageUndecodable(
          `The JPEG holds ${jpeg.components} components where ${components} were declared`,
          "DCTDecode",
        );
      return { data: jpeg.data, codec: codec.name };
    }
    throw new ImageUndecodable(`The ${codec.name} codec is not supported here`, codec.name);
  }

  /** A soft mask, stencil mask, or colour-key mask, as one 8-bit alpha channel at the image's size. */
  private async alphaFor(
    stream: PdfStream,
    facts: ImageFacts,
    samples: Uint16Array | null,
  ): Promise<{ alpha: Uint8Array; kind: "smask" | "stencil" | "color-key"; ref?: string } | null> {
    const { store } = this;
    const smaskValue = stream.dict.map.get("SMask");
    const smask = store.resolve(smaskValue);
    if (isStream(smask)) {
      const maskFacts = maskFacts_(store, smask);
      const raw = await this.rawSamples(smask, maskFacts, 1);
      const values = samplesOf(raw.data, maskFacts.width, maskFacts.height, 1, maskFacts.bpc);
      const max = (1 << maskFacts.bpc) - 1;
      const [d0, d1] = maskFacts.decode ?? [0, 1];
      const channel = new Uint8Array(values.length);
      for (let index = 0; index < values.length; index += 1)
        channel[index] = Math.round(
          Math.max(0, Math.min(1, d0 + (values[index] / max) * (d1 - d0))) * 255,
        );
      return {
        alpha: resample(channel, maskFacts.width, maskFacts.height, facts.width, facts.height),
        kind: "smask",
        ...(smask.ref ? { ref: refLabel(smask.ref) } : {}),
      };
    }
    const maskValue = store.resolve(stream.dict.map.get("Mask"));
    if (isStream(maskValue)) {
      const maskFacts = { ...maskFacts_(store, maskValue), bpc: 1 };
      const raw = await this.rawSamples(maskValue, maskFacts, 1);
      const values = samplesOf(raw.data, maskFacts.width, maskFacts.height, 1, 1);
      const inverted = maskFacts.decode && maskFacts.decode[0] === 1;
      const channel = new Uint8Array(values.length);
      // A stencil mask: a sample of 1 (after Decode) masks the image out.
      for (let index = 0; index < values.length; index += 1)
        channel[index] = (values[index] === 1) !== Boolean(inverted) ? 0 : 255;
      return {
        alpha: resample(channel, maskFacts.width, maskFacts.height, facts.width, facts.height),
        kind: "stencil",
        ...(maskValue.ref ? { ref: refLabel(maskValue.ref) } : {}),
      };
    }
    if (Array.isArray(maskValue) && samples && facts.space) {
      const ranges = maskValue.map((item) => (typeof item === "number" ? item : 0));
      const n = facts.space.components;
      const pixels = facts.width * facts.height;
      const alpha = new Uint8Array(pixels).fill(255);
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        let inside = true;
        for (let component = 0; component < n && inside; component += 1) {
          const value = samples[pixel * n + component];
          inside =
            value >= (ranges[component * 2] ?? 0) && value <= (ranges[component * 2 + 1] ?? -1);
        }
        if (inside) alpha[pixel] = 0;
      }
      return { alpha, kind: "color-key" };
    }
    return null;
  }

  /** Converts samples through the colour space into 8-bit gray or RGB. */
  private toPixels(samples: Uint16Array, facts: ImageFacts, space: ColorSpace): Pixels {
    const n = space.components;
    const pixels = facts.width * facts.height;
    const channels = space.output === "rgb" ? 3 : 1;
    const out = new Uint8Array(pixels * channels);
    const max = (1 << facts.bpc) - 1;
    const decode =
      facts.decode && facts.decode.length >= n * 2
        ? facts.decode
        : space.indexed
          ? [0, max]
          : Array.from({ length: n * 2 }, (_, index) => (index % 2 === 0 ? 0 : 1));
    const scratch = new Array<number>(n).fill(0);
    const factor = decode.map((_, index) =>
      index % 2 === 0 ? 0 : (decode[index] - decode[index - 1]) / max,
    );
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      for (let component = 0; component < n; component += 1)
        scratch[component] =
          decode[component * 2] + samples[pixel * n + component] * factor[component * 2 + 1];
      space.convert(scratch, out, pixel * channels);
      if ((pixel & 0x3ffff) === 0) this.options.check();
    }
    return { width: facts.width, height: facts.height, channels: channels as 1 | 3, data: out };
  }

  private png(pixels: Pixels, alpha: Uint8Array | null): Buffer {
    const { width, height, channels } = pixels;
    if (!alpha)
      return encodePng({
        width,
        height,
        color: channels === 3 ? "rgb" : "gray",
        bitDepth: 8,
        data: pixels.data,
      });
    const out = new Uint8Array(width * height * (channels + 1));
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      for (let channel = 0; channel < channels; channel += 1)
        out[pixel * (channels + 1) + channel] = pixels.data[pixel * channels + channel];
      out[pixel * (channels + 1) + channels] = alpha[pixel];
    }
    return encodePng({
      width,
      height,
      color: channels === 3 ? "rgba" : "gray-alpha",
      bitDepth: 8,
      data: out,
    });
  }

  /**
   * Writes one image and returns what was written.
   *
   * The fast paths keep a file's own sample depth where PNG can hold it: a
   * stencil mask or a plain grey image stays 1-, 2-, 4-, or 8-bit, and an
   * Indexed image becomes a palette PNG. Everything else is 8-bit gray or RGB.
   */
  private async encode(
    placement: Placement,
    facts: ImageFacts,
    base: string,
    entry: PdfImage,
  ): Promise<Written> {
    const { stream } = placement;
    const { width, height, bpc } = facts;
    if (width <= 0 || height <= 0)
      throw new ImageUndecodable("The image declares no width or height");
    const components = facts.imageMask ? 1 : (facts.space?.components ?? 3);
    if (expectedLength(width, height, Math.max(components, 1), Math.max(bpc, 8)) > MAX_IMAGE_BYTES)
      throw new DecodeBudgetExceeded(MAX_IMAGE_BYTES);

    const codec = facts.filters.find((step) => ["DCTDecode", "JPXDecode"].includes(step.name));

    // A JPEG is written as the JPEG it already is.
    if (codec?.name === "DCTDecode" && !facts.imageMask) {
      const { data } = this.decoded(stream, facts);
      const jpeg = Buffer.from(data);
      const written: Written = { ...this.write(`${base}.jpg`, jpeg), format: "jpeg" };
      const alpha = await this.alphaFor(stream, facts, null);
      if (alpha) {
        const maskFile = `${base}-mask.png`;
        this.write(
          maskFile,
          encodePng({ width, height, color: "gray", bitDepth: 8, data: alpha.alpha }),
        );
        written.mask = { file: maskFile };
      }
      if (facts.space && !facts.space.verbatim)
        this.note({
          code: CODES.imageCmykJpeg,
          quality: "exact",
          message: `${entry.colorSpace} JPEG written as stored; it is not converted to RGB, and some viewers show such a JPEG inverted`,
          page: entry.page,
          construct: entry.colorSpace ?? undefined,
        });
      return written;
    }

    if (codec?.name === "JPXDecode") {
      const { data } = this.decoded(stream, facts);
      try {
        const declared = facts.space?.components ?? 0;
        const decoded = await decodeJpx(data, declared === 1 || declared === 3 ? declared : 0);
        const count = decoded.length / (width * height);
        if (!Number.isInteger(count) || count < 1 || count > 4)
          throw new Error("unexpected component count");
        const channels = count === 1 || count === 2 ? 1 : 3;
        const pixels = new Uint8Array(width * height * channels);
        let alpha: Uint8Array | null = null;
        if (count === 2 || count === 4) alpha = new Uint8Array(width * height);
        for (let pixel = 0; pixel < width * height; pixel += 1) {
          for (let channel = 0; channel < channels; channel += 1)
            pixels[pixel * channels + channel] = decoded[pixel * count + channel];
          if (alpha) alpha[pixel] = decoded[pixel * count + count - 1];
        }
        const masked = await this.alphaFor(stream, facts, null);
        if (masked) alpha = masked.alpha;
        return {
          ...this.write(
            `${base}.png`,
            this.png({ width, height, channels: channels as 1 | 3, data: pixels }, alpha),
          ),
          format: "png",
        };
      } catch (error) {
        // Kept rather than lost: a JPEG 2000 file is a standalone image.
        this.note({
          code: CODES.imageKeptEncoded,
          quality: "approximate",
          message: `JPEG 2000 image could not be decoded to PNG (${(error as Error).message}); the original stream was written instead`,
          page: entry.page,
          construct: "JPXDecode",
        });
        return { ...this.write(`${base}.jp2`, Buffer.from(data)), format: "jp2" };
      }
    }

    const raw = await this.rawSamples(stream, facts, components);
    const needed = expectedLength(width, height, components, bpc);
    let data = raw.data;
    if (data.length < needed) {
      this.note({
        code: CODES.imageTruncated,
        quality: "approximate",
        message: `Image data is ${data.length} bytes where ${needed} were declared; the missing rows were filled`,
        page: entry.page,
        construct: entry.object ?? "inline",
      });
      const padded = new Uint8Array(needed);
      padded.set(data);
      data = padded;
    }

    // Stencil mask: painted samples black, the rest white.
    if (facts.imageMask) {
      const stride = Math.ceil(width / 8);
      const out = Uint8Array.from(data.subarray(0, stride * height));
      if (facts.decode && facts.decode[0] === 1)
        for (let index = 0; index < out.length; index += 1) out[index] ^= 0xff;
      return {
        ...this.write(
          `${base}.png`,
          encodePng({ width, height, color: "gray", bitDepth: 1, data: out }),
        ),
        format: "png",
      };
    }

    const space = facts.space ?? DEVICE_GRAY;
    const hasMask = stream.dict.map.has("SMask") || stream.dict.map.has("Mask");
    const defaultDecode = !facts.decode;
    const packable = [1, 2, 4, 8].includes(bpc);

    if (!hasMask && defaultDecode && packable && space.indexed && space.indexed.base.verbatim) {
      const { base: baseSpace, hival, lookup } = space.indexed;
      const entries = 1 << bpc;
      const palette = new Uint8Array(entries * 3);
      const scratch = new Uint8Array(3);
      const comps = new Array<number>(baseSpace.components).fill(0);
      for (let index = 0; index <= Math.min(hival, entries - 1); index += 1) {
        for (let component = 0; component < baseSpace.components; component += 1)
          comps[component] = (lookup[index * baseSpace.components + component] ?? 0) / 255;
        baseSpace.convert(comps, scratch, 0);
        palette[index * 3] = scratch[0];
        palette[index * 3 + 1] = baseSpace.output === "rgb" ? scratch[1] : scratch[0];
        palette[index * 3 + 2] = baseSpace.output === "rgb" ? scratch[2] : scratch[0];
      }
      const stride = Math.ceil((width * bpc) / 8);
      return {
        ...this.write(
          `${base}.png`,
          encodePng({
            width,
            height,
            color: "palette",
            bitDepth: bpc,
            data: data.subarray(0, stride * height),
            palette,
          }),
        ),
        format: "png",
      };
    }

    if (
      !hasMask &&
      defaultDecode &&
      packable &&
      space.components === 1 &&
      space.output === "gray" &&
      space.verbatim
    ) {
      const stride = Math.ceil((width * bpc) / 8);
      return {
        ...this.write(
          `${base}.png`,
          encodePng({
            width,
            height,
            color: "gray",
            bitDepth: bpc,
            data: data.subarray(0, stride * height),
          }),
        ),
        format: "png",
      };
    }

    // 8-bit grey or RGB samples with no Decode array are already PNG pixels:
    // copied straight through, with no per-pixel conversion. This is the path a
    // 6600x5100 scan takes, and the per-pixel one is several times slower.
    const colorKey = Array.isArray(this.store.resolve(stream.dict.map.get("Mask")));
    if (bpc === 8 && defaultDecode && space.verbatim && !space.indexed && !colorKey) {
      const channels = space.output === "rgb" ? 3 : 1;
      if (space.components === channels) {
        const pixels: Pixels = {
          width,
          height,
          channels: channels as 1 | 3,
          data: data.subarray(0, width * height * channels),
        };
        const alpha = await this.alphaFor(stream, facts, null);
        return {
          ...this.write(`${base}.png`, this.png(pixels, alpha?.alpha ?? null)),
          format: "png",
        };
      }
    }

    const samples = samplesOf(data, width, height, space.components, bpc);
    const pixels = this.toPixels(samples, facts, space);
    const alpha = await this.alphaFor(stream, facts, samples);
    if (!space.verbatim)
      this.note({
        code: CODES.imageColorConverted,
        quality: "approximate",
        message: `${entry.colorSpace} samples were converted to RGB by formula, without colour management`,
        page: entry.page,
        construct: entry.colorSpace ?? undefined,
      });
    return { ...this.write(`${base}.png`, this.png(pixels, alpha?.alpha ?? null)), format: "png" };
  }

  private write(file: string, body: Buffer): { file: string; bytes: number; sha256: string } {
    writeAtomically(path.join(this.options.out, file), body);
    return {
      file,
      bytes: body.length,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    };
  }

  async run(pageCount: number): Promise<ImagesResult> {
    const { store, options } = this;
    const pages = pageList(store, pageCount);
    if (pages.length !== pageCount)
      this.note({
        code: CODES.imagePagesMismatch,
        quality: "approximate",
        message: `The page tree yielded ${pages.length} page(s) where the parser counted ${pageCount}; images were read from the pages that resolved`,
      });
    fs.mkdirSync(options.out, { recursive: true });

    const images: PdfImage[] = [];
    const digits = Math.max(3, String(pageCount).length);
    for (const pageNumber of options.pages) {
      options.check();
      const page = pages[pageNumber - 1];
      if (!page) continue;
      let placements: Placement[];
      try {
        placements = walkImages(store, page.dict, page.resources, {
          maxPlacements: MAX_IMAGES - images.length,
          check: options.check,
        });
      } catch (error) {
        if (error instanceof ContentBudgetExceeded) {
          this.note({
            code: CODES.imageBudgetReached,
            quality: "unsupported",
            severity: "error",
            message: error.message,
            page: pageNumber,
          });
          break;
        }
        if (error instanceof DecodeBudgetExceeded || error instanceof FilterError) {
          this.note({
            code: CODES.contentUndecodable,
            quality: "unsupported",
            severity: "error",
            message: `The page's content could not be decoded: ${error.message}`,
            page: pageNumber,
          });
          continue;
        }
        throw error;
      }

      for (const [offset, placement] of placements.entries()) {
        const index = offset + 1;
        const entry = await this.describe(placement, pageNumber, index, digits);
        images.push(entry);
      }
    }
    return { images, diagnostics: this.sink.all() };
  }

  private async describe(
    placement: Placement,
    page: number,
    index: number,
    digits: number,
  ): Promise<PdfImage> {
    const { store, options } = this;
    const { stream } = placement;
    const info = facts(store, stream, placement.resources);
    const object = !placement.inline && stream.ref ? refLabel(stream.ref) : null;
    const smask = store.resolve(stream.dict.map.get("SMask"));
    const maskValue = store.resolve(stream.dict.map.get("Mask"));
    const mask: PdfImage["mask"] = isStream(smask)
      ? { type: "smask", ...(smask.ref ? { object: refLabel(smask.ref) } : {}) }
      : isStream(maskValue)
        ? { type: "stencil", ...(maskValue.ref ? { object: refLabel(maskValue.ref) } : {}) }
        : Array.isArray(maskValue)
          ? { type: "color-key" }
          : undefined;
    const entry: PdfImage = {
      page,
      index,
      object,
      ...(placement.resourceName ? { name: placement.resourceName } : {}),
      inline: placement.inline,
      ...(placement.forms.length ? { forms: placement.forms } : {}),
      width: info.width,
      height: info.height,
      colorSpace: info.imageMask
        ? null
        : (info.space?.label ?? (info.spaceError ? "unsupported" : "JPX")),
      components: info.imageMask ? 1 : (info.space?.components ?? 0),
      bitsPerComponent: info.bpc,
      filters: info.filters.map((step) => step.name),
      imageMask: info.imageMask,
      ...(mask ? { mask } : {}),
      transform: placement.ctm.map(r3),
      box: placementBox(placement.ctm),
    };

    if (Math.min(info.width, info.height) < options.minSize) {
      entry.skipped = "min-size";
      return entry;
    }
    if (info.spaceError && !info.space) {
      entry.skipped = "undecodable";
      this.note({
        code: CODES.imageUndecodable,
        quality: "unsupported",
        severity: "warning",
        message: `Image ${object ?? "inline"} was not written: ${info.spaceError}`,
        page,
        construct: object ?? "inline",
      });
      return entry;
    }
    if (info.spaceError)
      this.note({
        code: CODES.imageUndecodable,
        quality: "approximate",
        message: info.spaceError,
        page,
        construct: object ?? "inline",
      });

    const reuse = object ? this.byObject.get(object) : undefined;
    if (reuse) return this.withFile(entry, reuse);

    const base = `img-p${String(page).padStart(digits, "0")}-${String(index).padStart(2, "0")}`;
    try {
      const written = await this.encode(placement, info, base, entry);
      if (object) this.byObject.set(object, written);
      return this.withFile(entry, written);
    } catch (error) {
      // Every failure is per image: one undecodable image must not lose the rest.
      // Codec errors arrive from pdf.js under its own classes, so the net is wide.
      if (!(error instanceof Error)) throw error;
      if ((error as Error).name === "DeadlineExceeded") throw error;
      const message = error.message;
      entry.skipped = "undecodable";
      this.note({
        code:
          error instanceof DecodeBudgetExceeded ? CODES.imageBudgetReached : CODES.imageUndecodable,
        quality: "unsupported",
        severity: "warning",
        message: `Image ${object ?? "inline"} could not be decoded: ${message}`,
        page,
        construct: (error as ImageUndecodable).construct ?? object ?? "inline",
      });
      return entry;
    }
  }

  private withFile(entry: PdfImage, written: Written): PdfImage {
    return {
      ...entry,
      ...(entry.mask && written.mask ? { mask: { ...entry.mask, file: written.mask.file } } : {}),
      file: written.file,
      format: written.format,
      bytes: written.bytes,
      sha256: written.sha256,
    };
  }
}

/** A mask's own facts: it carries its own size, depth, and Decode, and no colour space of interest. */
function maskFacts_(store: ObjectStore, stream: PdfStream): ImageFacts {
  return facts(store, stream, null);
}

/**
 * Runs the extraction. Opens its own object store over a private copy of the
 * bytes, because pdf.js detaches the buffer it was handed.
 */
export async function extractImages(
  bytes: Uint8Array,
  pageCount: number,
  options: ImagesOptions,
): Promise<ImagesResult> {
  let store: ObjectStore;
  try {
    store = new ObjectStore(bytes, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof UnsupportedEncryption)
      return {
        images: [],
        diagnostics: [
          {
            code: CODES.imageEncryption,
            severity: "error",
            quality: "unsupported",
            message: `Images cannot be read: ${error.message}`,
            remediation:
              "Decrypt the document with another tool first, or cut figures out with `pdf render`.",
          },
        ],
      };
    throw error;
  }
  const extractor = new ImageExtractor(store, options);
  const result = await extractor.run(pageCount);
  const diagnostics = [...result.diagnostics];
  if (store.notes.rebuilt)
    diagnostics.push({
      code: CODES.xrefReconstructed,
      severity: "notice",
      quality: "exact",
      message: "The cross-reference data was damaged; objects were located by scanning the file",
    });
  return { images: result.images, diagnostics };
}
