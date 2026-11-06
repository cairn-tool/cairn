import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canvasAnchors, loadCanvas, resolveCanvas } from "../../src/pdf/render.js";

/**
 * cairn must draw with the same `@napi-rs/canvas` module pdf.js loaded.
 *
 * pdf.js resolves the canvas from its own directory at import. A fresh install
 * of 6.4.0 put a second, newer copy under `pdfjs-dist/node_modules` while cairn
 * resolved its own top-level one, and two native Skia modules in one process
 * segfaulted every `pdf render` (exit 139). These tests fail if cairn's canvas
 * is ever not the module pdfjs-dist resolves.
 */

const require = createRequire(import.meta.url);
const temporary: string[] = [];
afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

function fakePackage(directory: string, name: string, body: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version: "0.0.0", main: "index.cjs" }),
  );
  fs.writeFileSync(path.join(directory, "index.cjs"), body);
}

/** `x.y.z` satisfies `^a.b.c` for a major above zero. Enough for the two ranges checked here. */
function satisfiesCaret(version: string, range: string): boolean {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) throw new Error(`not a caret range: ${range}`);
  const [major, minor, patch] = version.split(".").map(Number);
  const [rMajor, rMinor, rPatch] = match.slice(1).map(Number);
  if (major !== rMajor) return false;
  if (minor !== rMinor) return minor > rMinor;
  return patch >= rPatch;
}

describe("the canvas cairn draws with", () => {
  it("is the very module pdfjs-dist resolves", () => {
    const fromPdfjs = createRequire(require.resolve("pdfjs-dist/package.json"))("@napi-rs/canvas");
    expect(loadCanvas()).toBe(fromPdfjs);
  });

  /** A constructed install: cairn, pdfjs-dist, a top-level canvas, and optionally one nested under pdfjs-dist. */
  function install(nested: boolean): { modules: string; from: string } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-canvas-")));
    temporary.push(root);
    const modules = path.join(root, "node_modules");
    fakePackage(path.join(modules, "pdfjs-dist"), "pdfjs-dist", "module.exports = {};");
    if (nested)
      fakePackage(
        path.join(modules, "pdfjs-dist", "node_modules", "@napi-rs", "canvas"),
        "@napi-rs/canvas",
        'module.exports = { copy: "nested" };',
      );
    fakePackage(
      path.join(modules, "@napi-rs", "canvas"),
      "@napi-rs/canvas",
      'module.exports = { copy: "top" };',
    );
    const cairnModule = path.join(modules, "@cairn-tool", "cairn", "dist", "pdf", "render.js");
    fs.mkdirSync(path.dirname(cairnModule), { recursive: true });
    fs.writeFileSync(cairnModule, "");
    return { modules, from: pathToFileURL(cairnModule).href };
  }

  it("prefers the copy nested under pdfjs-dist over cairn's own", () => {
    // The 6.4.0 tree: cairn's top-level canvas, and a different one nested under pdfjs-dist.
    const { modules, from } = install(true);
    const anchors = canvasAnchors(from);
    expect(anchors[0]).toBe(path.join(modules, "pdfjs-dist", "package.json"));
    expect(resolveCanvas(anchors)).toEqual({ copy: "nested" });
  });

  it("finds the shared top-level copy through pdfjs-dist when npm deduped it", () => {
    const { from } = install(false);
    expect(resolveCanvas(canvasAnchors(from))).toEqual({ copy: "top" });
  });

  it("falls back to cairn's own resolution when pdfjs-dist cannot be found", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-canvas-")));
    temporary.push(root);
    const modules = path.join(root, "node_modules");
    fakePackage(
      path.join(modules, "@napi-rs", "canvas"),
      "@napi-rs/canvas",
      'module.exports = { copy: "own" };',
    );
    const from = pathToFileURL(path.join(root, "app.js")).href;
    expect(canvasAnchors(from)).toEqual([from]);
    expect(resolveCanvas(canvasAnchors(from))).toEqual({ copy: "own" });
  });

  it("declares a canvas range npm can share with pdfjs-dist", () => {
    // A range that excludes what pdfjs-dist resolves forces npm to install two copies.
    const ours = JSON.parse(fs.readFileSync("package.json", "utf8")).optionalDependencies[
      "@napi-rs/canvas"
    ] as string;
    const pdfjs = JSON.parse(fs.readFileSync(require.resolve("pdfjs-dist/package.json"), "utf8"));
    const theirs = pdfjs.optionalDependencies["@napi-rs/canvas"] as string;
    const resolved = JSON.parse(
      fs.readFileSync(
        createRequire(require.resolve("pdfjs-dist/package.json")).resolve(
          "@napi-rs/canvas/package.json",
        ),
        "utf8",
      ),
    ).version as string;
    expect(satisfiesCaret(resolved, theirs)).toBe(true);
    expect(satisfiesCaret(resolved, ours)).toBe(true);
  });
});
