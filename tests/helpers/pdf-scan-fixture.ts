import zlib from "node:zlib";
import { withDocument } from "../../src/pdf/document.js";
import { renderRegion } from "../../src/pdf/render.js";
import { buildPdf } from "./pdf-fixture.js";
import type { PdfRef } from "./pdf-fixture.js";

/**
 * An image-only "scanned" page: text drawn as pixels, with no text layer.
 *
 * Made by rendering a generated text page and embedding the result as one grey
 * image on an otherwise empty page — the shape a scanner produces, built from
 * nothing but the repository's own fixture builder and pdf.js's bundled
 * standard fonts, so it is the same on every machine and nothing is downloaded.
 */

export const SCANNED_LINES = ["SCANNED REPORT", "Radiation dose 1991", "The quick brown fox"];

let cached: Promise<Buffer> | null = null;

export function scannedPdf(): Promise<Buffer> {
  cached ??= (async () => {
    const source = buildPdf({
      pages: [
        SCANNED_LINES.map((text, index) => ({
          x: 72,
          y: 680 - index * 60,
          size: 32,
          font: "F1",
          text,
        })),
      ],
    });
    const dpi = 150;
    const rendered = await withDocument(source, { timeoutMs: 20_000, maxPages: 10 }, (handle) =>
      renderRegion(handle, { page: 1, dpi }),
    );
    const gray = Buffer.alloc(rendered.width * rendered.height);
    for (let index = 0; index < gray.length; index += 1) gray[index] = rendered.rgb[index * 3 + 1];
    return buildPdf({
      pages: [[]],
      extras: { 0: ["q 612 0 0 792 0 0 cm /Scan Do Q"] },
      extend: ({ reserve, add, ref, name }) => {
        const num = reserve();
        add(
          num,
          {
            Type: name("XObject"),
            Subtype: name("Image"),
            Width: rendered.width,
            Height: rendered.height,
            ColorSpace: name("DeviceGray"),
            BitsPerComponent: 8,
            Filter: name("FlateDecode"),
          },
          zlib.deflateSync(gray),
        );
        const scan: PdfRef = ref(num);
        return { resources: { 0: { XObject: { Scan: scan } } } };
      },
    });
  })();
  return cached;
}
