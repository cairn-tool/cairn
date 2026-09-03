import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_INPUT_BYTES, parsePageRange, readInput } from "../../src/pdf/read.js";
import { buildPdf, PDF_FIXTURES, pdfFixture } from "../helpers/pdf-fixture.js";

/**
 * The reader has no pdfjs dependency at all, so it is testable on its own and
 * ships before the parser matters.
 */

const temporary: string[] = [];

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

function write(name: string, bytes: Uint8Array | string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-read-"));
  temporary.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

const limits = { maxBytes: MAX_INPUT_BYTES };

describe("readInput", () => {
  it("reads a PDF and reports no notices", async () => {
    const result = await readInput(write("a.pdf", pdfFixture("minimal")), limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.notices).toEqual([]);
  });

  it("returns a buffer it exclusively owns", async () => {
    // getDocument() transfers and detaches what it is given, and Node buffers
    // under 8 KiB are views into a shared pool — handing one over would detach
    // memory other parts of the process are still using.
    const result = await readInput(write("a.pdf", pdfFixture("minimal")), limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes.byteOffset).toBe(0);
    expect(result.bytes.buffer.byteLength).toBe(result.bytes.byteLength);
  });

  it("refuses a file with no %PDF- signature, naming the leading bytes", async () => {
    const result = await readInput(write("a.pdf", "this is not a pdf\n"), limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AP002");
    expect(result.diagnostic.message).toContain("74 68 69 73");
  });

  it("accepts a signature at a non-zero offset and says so", async () => {
    // Never stripped: the cross-reference offsets are measured from the start of
    // the file as it stands, so slicing the prefix would invalidate all of them.
    const padded = Buffer.concat([Buffer.from("junk\n"), pdfFixture("minimal")]);
    const result = await readInput(write("a.pdf", padded), limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notices.map((item) => item.code)).toEqual(["AP007"]);
    expect(result.bytes.byteLength).toBe(padded.byteLength);
  });

  it("refuses an empty file distinctly from a non-PDF", async () => {
    const result = await readInput(write("a.pdf", ""), limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AP006");
  });

  it("refuses a file past the cap, and names the flag that raises it", async () => {
    const result = await readInput(write("a.pdf", pdfFixture("minimal")), { maxBytes: 32 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AP003");
    expect(result.diagnostic.remediation).toContain("--max-bytes");
  });

  it("refuses a directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-read-"));
    temporary.push(root);
    const result = await readInput(root, limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AP004");
  });

  it("refuses a missing file", async () => {
    const result = await readInput(path.join(os.tmpdir(), "definitely-absent.pdf"), limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AP004");
  });
});

describe("parsePageRange", () => {
  it("parses singles, ranges, and open ends", () => {
    for (const [spec, expected] of [
      ["1", [1]],
      ["1,3", [1, 3]],
      ["2-4", [2, 3, 4]],
      ["-3", [1, 2, 3]],
      ["8-", [8, 9, 10]],
      ["1,3,5-7", [1, 3, 5, 6, 7]],
    ] as const) {
      const result = parsePageRange(spec, 10);
      expect(result.ok, spec).toBe(true);
      if (result.ok) expect(result.pages, spec).toEqual([...expected]);
    }
  });

  it("emits ascending and deduplicated regardless of how it was written", () => {
    // Determinism, not convenience: `--pages 5,1` and `--pages 1,5` have to
    // produce byte-identical output.
    const scrambled = parsePageRange("5,1,3,1,4-5", 10);
    expect(scrambled.ok).toBe(true);
    if (scrambled.ok) expect(scrambled.pages).toEqual([1, 3, 4, 5]);
  });

  it("refuses a page outside the document rather than clamping", () => {
    const result = parsePageRange("5-9", 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AP013");
    expect(result.diagnostic.remediation).toContain("1 page(s)");
  });

  it("refuses page 0, a backwards range, and junk", () => {
    for (const spec of ["0", "0-2", "4-2", "abc", "1,,2", "1-2-3", ""]) {
      const result = parsePageRange(spec, 10);
      expect(result.ok, spec).toBe(false);
    }
  });
});

describe("the fixture builder", () => {
  it("produces byte-identical output for the same spec", () => {
    // Nothing in the builder may depend on a clock, a counter, or iteration
    // order, or every fixture-driven assertion becomes flaky.
    expect(buildPdf(PDF_FIXTURES.structured).equals(buildPdf(PDF_FIXTURES.structured))).toBe(true);
  });

  it("writes cross-reference entries exactly 20 bytes wide", () => {
    const text = pdfFixture("minimal").toString("latin1");
    // `lastIndexOf("xref")` finds `startxref`, which has no entries under it.
    const table = text.slice(text.indexOf("\nxref\n"));
    const entries = table.match(/^\d{10} \d{5} [nf] $/gm) ?? [];
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) expect(`${entry}\n`.length).toBe(20);
  });
});
