import assert from "node:assert/strict";
import { it } from "vitest";
import { KeyDecoder } from "../../../src/qa/keys.js";

const decode = (...chunks: string[]): string[] => {
  const d = new KeyDecoder();
  const keys: string[] = [];
  for (const c of chunks) keys.push(...d.push(c));
  keys.push(...d.flush());
  return keys;
};

it("plain characters pass straight through", () => {
  assert.deepEqual(decode("q"), ["q"]);
  assert.deepEqual(decode("qp"), ["q", "p"]);
  assert.deepEqual(decode("\x03"), ["\x03"], "Ctrl-C arrives as a byte in raw mode");
});

it("a pasted astral character is not split into surrogates", () => {
  assert.deepEqual(decode("📋"), ["📋"]);
});

it("CSI arrows and paging keys", () => {
  assert.deepEqual(decode("\x1b[A"), ["up"]);
  assert.deepEqual(decode("\x1b[B"), ["down"]);
  assert.deepEqual(decode("\x1b[C"), ["right"]);
  assert.deepEqual(decode("\x1b[D"), ["left"]);
  assert.deepEqual(decode("\x1b[H"), ["home"]);
  assert.deepEqual(decode("\x1b[F"), ["end"]);
  assert.deepEqual(decode("\x1b[5~"), ["pgup"]);
  assert.deepEqual(decode("\x1b[6~"), ["pgdn"]);
  assert.deepEqual(decode("\x1b[1~"), ["home"]);
  assert.deepEqual(decode("\x1b[4~"), ["end"]);
});

it("SS3 arrows (application cursor mode)", () => {
  assert.deepEqual(decode("\x1bOA"), ["up"]);
  assert.deepEqual(decode("\x1bOF"), ["end"]);
  assert.deepEqual(decode("\x1bOZ"), [], "unknown SS3 final is consumed");
});

it("modified sequences still resolve to the base key", () => {
  assert.deepEqual(decode("\x1b[1;5A"), ["up"], "Ctrl-Up");
  assert.deepEqual(decode("\x1b[1;2D"), ["left"], "Shift-Left");
});

it("a sequence split across reads is reassembled", () => {
  assert.deepEqual(decode("\x1b", "[A"), ["up"]);
  assert.deepEqual(decode("\x1b[", "A"), ["up"]);
  assert.deepEqual(decode("\x1b", "[", "5", "~"), ["pgup"]);
});

it('a lone ESC only becomes "esc" on flush', () => {
  const d = new KeyDecoder();
  assert.deepEqual(d.push("\x1b"), [], "held, in case a sequence follows");
  assert.equal(d.pending, true);
  assert.deepEqual(d.flush(), ["esc"]);
  assert.equal(d.pending, false);
});

it("flush does not fire for a partial sequence that is not a bare ESC", () => {
  const d = new KeyDecoder();
  d.push("\x1b[");
  assert.deepEqual(d.flush(), []);
});

it("ESC followed by a non-CSI byte is an immediate esc", () => {
  assert.deepEqual(decode("\x1bX"), ["esc", "X"]);
});

it("unknown CSI finals are consumed rather than looping", () => {
  assert.deepEqual(decode("\x1b[999X"), []);
  assert.deepEqual(decode("\x1b[999Xq"), ["q"], "and the stream keeps moving");
  // '?' is neither a digit nor ';', so only ESC [ ? is consumed and the rest is literal.
  assert.deepEqual(decode("\x1b[?1049h"), ["1", "0", "4", "9", "h"]);
});
