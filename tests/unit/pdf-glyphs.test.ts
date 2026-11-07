import { describe, expect, it } from "vitest";
import { budgetSpent, type OpenDocument } from "../../src/pdf/document.js";
import {
  emptyGlyphReport,
  glyphDiagnostics,
  mapGlyphs,
  mergeGlyphReport,
  symbolFamily,
} from "../../src/pdf/glyphs.js";

describe("symbol-font glyphs", () => {
  it("names a font's family whatever its subset prefix and style", () => {
    expect(symbolFamily("ABCDEE+Symbol")).toBe("Symbol");
    expect(symbolFamily("SymbolMT")).toBe("Symbol");
    expect(symbolFamily("Symbol,Bold")).toBe("Symbol");
    expect(symbolFamily("Wingdings-Regular")).toBe("Wingdings");
    expect(symbolFamily("MT-Extra")).toBe("MT Extra");
    expect(symbolFamily("BVHMQK+MT Extra")).toBe("MT Extra");
    expect(symbolFamily("ZapfDingbats")).toBe("ZapfDingbats");
    expect(symbolFamily("Wingdings2")).toBeUndefined();
    expect(symbolFamily("Times New Roman")).toBeUndefined();
    expect(symbolFamily(undefined)).toBeUndefined();
  });

  it("reads each private-use byte through its font, and Adobe's Symbol pieces whatever the font", () => {
    const report = emptyGlyphReport();
    expect(mapGlyphs("\uf044V = \uf072\uf0b4g", "SymbolMT", report)).toBe("ΔV = ρ×g");
    expect(mapGlyphs("\uf0fc done \uf0a7 next", "Wingdings", report)).toBe("✔ done ▪ next");
    expect(mapGlyphs("\uf06c", "MT Extra", report)).toBe("ℓ");
    expect(mapGlyphs("\uf8eb\uf8ec\uf8ed", undefined, report)).toBe("⎛⎜⎝");
    expect(mapGlyphs("plain text", "SymbolMT", report)).toBe("plain text");
    expect(Object.fromEntries(report.mapped)).toEqual({ Symbol: 6, Wingdings: 2, "MT Extra": 1 });
    expect(report.unmapped.size).toBe(0);
  });

  it("leaves what it cannot read, and says which font and code points", () => {
    const page = emptyGlyphReport();
    expect(mapGlyphs("\uf050 and \uf0d7", "ABCDEE+Wingdings2", page)).toBe("\uf050 and \uf0d7");
    expect(mapGlyphs("\uf041", undefined, page)).toBe("\uf041");
    const doc = emptyGlyphReport();
    mergeGlyphReport(doc, page);
    mergeGlyphReport(doc, undefined);
    const [unmapped] = glyphDiagnostics(doc);
    expect(unmapped.code).toBe("AP052");
    expect(unmapped.message).toContain("Wingdings2 (U+F050 U+F0D7)");
    expect(unmapped.message).toContain("an unnamed font (U+F041)");
  });

  it("reports what was mapped by family", () => {
    const report = emptyGlyphReport();
    mapGlyphs("\uf044\uf0b7", "Symbol", report);
    const [mapped] = glyphDiagnostics(report);
    expect(mapped.code).toBe("AP051");
    expect(mapped.message).toMatch(/Mapped 2 .*Symbol 2$/);
  });
});

describe("a spent budget", () => {
  it("is one finding for the pages left, with the budget the rate so far needs", () => {
    const handle = { budgetMs: 30_000, elapsed: () => 30_000 } as unknown as OpenDocument;
    const finding = budgetSpent(handle, 798, 797, 1301);
    expect(finding.code).toBe("AP005");
    expect(finding.page).toBe(798);
    expect(finding.message).toContain("504 of 1301 page(s) were not read");
    expect(finding.message).toContain("38ms a page");
    expect(finding.remediation).toContain("--timeout 62000");
  });
});
