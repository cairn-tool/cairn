import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";
import { FIXTURE_JPEG, pdfFixture } from "../helpers/pdf-fixture.js";
import { SCANNED_LINES, scannedPdf } from "../helpers/pdf-scan-fixture.js";
import { decodePng, pixel } from "../helpers/png-decode.js";

/**
 * `pdf images`, `pdf render`, and `pdf ocr`, end to end against the compiled CLI.
 *
 * Every fixture is generated: `images` and `vector` by the hand-rolled builder,
 * the scanned page by rendering a generated text page and embedding the pixels
 * as the page's only content. Real OCR runs only where a `tesseract` binary is
 * installed; a fake engine — a shell script printing canned TSV — covers the
 * parsing, the coordinate mapping, and the markers everywhere else.
 */

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(...args: string[]): Promise<Run> {
  try {
    const result = await exec("node", [cli, ...args], {
      env: { ...process.env, CI: "1" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

const temporary: string[] = [];

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-media-"));
  temporary.push(root);
  return root;
}

function write(root: string, name: string, bytes: Buffer): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function fixture(key: string): string {
  return write(workspace(), `${key}.pdf`, pdfFixture(key));
}

function validate(payload: unknown, label: string): void {
  const entry = SCHEMA_BY_ID.get("pdf-result")!;
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const check = ajv.compile(entry.schema);
  if (!check(payload))
    throw new Error(`${label} failed pdf-result: ${JSON.stringify(check.errors?.slice(0, 3))}`);
}

const hasTesseract = (() => {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter))
    if (directory && fs.existsSync(path.join(directory, "tesseract"))) return true;
  return false;
})();

interface ImageEntry {
  page: number;
  index: number;
  object: string | null;
  name?: string;
  inline: boolean;
  forms?: string[];
  width: number;
  height: number;
  colorSpace: string | null;
  bitsPerComponent: number;
  filters: string[];
  imageMask: boolean;
  mask?: { type: string; object?: string; file?: string };
  transform: number[];
  box: number[];
  file?: string;
  format?: string;
  sha256?: string;
  skipped?: string;
}

async function extract(...extra: string[]): Promise<{
  out: string;
  payload: { images: ImageEntry[]; diagnostics: { code: string }[]; ok: boolean; output: string };
  result: Run;
}> {
  const out = path.join(workspace(), "figures");
  const result = await run("pdf", "images", fixture("images"), "--out", out, "-fj", ...extra);
  return { out, payload: JSON.parse(result.stdout), result };
}

describe("pdf images", () => {
  it("writes every image, an index, and a schema-valid payload", async () => {
    const { out, payload, result } = await extract();
    expect(result.stderr).toBe("");
    validate(payload, "pdf images");
    expect(payload.output).toBe(out);
    const index = JSON.parse(fs.readFileSync(path.join(out, "images.json"), "utf8"));
    validate(index, "images.json");
    expect(index.images).toEqual(payload.images);
    // 12 placements on page 1 (Im1 twice) and 2 on page 2.
    expect(payload.images.map((image) => `${image.page}:${image.name ?? "inline"}`)).toEqual([
      "1:Im1",
      "1:Im1",
      "1:Im2",
      "1:Im3",
      "1:Im4",
      "1:Im5",
      "1:Im6",
      "1:Im7",
      "1:inline",
      "1:inline",
      "1:Im10",
      "2:Im8",
      "2:Im9",
    ]);
    // CMYK and Separation are converted by formula and say so; that blocks only under --strict.
    expect(
      (payload.diagnostics as { code: string; construct?: string }[]).map(
        (item) => `${item.code} ${item.construct}`,
      ),
    ).toEqual(["AP401 DeviceCMYK", "AP401 Separation(Spot)"]);
    expect(result.exitCode).toBe(0);
  });

  it("writes a DCT image as the JPEG it already is, once for two placements", async () => {
    const { out, payload } = await extract();
    const [first, second] = payload.images;
    expect(first.format).toBe("jpeg");
    expect(first.file).toBe("img-p001-01.jpg");
    expect(second.file).toBe(first.file);
    expect(fs.readFileSync(path.join(out, first.file!)).equals(FIXTURE_JPEG)).toBe(true);
    expect(first.sha256).toBe(crypto.createHash("sha256").update(FIXTURE_JPEG).digest("hex"));
    expect(fs.existsSync(path.join(out, "img-p001-02.jpg"))).toBe(false);
    expect(first).toMatchObject({
      width: 16,
      height: 8,
      colorSpace: "DeviceRGB",
      bitsPerComponent: 8,
      filters: ["DCTDecode"],
      transform: [160, 0, 0, 80, 72, 600],
      box: [72, 600, 232, 680],
    });
    expect(second.box).toEqual([300, 600, 380, 640]);
    expect(first.object).toMatch(/^\d+ 0 R$/);
  });

  it("composites a soft mask as alpha", async () => {
    const { out, payload } = await extract();
    const image = payload.images.find((entry) => entry.name === "Im2")!;
    expect(image.mask?.type).toBe("smask");
    expect(image.mask?.object).toMatch(/ 0 R$/);
    const png = decodePng(fs.readFileSync(path.join(out, image.file!)));
    expect(png.colorType).toBe(6);
    expect(pixel(png, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(png, 7, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(png, 0, 3)[3]).toBe(0);
  });

  it("writes Indexed as a palette PNG, CMYK and Separation as RGB", async () => {
    const { out, payload } = await extract();
    const indexed = payload.images.find((entry) => entry.name === "Im3")!;
    expect(indexed.colorSpace).toBe("Indexed(DeviceRGB,1)");
    const palette = decodePng(fs.readFileSync(path.join(out, indexed.file!)));
    expect(palette.colorType).toBe(3);
    expect(pixel(palette, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(palette, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(palette, 0, 1)).toEqual([0, 255, 0, 255]);

    const cmyk = payload.images.find((entry) => entry.name === "Im4")!;
    expect(cmyk.colorSpace).toBe("DeviceCMYK");
    const cmykPng = decodePng(fs.readFileSync(path.join(out, cmyk.file!)));
    // Row 2 is PNG-Up-predicted from row 1, so both rows read the same.
    expect(pixel(cmykPng, 0, 0)).toEqual([0, 255, 255, 255]);
    expect(pixel(cmykPng, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(cmykPng, 0, 1)).toEqual([0, 255, 255, 255]);

    const separation = payload.images.find((entry) => entry.name === "Im10")!;
    expect(separation.colorSpace).toBe("Separation(Spot)");
    const tinted = decodePng(fs.readFileSync(path.join(out, separation.file!)));
    expect(pixel(tinted, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(tinted, 1, 0)).toEqual([255, 0, 0, 255]);
  });

  it("writes a stencil mask as 1-bit black on white", async () => {
    const { out, payload } = await extract();
    const mask = payload.images.find((entry) => entry.name === "Im5")!;
    expect(mask.imageMask).toBe(true);
    expect(mask.colorSpace).toBeNull();
    const png = decodePng(fs.readFileSync(path.join(out, mask.file!)));
    expect(png.bitDepth).toBe(1);
    expect(pixel(png, 3, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(png, 3, 7)).toEqual([255, 255, 255, 255]);
  });

  it("follows a form XObject's matrix and reports the chain", async () => {
    const { out, payload } = await extract();
    const nested = payload.images.find((entry) => entry.name === "Im6")!;
    expect(nested.forms).toEqual(["Fm1"]);
    expect(nested.filters).toEqual(["ASCIIHexDecode", "FlateDecode"]);
    // Page cm 72,400, then the form's /Matrix shifts 100 right, then a 20pt image.
    expect(nested.box).toEqual([172, 400, 192, 420]);
    const png = decodePng(fs.readFileSync(path.join(out, nested.file!)));
    expect([0, 1, 2, 3].map((index) => pixel(png, index % 2, index >> 1)[0])).toEqual([
      0, 85, 170, 255,
    ]);
  });

  it("reads inline images, including one whose bytes contain EI", async () => {
    const { out, payload } = await extract();
    const [gray, rgb] = payload.images.filter((entry) => entry.inline);
    expect(gray.object).toBeNull();
    expect(gray.colorSpace).toBe("DeviceGray");
    expect(gray.box).toEqual([400, 400, 430, 430]);
    const grayPng = decodePng(fs.readFileSync(path.join(out, gray.file!)));
    expect(pixel(grayPng, 3, 0)[0]).toBe(255);
    expect(pixel(grayPng, 0, 1)[0]).toBe(0x45);
    expect(rgb.filters).toEqual(["ASCIIHexDecode"]);
    const rgbPng = decodePng(fs.readFileSync(path.join(out, rgb.file!)));
    expect(pixel(rgbPng, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(rgbPng, 1, 0)).toEqual([0, 255, 0, 255]);
  });

  it("decodes LZW and RunLength", async () => {
    const { out, payload } = await extract();
    const lzw = decodePng(
      fs.readFileSync(path.join(out, payload.images.find((entry) => entry.name === "Im8")!.file!)),
    );
    expect([0, 1, 2, 3].map((x) => pixel(lzw, x, 0)[0])).toEqual([10, 20, 10, 20]);
    const rle = decodePng(
      fs.readFileSync(path.join(out, payload.images.find((entry) => entry.name === "Im9")!.file!)),
    );
    expect([0, 1, 2, 3].map((x) => pixel(rle, x, 0)[0])).toEqual([7, 9, 200, 200]);
  });

  it("indexes but does not write images below --min-size", async () => {
    const { out, payload } = await extract("--min-size", "3");
    const tiny = payload.images.filter((entry) => entry.skipped === "min-size");
    // Im7 (1x1), Im10 (2x1), Im6 (2x2), the AHx inline (2x1), Im4 (2x2), Im8, Im9 (4x1).
    expect(tiny.map((entry) => entry.name ?? "inline").sort()).toEqual(
      ["Im10", "Im4", "Im6", "Im7", "Im8", "Im9", "inline"].sort(),
    );
    for (const entry of tiny) expect(entry.file).toBeUndefined();
    expect(fs.readdirSync(out).sort()).not.toContain("img-p001-08.png");
  });

  it("restricts to --pages and produces identical bytes on a second run", async () => {
    const first = await extract("--pages", "2");
    expect(first.payload.images.map((entry) => entry.page)).toEqual([2, 2]);
    const second = await extract("--pages", "2");
    expect(second.payload.images.map((entry) => entry.sha256)).toEqual(
      first.payload.images.map((entry) => entry.sha256),
    );
  });

  it("blocks on the colour conversions under --strict", async () => {
    const { payload, result } = await extract("--strict");
    expect(result.exitCode).toBe(2);
    expect(payload.ok).toBe(false);
  });

  it("requires --out and refuses a file in its place", async () => {
    const missing = await run("pdf", "images", fixture("images"));
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/--out/);
    const root = workspace();
    const file = write(root, "taken", Buffer.from("x"));
    const refused = await run("pdf", "images", fixture("images"), "--out", file);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/not a directory/);
  });

  it("reports a document with no images as an empty list", async () => {
    const out = path.join(workspace(), "none");
    const result = await run("pdf", "images", fixture("minimal"), "--out", out, "-fj");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).images).toEqual([]);
  });
});

describe("pdf render", () => {
  it("renders a box in user space to exactly that area, deterministically", async () => {
    const root = workspace();
    const file = fixture("vector");
    const first = path.join(root, "red.png");
    const result = await run(
      "pdf",
      "render",
      file,
      "--page",
      "1",
      "--box",
      "100,100,200,200",
      "--dpi",
      "72",
      "--out",
      first,
      "-fj",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    validate(payload, "pdf render");
    expect(payload.render).toMatchObject({
      page: 1,
      dpi: 72,
      width: 100,
      height: 100,
      box: [100, 100, 200, 200],
      pageBox: [0, 0, 612, 792],
      rotation: 0,
      file: first,
    });
    const png = decodePng(fs.readFileSync(first));
    expect([png.width, png.height]).toEqual([100, 100]);
    expect(pixel(png, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(png, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(payload.render.sha256).toBe(
      crypto.createHash("sha256").update(fs.readFileSync(first)).digest("hex"),
    );

    // A second process, the same arguments: the same bytes.
    const second = path.join(root, "red-again.png");
    await run(
      "pdf",
      "render",
      file,
      "--page",
      "1",
      "--box",
      "100,100,200,200",
      "--dpi",
      "72",
      "--out",
      second,
    );
    expect(fs.readFileSync(second).equals(fs.readFileSync(first))).toBe(true);
  });

  it("scales with --dpi and places the origin at the bottom left", async () => {
    const root = workspace();
    const out = path.join(root, "page.png");
    const result = await run(
      "pdf",
      "render",
      fixture("vector"),
      "--page",
      "1",
      "--dpi",
      "36",
      "--out",
      out,
      "-fj",
    );
    expect(result.exitCode).toBe(0);
    const png = decodePng(fs.readFileSync(out));
    expect([png.width, png.height]).toEqual([306, 396]);
    // The red square at user y 100–200 is near the bottom of the image.
    expect(pixel(png, 75, 396 - 75)).toEqual([255, 0, 0, 255]);
    // The blue one at x 300–400, y 400–500.
    expect(pixel(png, 175, 396 - 225)).toEqual([0, 0, 255, 255]);
    expect(pixel(png, 10, 10)).toEqual([255, 255, 255, 255]);
  });

  it("takes the box in unrotated user space on a rotated page", async () => {
    const root = workspace();
    const out = path.join(root, "blue.png");
    const result = await run(
      "pdf",
      "render",
      fixture("vectorRotated"),
      "--page",
      "1",
      "--box",
      "300,400,400,500",
      "--dpi",
      "72",
      "--out",
      out,
      "-fj",
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.render.rotation).toBe(90);
    expect(payload.render.box).toEqual([300, 400, 400, 500]);
    const png = decodePng(fs.readFileSync(out));
    expect(pixel(png, 50, 50)).toEqual([0, 0, 255, 255]);
  });

  it("clips a box to the page and refuses one that misses it", async () => {
    const root = workspace();
    const clipped = await run(
      "pdf",
      "render",
      fixture("vector"),
      "--page",
      "1",
      "--box",
      "-100,-100,50,50",
      "--dpi",
      "72",
      "--out",
      path.join(root, "corner.png"),
      "-fj",
    );
    expect(clipped.exitCode).toBe(0);
    const payload = JSON.parse(clipped.stdout);
    expect(payload.render.box).toEqual([0, 0, 50, 50]);
    expect(payload.diagnostics.map((item: { code: string }) => item.code)).toEqual(["AP452"]);

    const missed = await run(
      "pdf",
      "render",
      fixture("vector"),
      "--page",
      "1",
      "--box",
      "700,0,800,100",
      "--out",
      path.join(root, "nothing.png"),
      "-fj",
    );
    expect(missed.exitCode).toBe(1);
    expect(JSON.parse(missed.stdout).diagnostics[0].code).toBe("AP451");
    expect(fs.existsSync(path.join(root, "nothing.png"))).toBe(false);
  });

  it("refuses a bad page, box, dpi, and an oversized render", async () => {
    const root = workspace();
    const file = fixture("vector");
    const out = path.join(root, "x.png");
    const page = await run("pdf", "render", file, "--page", "9", "--out", out, "-fj");
    expect(page.exitCode).toBe(1);
    expect(JSON.parse(page.stdout).diagnostics[0].code).toBe("AP013");
    const box = await run("pdf", "render", file, "--page", "1", "--box", "1,2,3", "--out", out);
    expect(box.exitCode).toBe(1);
    expect(box.stderr).toMatch(/--box/);
    const dpi = await run("pdf", "render", file, "--page", "1", "--dpi", "5000", "--out", out);
    expect(dpi.exitCode).toBe(1);
    const large = await run(
      "pdf",
      "render",
      file,
      "--page",
      "1",
      "--dpi",
      "1200",
      "--out",
      out,
      "-fj",
    );
    expect(large.exitCode).toBe(1);
    expect(JSON.parse(large.stdout).diagnostics[0].code).toBe("AP453");
  });

  it("cuts out exactly the box pdf images reports for a placement", async () => {
    const root = workspace();
    const file = fixture("images");
    const listed = await run("pdf", "images", file, "--out", path.join(root, "figures"), "-fj");
    const jpeg = (JSON.parse(listed.stdout).images as ImageEntry[])[0];
    const out = path.join(root, "figure.png");
    const result = await run(
      "pdf",
      "render",
      file,
      "--page",
      "1",
      "--box",
      jpeg.box.join(","),
      "--dpi",
      "72",
      "--out",
      out,
      "-fj",
    );
    const payload = JSON.parse(result.stdout);
    expect(payload.render.box).toEqual(jpeg.box);
    const png = decodePng(fs.readFileSync(out));
    expect([png.width, png.height]).toEqual([160, 80]);
    // The JPEG's left half is red and its right half blue, give or take compression.
    const [r, , b] = pixel(png, 40, 40);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
    const [r2, , b2] = pixel(png, 120, 40);
    expect(r2).toBeLessThan(60);
    expect(b2).toBeGreaterThan(200);
  });
});

/** A stand-in engine: answers --version and --list-langs, and prints fixed TSV for any page. */
function fakeTesseract(root: string, words: string): string {
  const script = path.join(root, "tesseract");
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "1\t1\t0\t0\t0\t0\t0\t0\t1275\t1650\t-1\t",
    ...words.split("\n"),
  ].join("\\n");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "tesseract 9.9.9-fake"; exit 0 ;;',
      '  --list-langs) echo "List of available languages in \\"/fake/tessdata/\\" (2):"; echo eng; echo osd; exit 0 ;;',
      "esac",
      "cat > /dev/null",
      `printf '${tsv}\\n'`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

describe("pdf ocr", () => {
  it("recognises only pages with no text layer, marking every page as recognised", async () => {
    const root = workspace();
    const engine = fakeTesseract(
      root,
      [
        "5\t1\t1\t1\t1\t1\t150\t150\t300\t75\t96.5\tScanned",
        "5\t1\t1\t1\t1\t2\t500\t150\t200\t75\t50.5\ttext",
      ].join("\n"),
    );
    const file = write(root, "scan.pdf", await scannedPdf());
    const out = path.join(root, "scan.ocr.json");
    const result = await run(
      "pdf",
      "ocr",
      file,
      "--tesseract",
      engine,
      "--dpi",
      "150",
      "--out",
      out,
      "-fj",
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    validate(payload, "pdf ocr");
    expect(JSON.parse(fs.readFileSync(out, "utf8")).ocr).toEqual(payload.ocr);
    expect(payload.ocr.engine).toEqual({
      name: "tesseract",
      version: "9.9.9-fake",
      languages: ["eng"],
      dpi: 150,
      psm: 3,
    });
    const [page] = payload.ocr.pages;
    expect(page).toMatchObject({
      page: 1,
      source: "ocr",
      textLayer: "absent",
      text: "Scanned text",
    });
    // Weighted by length: (96.5*7 + 50.5*4) / 11.
    expect(page.confidence).toBe(79.8);
    // 150 dpi: pixel 150,150 is 72,72 points from the top left; the page is 792 tall.
    expect(page.words[0]).toEqual({ text: "Scanned", confidence: 96.5, box: [72, 684, 216, 720] });

    const text = await run("pdf", "ocr", file, "--tesseract", engine, "--dpi", "150");
    expect(text.stdout).toBe(
      "[recognised text: page 1, tesseract 9.9.9-fake eng, confidence 79.8]\nScanned text\n",
    );
  });

  it("leaves pages with a text layer alone unless named, and never merges", async () => {
    const root = workspace();
    const engine = fakeTesseract(root, "5\t1\t1\t1\t1\t1\t10\t10\t10\t10\t90\tword");
    const file = fixture("minimal");
    const none = await run("pdf", "ocr", file, "--tesseract", engine, "-fj");
    expect(none.exitCode).toBe(0);
    const payload = JSON.parse(none.stdout);
    expect(payload.ocr.pages).toEqual([]);
    expect(payload.diagnostics.map((item: { code: string }) => item.code)).toEqual(["AP475"]);

    const named = JSON.parse(
      (await run("pdf", "ocr", file, "--pages", "1", "--tesseract", engine, "-fj")).stdout,
    );
    expect(named.ocr.pages[0].textLayer).toBe("present");
    expect(named.diagnostics.map((item: { code: string }) => item.code)).toEqual(["AP474"]);
  });

  it("reports low confidence and an empty page, blocking only under --strict", async () => {
    const root = workspace();
    const low = fakeTesseract(root, "5\t1\t1\t1\t1\t1\t10\t10\t10\t10\t20\tblur");
    const file = write(root, "scan.pdf", await scannedPdf());
    const lenient = await run("pdf", "ocr", file, "--tesseract", low, "-fj");
    expect(lenient.exitCode).toBe(0);
    expect(
      JSON.parse(lenient.stdout).diagnostics.map((item: { code: string }) => item.code),
    ).toEqual(["AP473"]);
    const strict = await run("pdf", "ocr", file, "--tesseract", low, "--strict", "-fj");
    expect(strict.exitCode).toBe(2);

    const emptyRoot = workspace();
    const empty = fakeTesseract(emptyRoot, "");
    const blank = JSON.parse((await run("pdf", "ocr", file, "--tesseract", empty, "-fj")).stdout);
    expect(blank.ocr.pages[0].confidence).toBeNull();
    expect(blank.diagnostics.map((item: { code: string }) => item.code)).toEqual(["AP472"]);
  });

  it("reports a missing engine and missing language data before reading any page", async () => {
    const root = workspace();
    const file = write(root, "scan.pdf", await scannedPdf());
    const missing = await run("pdf", "ocr", file, "--tesseract", path.join(root, "nope"), "-fj");
    expect(missing.exitCode).toBe(1);
    const payload = JSON.parse(missing.stdout);
    validate(payload, "ocr failure");
    expect(payload.diagnostics[0].code).toBe("AP470");
    expect(payload.diagnostics[0].remediation).toMatch(/install/i);

    const engine = fakeTesseract(root, "");
    const language = await run("pdf", "ocr", file, "--tesseract", engine, "--lang", "deu", "-fj");
    expect(language.exitCode).toBe(1);
    expect(JSON.parse(language.stdout).diagnostics[0].code).toBe("AP471");
  });

  it.skipIf(!hasTesseract)("reads the scanned fixture with the installed engine", async () => {
    const root = workspace();
    const file = write(root, "scan.pdf", await scannedPdf());
    const result = await run("pdf", "ocr", file, "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    const [page] = payload.ocr.pages;
    expect(page.source).toBe("ocr");
    for (const line of SCANNED_LINES) expect(page.text).toContain(line);
    expect(page.confidence).toBeGreaterThan(80);
    // The first word sits where the generator drew it: x 72, baseline y 680, 32pt.
    const first = page.words[0];
    expect(first.text).toBe("SCANNED");
    expect(first.box[0]).toBeGreaterThan(68);
    expect(first.box[0]).toBeLessThan(80);
    expect(first.box[1]).toBeGreaterThan(670);
    expect(first.box[3]).toBeLessThan(715);
    // Same input, same engine: same output.
    const again = JSON.parse((await run("pdf", "ocr", file, "-fj")).stdout);
    expect(again.ocr).toEqual(payload.ocr);
  });
});
