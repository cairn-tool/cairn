import assert from "node:assert/strict";
import { it } from "vitest";
import { Screen } from "../../../src/qa/screen.js";

/** The Screen with no TTY behind it — handleKey is pure state, which is what is under test. */
const screen = (visible: number[]): Screen => {
  const s = new Screen(false);
  s.visibleSlots = visible;
  return s;
};

const noop = { requestStop: () => {}, requestDrain: () => {}, togglePause: () => {} };

it("a digit zooms the pane at that screen position, not that slot id", () => {
  // Slots 0 and 1 finished; 2, 5 and 7 are what is on screen, numbered 1, 2, 3.
  const s = screen([2, 5, 7]);
  s.handleKey("1", noop);
  assert.equal(s.zoom, 2, "the first pane on screen is slot 2");
  s.handleKey("3", noop);
  assert.equal(s.zoom, 7, "the third is slot 7");
});

it("the same digit again unzooms", () => {
  const s = screen([2, 5, 7]);
  s.handleKey("2", noop);
  assert.equal(s.zoom, 5);
  s.handleKey("2", noop);
  assert.equal(s.zoom, null);
});

it("a digit past the visible panes does nothing", () => {
  const s = screen([2, 5]);
  s.handleKey("5", noop);
  assert.equal(s.zoom, null, "no fifth pane to zoom");
  s.handleKey("9", noop);
  assert.equal(s.zoom, null);
});

it("zoom stays pinned to its slot as the pane list reflows", () => {
  const s = screen([2, 5, 7]);
  s.handleKey("3", noop);
  assert.equal(s.zoom, 7);
  // Slot 2 finished; slot 7 is now second on screen. The zoom must not jump to a different case.
  s.visibleSlots = [5, 7];
  assert.equal(s.zoom, 7, "still the same slot");
  s.handleKey("2", noop);
  assert.equal(s.zoom, null, "and its new digit is the one that unzooms it");
});

it("0 and esc unzoom", () => {
  for (const key of ["0", "esc"]) {
    const s = screen([2, 5]);
    s.handleKey("1", noop);
    s.handleKey(key, noop);
    assert.equal(s.zoom, null, key);
  }
});

it("digits are inert in the table view", () => {
  const s = screen([2, 5]);
  s.mode = "table";
  s.handleKey("1", noop);
  assert.equal(s.zoom, null);
});
