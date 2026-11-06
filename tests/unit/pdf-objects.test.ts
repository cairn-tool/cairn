import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractImages, placementBox } from "../../src/pdf/images.js";
import { assemble, parseTsv } from "../../src/pdf/ocr.js";
import { encodePng } from "../../src/pdf/png.js";
import { parseBox } from "../../src/pdf/render.js";
import { resolveColorSpace } from "../../src/pdf/objects/colorspace.js";
import { IDENTITY, multiply } from "../../src/pdf/objects/content.js";
import {
  DecodeBudgetExceeded,
  FilterError,
  applyFilter,
  decodeChain,
} from "../../src/pdf/objects/filters.js";
import { parseFunction } from "../../src/pdf/objects/functions.js";
import { ObjectStore, pageList } from "../../src/pdf/objects/store.js";
import {
  Lexer,
  isDict,
  isName,
  isRef,
  isStream,
  isString,
  parseIndirect,
  parseObject,
} from "../../src/pdf/objects/syntax.js";
import type { PdfObject } from "../../src/pdf/objects/syntax.js";
import {
  buildPdf,
  encryptionSource,
  lzwEncode,
  pdfFixture,
  shiftXrefOffsets,
} from "../helpers/pdf-fixture.js";
import * as qpdf from "../helpers/pdf-qpdf-fixtures.js";
import { decodePng, pixel } from "../helpers/png-decode.js";

/**
 * The object layer `pdf images` reads through, tested below the CLI.
 *
 * The cross-reference, object-stream, and decryption paths are checked against
 * files qpdf wrote (`tests/helpers/pdf-qpdf-fixtures.ts`), so what is proved is
 * agreement with an independent writer rather than with this repository's own.
 */

const parse = (text: string): PdfObject => parseObject(new Lexer(Buffer.from(text, "latin1")));
const bytes = (value: PdfObject): string =>
  isString(value) ? Buffer.from(value.bytes).toString("latin1") : "";

const temporary: string[] = [];
afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});
function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-objects-"));
  temporary.push(root);
  return root;
}

describe("PDF syntax", () => {
  it("reads names with #xx escapes, numbers, booleans, and null", () => {
    expect(parse("/A#20B")).toEqual({ kind: "name", name: "A B" });
    expect(parse("-12.5")).toBe(-12.5);
    expect(parse(".5")).toBe(0.5);
    expect(parse("true")).toBe(true);
    expect(parse("null")).toBeNull();
  });

  it("reads literal strings with escapes, octal, and balanced parentheses", () => {
    expect(bytes(parse("(a\\(b\\)c (nested) \\101\\n)"))).toBe("a(b)c (nested) A\n");
    expect(bytes(parse("(line\\\r\ncontinued)"))).toBe("linecontinued");
  });

  it("reads hex strings, padding an odd final digit", () => {
    expect(Array.from((parse("<48 65 6C6C 6f 7>") as { bytes: Uint8Array }).bytes)).toEqual([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x70,
    ]);
  });

  it("folds `n g R` into a reference, and nests arrays and dictionaries", () => {
    const value = parse("<< /Kids [3 0 R 4 0 R] /Count 2 /Inner << /X [1 [2]] >> >>");
    expect(isDict(value)).toBe(true);
    const map = (value as { map: Map<string, PdfObject> }).map;
    const kids = map.get("Kids") as PdfObject[];
    expect(kids.every(isRef)).toBe(true);
    expect(map.get("Count")).toBe(2);
    expect(isDict(map.get("Inner"))).toBe(true);
  });

  it("recovers a stream whose /Length is wrong", () => {
    const text = "7 0 obj\n<< /Length 999 >>\nstream\nabcdef\nendstream\nendobj\n";
    const parsed = parseIndirect(Buffer.from(text, "latin1"), 0);
    expect(parsed.num).toBe(7);
    expect(isStream(parsed.value)).toBe(true);
    expect(Buffer.from((parsed.value as { raw: Uint8Array }).raw).toString("latin1")).toBe(
      "abcdef",
    );
  });

  it("refuses nesting past its cap rather than recursing without bound", () => {
    expect(() => parse("[".repeat(500))).toThrow(/nesting/);
  });
});

describe("stream filters", () => {
  const step = (name: string, parms: PdfObject = null) => ({
    name,
    parms: isDict(parms) ? parms : null,
  });
  const run = (name: string, data: string | Buffer): string =>
    Buffer.from(
      applyFilter(typeof data === "string" ? Buffer.from(data, "latin1") : data, step(name), 1e6),
    ).toString("latin1");

  it("decodes ASCIIHex, ASCII85, and RunLength", () => {
    expect(run("ASCIIHexDecode", "48 65 6c 6c 6f>")).toBe("Hello");
    expect(run("ASCII85Decode", "<~9jqo^~>")).toBe("Man ");
    expect(run("ASCII85Decode", "z~>")).toBe("\0\0\0\0");
    expect(run("RunLengthDecode", Buffer.from([2, 65, 66, 67, 254, 68, 128]))).toBe("ABCDDD");
  });

  it("decodes LZW from an independent encoder", () => {
    const source = Buffer.from("TOBEORNOTTOBEORTOBEORNOT".repeat(40), "latin1");
    expect(run("LZWDecode", lzwEncode(source))).toBe(source.toString("latin1"));
  });

  it("applies the PNG predictors", () => {
    // Two rows of three bytes: row 1 Sub, row 2 Up.
    const predicted = Buffer.from([1, 10, 5, 5, 2, 1, 1, 1]);
    const parms = parse("<< /Predictor 12 /Columns 3 >>");
    const out = applyFilter(zlib.deflateSync(predicted), step("FlateDecode", parms), 1e6);
    expect(Array.from(out)).toEqual([10, 15, 20, 11, 16, 21]);
  });

  it("stops at an image codec and hands its bytes back undecoded", () => {
    const steps = [step("ASCIIHexDecode"), step("DCTDecode")];
    const result = decodeChain(Buffer.from("FFD8FFD9>", "latin1"), steps, 1e6);
    expect(result.codec?.name).toBe("DCTDecode");
    expect(Array.from(result.data)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it("bounds a decompression bomb and names an unknown filter", () => {
    const bomb = zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024));
    expect(() => applyFilter(bomb, step("FlateDecode"), 1024 * 1024)).toThrow(DecodeBudgetExceeded);
    expect(() => applyFilter(Buffer.alloc(1), step("BogusDecode"), 10)).toThrow(FilterError);
  });
});

describe("the object store", () => {
  it("reads a classic cross-reference table and walks the page tree", () => {
    const store = new ObjectStore(pdfFixture("manyPages"), 1e7);
    expect(store.notes.rebuilt).toBe(false);
    expect(pageList(store, 100)).toHaveLength(40);
  });

  it("rebuilds from a scan when the cross-reference offsets are wrong", () => {
    const store = new ObjectStore(shiftXrefOffsets(buildPdf(encryptionSource()), 3), 1e7);
    expect(store.notes.rebuilt).toBe(true);
    expect(isName(store.catalog()?.map.get("Type"), "Catalog")).toBe(true);
    expect(pageList(store, 10)).toHaveLength(1);
  });

  it("reads cross-reference streams and object streams written by qpdf", () => {
    const store = new ObjectStore(qpdf.objectStreams, 1e7);
    expect(store.notes.rebuilt).toBe(false);
    expect(pageList(store, 10)).toHaveLength(1);
  });

  it.each([
    ["RC4 40-bit (R2)", "rc4_40"],
    ["RC4 128-bit (R3)", "rc4_128"],
    ["AES-128 (R4)", "aes128"],
    ["AES-256 (R6)", "aes256"],
    ["AES-256 with object streams", "aes256ObjectStreams"],
  ] as const)("deciphers %s with the empty user password", async (_label, key) => {
    const store = new ObjectStore(qpdf[key], 1e7);
    expect(store.notes.encrypted).toBe(true);
    const plain = await images(buildPdf(encryptionSource()));
    const enciphered = await images(qpdf[key]);
    expect(enciphered.map((image) => image.sha256)).toEqual(plain.map((image) => image.sha256));
    expect(enciphered).toHaveLength(2);
  });

  async function images(pdf: Buffer) {
    const out = directory();
    const result = await extractImages(new Uint8Array(pdf), 1, {
      pages: [1],
      out,
      minSize: 0,
      check: () => {},
    });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const [rgb, indexed] = result.images;
    const png = decodePng(fs.readFileSync(path.join(out, rgb.file!)));
    expect([pixel(png, 0, 0), pixel(png, 1, 0)]).toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const palette = decodePng(fs.readFileSync(path.join(out, indexed.file!)));
    expect([pixel(palette, 0, 0), pixel(palette, 1, 0)]).toEqual([
      [0, 255, 0, 255],
      [255, 255, 0, 255],
    ]);
    return result.images;
  }
});

describe("functions and colour spaces", () => {
  const store = new ObjectStore(buildPdf({ pages: [[]] }), 1e6);
  const streamOf = (dict: string, body: string): PdfObject => {
    const text = `9 0 obj\n${dict.replace(">>", `/Length ${body.length} >>`)}\nstream\n${body}\nendstream\nendobj\n`;
    return parseIndirect(Buffer.from(text, "latin1"), 0).value;
  };

  it("interprets a PostScript calculator function, branches included", () => {
    const fn = parseFunction(
      store,
      streamOf(
        "<< /FunctionType 4 /Domain [0 1] /Range [0 1 0 1] >>",
        "{ dup 0.5 gt { 1 exch sub } { 2 mul } ifelse dup }",
      ),
    );
    expect(fn([0.25])).toEqual([0.5, 0.5]);
    expect(fn([0.75])).toEqual([0.25, 0.25]);
  });

  it("refuses an operator it does not know rather than guessing", () => {
    const fn = parseFunction(
      store,
      streamOf("<< /FunctionType 4 /Domain [0 1] /Range [0 1] >>", "{ exec }"),
    );
    expect(() => fn([0])).toThrow(/not supported/);
  });

  it("converts CMYK and Lab by formula, and resolves Indexed", () => {
    const out = new Uint8Array(3);
    resolveColorSpace(store, parse("/DeviceCMYK"), null).convert([0, 1, 0, 0], out, 0);
    expect(Array.from(out)).toEqual([255, 0, 255]);
    const lab = resolveColorSpace(store, parse("[/Lab << /WhitePoint [0.9505 1 1.089] >>]"), null);
    lab.convert([1, 0.5, 0.5], out, 0);
    expect(Math.min(...out)).toBeGreaterThan(250);
    const indexed = resolveColorSpace(store, parse("[/Indexed /DeviceGray 1 <00FF>]"), null);
    expect(indexed.label).toBe("Indexed(DeviceGray,1)");
    indexed.convert([1], out, 0);
    expect(out[0]).toBe(255);
  });
});

describe("the PNG encoder", () => {
  it("round-trips grey at 1 bit, a palette, and RGBA, and is deterministic", () => {
    const gray = encodePng({
      width: 8,
      height: 2,
      color: "gray",
      bitDepth: 1,
      data: Uint8Array.from([0b10100000, 0xff]),
    });
    const decoded = decodePng(gray);
    expect([pixel(decoded, 0, 0)[0], pixel(decoded, 1, 0)[0], pixel(decoded, 0, 1)[0]]).toEqual([
      255, 0, 255,
    ]);
    const palette = decodePng(
      encodePng({
        width: 2,
        height: 1,
        color: "palette",
        bitDepth: 8,
        data: Uint8Array.from([1, 0]),
        palette: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      }),
    );
    expect(pixel(palette, 0, 0)).toEqual([4, 5, 6, 255]);
    const rgba = Uint8Array.from({ length: 4 * 3 * 3 }, (_, index) => (index * 37) & 0xff);
    const image = { width: 3, height: 3, color: "rgba" as const, bitDepth: 8, data: rgba };
    const first = encodePng(image);
    expect(Array.from(decodePng(first).rgba)).toEqual(Array.from(rgba));
    expect(crypto.createHash("sha256").update(encodePng(image)).digest("hex")).toBe(
      crypto.createHash("sha256").update(first).digest("hex"),
    );
    // No ancillary chunks: IHDR, IDAT, IEND, and nothing that could carry a timestamp.
    expect(first.includes(Buffer.from("tIME"))).toBe(false);
  });
});

describe("geometry, boxes, and recognised text", () => {
  it("bounds a rotated placement", () => {
    // Scaled to 100x50, then turned a quarter, then moved: `A cm` applies A first.
    const rotated = multiply([100, 0, 0, 50, 0, 0], multiply([0, 1, -1, 0, 0, 0], [...IDENTITY]));
    expect(placementBox(multiply(rotated, [1, 0, 0, 1, 200, 300]))).toEqual([150, 300, 200, 400]);
  });

  it("parses --box, normalizing corner order and refusing an empty one", () => {
    expect(parseBox("200,300,100,50")).toEqual([100, 50, 200, 300]);
    expect(parseBox("1,2,3")).toBeNull();
    expect(parseBox("1,1,1,5")).toBeNull();
    expect(parseBox("a,b,c,d")).toBeNull();
  });

  it("groups Tesseract TSV into lines and maps boxes into user space", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "4\t1\t1\t1\t1\t0\t0\t0\t100\t20\t-1\t",
      "5\t1\t1\t1\t1\t1\t0\t0\t40\t20\t90\tHello",
      "5\t1\t1\t1\t1\t2\t50\t0\t50\t20\t60\tworld",
      "5\t1\t2\t1\t1\t1\t0\t100\t40\t20\t-1\t ",
      "5\t1\t2\t1\t1\t2\t0\t100\t40\t20\t80\tAgain",
    ].join("\n");
    const lines = parseTsv(tsv);
    expect(lines).toHaveLength(2);
    // A 100-pixel-high image at 72 dpi on a page whose top is y=100.
    const result = assemble(lines, (x, y) => [x, 100 - y]);
    expect(result.text).toBe("Hello world\n\nAgain");
    expect(result.words[0]).toEqual({ text: "Hello", confidence: 90, box: [0, 80, 40, 100] });
    expect(result.confidence).toBe(r1((90 * 5 + 60 * 5 + 80 * 5) / 15));
    expect(assemble([], (x, y) => [x, y]).confidence).toBeNull();
  });
});

function r1(value: number): number {
  return Math.round(value * 10) / 10;
}
