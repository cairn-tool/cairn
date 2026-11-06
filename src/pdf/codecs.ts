import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pdfjsRoot } from "./document.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The image codecs pdf.js ships separately from its parser.
 *
 * `pdfjs-dist/image_decoders` exposes the decoders the parser uses internally —
 * JPEG, JPEG 2000 (OpenJPEG), and JBIG2 plus CCITT fax (one WebAssembly module
 * for both). `pdf images` uses them where a stream is not a file in its own
 * right: a CCITT or JBIG2 body is meaningless outside its PDF, so it is decoded
 * to PNG, and a JPEG soft mask is decoded to become an alpha channel.
 *
 * The WebAssembly is read from pdfjs-dist's own `wasm/` directory through the
 * handler hook rather than fetched: `fetch()` cannot read a `file:` URL in Node,
 * and the toolset never reaches the network. If instantiation fails, pdf.js
 * falls back to the pure-JavaScript build beside it.
 */

let loaded: Promise<any> | null = null;

export function imageDecoders(): Promise<any> {
  if (loaded) return loaded;
  loaded = (async () => {
    const emit = process.emitWarning;
    let module: any;
    try {
      process.emitWarning = () => {};
      // A variable specifier because pdfjs-dist publishes no types for this entry.
      const specifier = "pdfjs-dist/image_decoders/pdf.image_decoders.mjs";
      module = await import(specifier);
    } finally {
      process.emitWarning = emit;
    }
    // Errors only: warnings go to console.log in this module, and stdout may be
    // carrying a payload.
    module.setVerbosityLevel?.(module.VerbosityLevel?.ERRORS ?? 0);
    const wasmDir = path.join(pdfjsRoot(), "wasm");
    const handler = {
      sendWithPromise: async (_name: string, data: { filename: string }) =>
        new Uint8Array(fs.readFileSync(path.join(wasmDir, path.basename(data.filename)))),
    };
    const options = {
      handler,
      useWasm: true,
      useWorkerFetch: false,
      wasmUrl: `${pathToFileURL(wasmDir).href}/`,
    };
    module.JpxImage?.setOptions?.(options);
    module.Jbig2Image?.setOptions?.(options);
    return module;
  })();
  return loaded;
}

export interface CcittParams {
  K: number;
  EndOfLine: boolean;
  EncodedByteAlign: boolean;
  BlackIs1: boolean;
  Columns: number;
  Rows: number;
}

/** CCITT G3/G4 to 1-bit samples, 0 black, rows byte-aligned. */
export async function decodeCcitt(
  data: Uint8Array,
  width: number,
  height: number,
  params: CcittParams,
): Promise<Uint8Array> {
  const decoders = await imageDecoders();
  const out = await decoders.Jbig2Image.instance.decode(data, width, height, null, params);
  return new Uint8Array(out);
}

/** JBIG2 to 1-bit samples, 0 black, rows byte-aligned. */
export async function decodeJbig2(
  data: Uint8Array,
  width: number,
  height: number,
  globals: Uint8Array | null,
): Promise<Uint8Array> {
  const decoders = await imageDecoders();
  const out = await decoders.Jbig2Image.instance.decode(data, width, height, globals);
  return new Uint8Array(out);
}

/** JPEG 2000 to interleaved 8-bit samples; the component count is whatever the codestream holds. */
export async function decodeJpx(data: Uint8Array, numComponents: number): Promise<Uint8Array> {
  const decoders = await imageDecoders();
  const out = await decoders.JpxImage.instance.decode(data, { numComponents });
  return new Uint8Array(out);
}

/** JPEG to interleaved 8-bit samples, colour-converted the way a PDF reader converts them. */
export async function decodeJpeg(
  data: Uint8Array,
  width: number,
  height: number,
): Promise<{ data: Uint8Array; components: number }> {
  const decoders = await imageDecoders();
  const jpeg = new decoders.JpegImage();
  jpeg.parse(data);
  const pixels = jpeg.getData({ width, height, forceRGB: false, isSourcePDF: true });
  return { data: new Uint8Array(pixels), components: jpeg.numComponents };
}
