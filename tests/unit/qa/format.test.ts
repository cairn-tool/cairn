import assert from "node:assert/strict";
import { it } from "vitest";
import {
  RESET,
  charWidth,
  clipAnsi,
  displayWidth,
  flatten,
  fmtBytes,
  fmtCount,
  fmtDuration,
  invertBar,
  isBlank,
  padClip,
  pyStrip,
  wrapAnsi,
} from "../../../src/qa/format.js";

const cp = (s: string): number => s.codePointAt(0)!;

it("charWidth matches unicodedata-derived rules", () => {
  assert.equal(charWidth(cp("a")), 1);
  assert.equal(charWidth(cp("あ")), 2, "East Asian Wide");
  assert.equal(charWidth(cp("Ａ")), 2, "Fullwidth");
  assert.equal(charWidth(cp("́")), 0, "Mn combining acute");
  assert.equal(charWidth(cp("​")), 0, "Cf zero-width space");
  assert.equal(charWidth(cp("️")), 0, "Mn variation selector");
  assert.equal(charWidth(0), 0, "NUL");
  assert.equal(charWidth(0x01), 0, "C0 control");
  assert.equal(charWidth(0x7f), 0, "DEL");
  assert.equal(charWidth(0x9f), 0, "C1 control");
  assert.equal(charWidth(0xa0), 1, "NBSP is printable");
  assert.equal(charWidth(cp("—")), 1, "em dash is ambiguous -> narrow");
  assert.equal(charWidth(cp("✅")), 2);
  assert.equal(charWidth(cp("📋")), 2, "astral, via the >= 0x1F300 rule");
});

it("the warning marker is ONE cell, not two", () => {
  // U+26A0 is ambiguous (1) and U+FE0F is Mn (0). string-width would say 2 and
  // misalign every tracker row that carries this glyph.
  assert.equal(displayWidth("⚠️"), 1);
});

it("displayWidth ignores CSI sequences", () => {
  assert.equal(displayWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(displayWidth("\x1b[1m\x1b[32mab\x1b[0m"), 2);
  assert.equal(displayWidth(""), 0);
});

it("clipAnsi never exceeds the width and always resets", () => {
  for (const text of ["plain text", "\x1b[31mred text\x1b[0m", "あいうえお", "📋📋📋"]) {
    for (let w = 0; w <= 12; w += 1) {
      const out = clipAnsi(text, w);
      assert.ok(displayWidth(out) <= w, `${JSON.stringify(out)} fits in ${w}`);
      assert.ok(out.endsWith(RESET), "always ends with RESET");
    }
  }
  assert.equal(clipAnsi("anything", 0), RESET);
});

it("clipAnsi does not split a wide glyph across the boundary", () => {
  assert.equal(displayWidth(clipAnsi("あああ", 3)), 2, "stops rather than half-render");
});

it("invertBar is exactly width cells and re-opens reverse after an embedded RESET", () => {
  const bar = invertBar(`a${RESET}b`, 10);
  assert.equal(displayWidth(bar), 10);
  assert.ok(bar.includes(RESET + "\x1b[7m"), "reverse re-opened after the inner reset");
});

it("padClip pads short input and clips long input", () => {
  assert.equal(displayWidth(padClip("ab", 6)), 6);
  assert.equal(displayWidth(padClip("abcdefghij", 4)), 4);
});

it("wrapAnsi loses no visible characters and respects the width", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  for (const width of [5, 8, 13, 20, 43, 44]) {
    const lines = wrapAnsi(text, width);
    for (const line of lines) assert.ok(displayWidth(line) <= width, `line fits in ${width}`);
    assert.equal(
      lines.join(" ").replace(/\s+/g, " ").trim(),
      text,
      `no words lost at width ${width}`,
    );
  }
});

it("wrapAnsi hard-breaks a token longer than the width", () => {
  // Matches the Python exactly: the token is split into width-sized chunks rather than
  // being given a line of its own.
  assert.deepEqual(wrapAnsi("ab supercalifragilistic cd", 6), [
    "ab",
    "superc",
    "alifra",
    "gilist",
    "ic cd",
  ]);
});

it("wrapAnsi keeps a line that is only ANSI", () => {
  const lines = wrapAnsi(`\x1b[31m${" ".repeat(40)}\x1b[0m`, 10);
  assert.ok(lines.length > 0);
});

it("wrapAnsi returns [] for width < 1 and [] for empty input", () => {
  assert.deepEqual(wrapAnsi("abc", 0), []);
  assert.deepEqual(wrapAnsi("", 10), []);
});

it("fmtDuration switches to hours only past 3600s", () => {
  assert.equal(fmtDuration(0), "00:00");
  assert.equal(fmtDuration(59), "00:59");
  assert.equal(fmtDuration(60), "01:00");
  assert.equal(fmtDuration(3599), "59:59");
  assert.equal(fmtDuration(3600), "1:00:00");
  assert.equal(fmtDuration(7261), "2:01:01");
  assert.equal(fmtDuration(-5), "00:00", "negatives clamp to zero");
});

it("fmtCount and fmtBytes switch at the thousand boundaries", () => {
  assert.equal(fmtCount(999), "999");
  assert.equal(fmtCount(1000), "1.0k");
  assert.equal(fmtCount(1050), "1.1k", "rounds the real double, not a pre-scaled one");
  assert.equal(fmtCount(999999), "1000.0k");
  assert.equal(fmtCount(1_000_000), "1.0M");
  assert.equal(fmtBytes(945), "945 B");
  assert.equal(fmtBytes(12_300), "12 KB");
  assert.equal(fmtBytes(1_500_000), "1.5 MB");
});

it("flatten collapses Python whitespace but leaves the BOM alone", () => {
  assert.equal(flatten("  a \n\t b  "), "a b");
  assert.equal(flatten("a\x1cb"), "a b", "Python \\s covers \\x1c-\\x1f");
  assert.equal(flatten("﻿"), "﻿", "JS \\s matches the BOM; Python does not");
});

it("isBlank and pyStrip use the Python whitespace set", () => {
  assert.equal(isBlank(""), true);
  assert.equal(isBlank(" \t\n\x1f"), true);
  assert.equal(isBlank("﻿"), false);
  assert.equal(isBlank("x"), false);
  assert.equal(pyStrip("  ab  "), "ab");
  assert.equal(pyStrip("\x85ab\x85"), "ab");
});
