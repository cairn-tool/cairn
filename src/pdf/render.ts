import { createRequire } from "node:module";
import type { OpenDocument, PdfRenderablePage } from "./document.js";
import { CODES, DiagnosticSink } from "./diagnostics.js";
import { encodePng } from "./png.js";
import type { PdfDiagnostic } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Page and region rasterization: pdf.js drawing onto `@napi-rs/canvas`.
 *
 * The canvas is loaded on demand, here and nowhere else, so no other command
 * pays for a 25 MB native binary it does not use. It is the canvas pdf.js
 * itself names as its Node optional dependency, which is why it is already in
 * every install where its prebuilt binary exists; cairn declares it as its own
 * optional dependency rather than relying on that.
 *
 * The PNG is encoded by `./png.ts` from the canvas's pixels, not by the
 * canvas's own encoder, so the file's bytes depend on the pixels alone.
 */

/** Pixels one render may produce. Past this the request is refused before drawing. */
export const MAX_RENDER_PIXELS = 100_000_000;

export const DEFAULT_DPI = 150;
export const MIN_DPI = 18;
export const MAX_DPI = 1200;

export class RendererUnavailable extends Error {
  constructor(cause: string) {
    super(
      `The page renderer could not be loaded (${cause}). It needs the optional dependency ` +
        "@napi-rs/canvas, which ships prebuilt binaries for macOS, Linux (glibc and musl), and Windows " +
        "on x64 and arm64. Reinstall without --omit=optional, or run npm install @napi-rs/canvas.",
    );
    this.name = "RendererUnavailable";
  }
}

let canvasModule: any;

/**
 * Loads `@napi-rs/canvas` from the first anchor that can resolve it.
 *
 * Exported with its anchors as a parameter so the resolution order can be tested
 * against a constructed tree; {@link loadCanvas} is the only production caller.
 */
export function resolveCanvas(anchors: string[]): any {
  let first: unknown;
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)("@napi-rs/canvas");
    } catch (error) {
      first ??= error;
    }
  }
  throw first ?? new Error("no anchor to resolve @napi-rs/canvas from");
}

/**
 * Where the canvas is resolved from, in order: pdfjs-dist's package directory,
 * then `from` (cairn's own module). `from` is a parameter only so a test can
 * root the lookup in a constructed `node_modules` tree.
 */
export function canvasAnchors(from: string = import.meta.url): string[] {
  const anchors: string[] = [];
  try {
    anchors.push(createRequire(from).resolve("pdfjs-dist/package.json"));
  } catch {
    // pdfjs-dist missing is reported by the document loader; fall through to cairn's copy.
  }
  anchors.push(from);
  return anchors;
}

/**
 * The canvas, resolved **from pdfjs-dist's own directory** first and from
 * cairn's only as a fallback.
 *
 * pdf.js loads `@napi-rs/canvas` itself, at import, with a `createRequire` rooted
 * in its own build file — for the `DOMMatrix` and `Path2D` polyfills and for
 * every scratch canvas it makes while drawing. If cairn resolved its own copy
 * and npm had installed a second one nested under pdfjs-dist (which a fresh
 * install does whenever the two version ranges pick different releases), the
 * process would hold two native Skia modules, and pdf.js would draw its `Path2D`
 * from one into a context from the other. That is a segfault, not an error:
 * cairn 6.4.0 exited 139 on every `pdf render` from a global install. Resolving
 * through pdfjs-dist makes the two always the same module, whatever npm decided;
 * `tests/unit/pdf-canvas.test.ts` holds that in place.
 */
export function loadCanvas(): any {
  if (canvasModule) return canvasModule;
  try {
    canvasModule = resolveCanvas(canvasAnchors());
  } catch (error) {
    throw new RendererUnavailable((error as Error).message.split("\n")[0]);
  }
  return canvasModule;
}

export type Box = [number, number, number, number];

export interface RenderRequest {
  page: number;
  /** In default user space, points, origin bottom-left: the space `pdf images` reports `box` in. */
  box?: Box;
  dpi: number;
}

export interface Rendered {
  png: Buffer;
  width: number;
  height: number;
  /** The region actually drawn, in user space — the request snapped to whole pixels and clipped to the page. */
  box: Box;
  /** The page's visible area (its crop box) in user space. */
  pageBox: Box;
  rotation: number;
  /** RGB, 3 bytes per pixel, for callers (OCR) that want pixels rather than a file. */
  rgb: Uint8Array;
  /** Maps a pixel coordinate (origin top-left) back to user space. */
  toUser(x: number, y: number): [number, number];
  diagnostics: PdfDiagnostic[];
}

/** Rounds to 3 dp, and never emits `-0`. */
function r3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

/** Parses `x0,y0,x1,y1`, normalizing the corner order. */
export function parseBox(text: string): Box | null {
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(part)))
    return null;
  const [x0, y0, x1, y1] = parts.map(Number);
  const box: Box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  if (box[2] - box[0] <= 0 || box[3] - box[1] <= 0) return null;
  return box;
}

/**
 * Renders a page, or the part of it inside `box`.
 *
 * The box is converted to device pixels by pdf.js's own viewport transform —
 * which applies `/Rotate` and the y flip in one place — and snapped outward to
 * whole pixels. The reported `box` is that pixel rectangle mapped back, so the
 * PNG and the box always describe exactly the same area.
 */
export async function renderRegion(
  handle: OpenDocument,
  request: RenderRequest,
): Promise<Rendered> {
  const canvasLib = loadCanvas();
  const sink = new DiagnosticSink();
  const page = (await handle.within(() =>
    handle.doc.getPage(request.page),
  )) as unknown as PdfRenderablePage;
  try {
    const scale = request.dpi / 72;
    const view = page.view;
    const pageBox: Box = [
      Math.min(view[0], view[2]),
      Math.min(view[1], view[3]),
      Math.max(view[0], view[2]),
      Math.max(view[1], view[3]),
    ];
    let box: Box = request.box ?? pageBox;
    if (request.box) {
      const clipped: Box = [
        Math.max(box[0], pageBox[0]),
        Math.max(box[1], pageBox[1]),
        Math.min(box[2], pageBox[2]),
        Math.min(box[3], pageBox[3]),
      ];
      if (clipped[2] <= clipped[0] || clipped[3] <= clipped[1])
        throw new RenderRefused(
          CODES.renderBoxOutside,
          `The box ${box.join(",")} lies outside the page's visible area ${pageBox.map(r3).join(",")}`,
        );
      if (clipped.some((value, index) => value !== box[index]))
        sink.add({
          code: CODES.renderBoxClipped,
          quality: "exact",
          message: `The box was clipped to the page's visible area ${pageBox.map(r3).join(",")}`,
          page: request.page,
        });
      box = clipped;
    }

    const full = page.getViewport({ scale });
    const corners = [
      full.convertToViewportPoint(box[0], box[1]),
      full.convertToViewportPoint(box[2], box[1]),
      full.convertToViewportPoint(box[0], box[3]),
      full.convertToViewportPoint(box[2], box[3]),
    ];
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    // Snap outward, but forgive float noise so an exact box is not widened by a pixel.
    const px0 = Math.floor(Math.min(...xs) + 1e-6);
    const py0 = Math.floor(Math.min(...ys) + 1e-6);
    const px1 = Math.ceil(Math.max(...xs) - 1e-6);
    const py1 = Math.ceil(Math.max(...ys) - 1e-6);
    const width = Math.max(1, px1 - px0);
    const height = Math.max(1, py1 - py0);
    if (width * height > MAX_RENDER_PIXELS)
      throw new RenderRefused(
        CODES.renderTooLarge,
        `The render would be ${width}x${height} pixels, more than the ${MAX_RENDER_PIXELS} allowed`,
        "Lower --dpi, or render a smaller --box.",
      );

    const viewport = page.getViewport({ scale, offsetX: -px0, offsetY: -py0 });
    const canvas = canvasLib.createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    try {
      await handle.within(
        () =>
          page.render({ canvasContext: context, canvas, viewport, background: "#ffffff" }).promise,
      );
    } catch (error) {
      if ((error as Error).name === "DeadlineExceeded") throw error;
      sink.add({
        code: CODES.renderIncomplete,
        severity: "error",
        quality: "approximate",
        message: `The page did not render completely: ${(error as Error).message}`,
        page: request.page,
      });
    }

    const rgba: Uint8ClampedArray = context.getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let pixel = 0, source = 0; pixel < rgb.length; pixel += 3, source += 4) {
      rgb[pixel] = rgba[source];
      rgb[pixel + 1] = rgba[source + 1];
      rgb[pixel + 2] = rgba[source + 2];
    }
    const png = encodePng({ width, height, color: "rgb", bitDepth: 8, data: rgb });
    const toUser = (x: number, y: number): [number, number] => {
      const [ux, uy] = viewport.convertToPdfPoint(x, y);
      return [r3(ux), r3(uy)];
    };
    const a = toUser(0, 0);
    const b = toUser(width, height);
    const drawn: Box = [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
    ];
    return {
      png,
      width,
      height,
      box: drawn,
      pageBox: pageBox.map(r3) as Box,
      rotation: page.rotate,
      rgb,
      toUser,
      diagnostics: sink.all(),
    };
  } finally {
    page.cleanup();
  }
}

/** A request the renderer refuses before drawing: exit 1 with this finding. */
export class RenderRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = "RenderRefused";
  }
}
