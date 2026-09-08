import assert from "node:assert/strict";
import { it } from "vitest";
import { displayWidth } from "../../../src/qa/format.js";
import {
  BLANK_METRICS,
  composeStatus,
  frame,
  headerFor,
  layoutPanes,
  layoutTable,
  shortcutsFor,
} from "../../../src/qa/layout.js";
import type { PanesOptions, PaneView, TableRow, ViewModel } from "../../../src/qa/layout.js";

const MODEL = "cursor-grok-4.6-high";

const pane = (i: number, over: Partial<PaneView> = {}): PaneView => ({
  slot: i,
  name: `tc-${i + 1}`,
  model: MODEL,
  status: "run",
  elapsedSeconds: 61,
  tools: 7,
  streamedBytes: 2048,
  usage: null,
  note: "",
  transcript: ["» something happened", "\x1b[36m! \x1b[0mRead  src/a.ts"],
  thinking: "",
  ...over,
});

const row = (n: number): TableRow => ({
  name: `tc-${n}`,
  status: "Done",
  outcome: "Passed",
  duration: "01:23",
  tools: "7",
  inn: "1.2k",
  out: "340",
  cache_r: "5.6k",
  cache_w: "0",
});

const totals: TableRow = {
  name: "Total",
  status: "—",
  outcome: "—",
  duration: "12:34",
  tools: "99",
  inn: "1.5M",
  out: "12.3k",
  cache_r: "999",
  cache_w: "0",
};

/** layoutPanes' options, with everything not under test defaulted. */
const opts = (over: Partial<PanesOptions> = {}): PanesOptions => ({
  running: 3,
  parallel: 8,
  queued: 12,
  paused: false,
  draining: false,
  note: "no agents running",
  zoom: null,
  ...over,
});

const panesOf = (n: number): PaneView[] => Array.from({ length: n }, (_, i) => pane(i));

const SIZES: [number, number][] = [
  [24, 80],
  [50, 120],
  [10, 40],
  [3, 20],
  [26, 80],
  [9, 60],
  [60, 200],
];

it("every pane frame line is exactly `cols` cells wide and there are exactly `rows`", () => {
  // The pane count is dynamic now, so the invariant has to hold at every count including zero.
  for (let n = 0; n <= 8; n += 1) {
    const panes = panesOf(n);
    for (const [rows, cols] of SIZES) {
      for (const zoom of [null, 0, 3]) {
        const lines = layoutPanes(panes, opts({ zoom }), rows, cols);
        assert.equal(lines.length, rows, `n=${n} ${rows}x${cols} zoom=${zoom} line count`);
        for (const line of lines) {
          assert.equal(displayWidth(line), cols, `n=${n} ${rows}x${cols} line width`);
        }
      }
    }
  }
});

it("compact mode kicks in exactly when rows-1 < n*3, at every pane count", () => {
  // The chrome row is taken off the top first, so the threshold is on `rows - 1`.
  const hint = "grow the window";
  const compact = (n: number, rows: number): boolean =>
    layoutPanes(panesOf(n), opts(), rows, 80).some((l) => l.includes(hint));
  for (const n of [1, 2, 3, 8]) {
    assert.equal(compact(n, n * 3), true, `n=${n}: rows-1 = ${n * 3 - 1} < ${n * 3}`);
    assert.equal(compact(n, n * 3 + 1), false, `n=${n}: rows-1 = ${n * 3}, not less`);
  }
});

it("zoom selects a single pane by slot id", () => {
  const panes = panesOf(8);
  const zoomed = layoutPanes(panes, opts({ zoom: 2 }), 30, 80);
  assert.ok(
    zoomed.some((l) => l.includes("tc-3")),
    "the zoomed pane is shown",
  );
  assert.ok(!zoomed.some((l) => l.includes("tc-1 ")), "others are not");
  const bad = layoutPanes(panes, opts({ zoom: 99 }), 30, 80);
  assert.ok(
    bad.some((l) => l.includes("tc-1")),
    "an out-of-range zoom falls back to all panes",
  );
});

it("zoom follows the slot, not the screen position", () => {
  // Slot 0 finished and left the list; slot 5 is now first on screen but keeps its identity.
  const remaining = [pane(5), pane(6)];
  const zoomed = layoutPanes(remaining, opts({ zoom: 5 }), 30, 80);
  assert.ok(
    zoomed.some((l) => l.includes("tc-6")),
    "the pane for slot 5 is still the zoomed one",
  );
  assert.ok(!zoomed.some((l) => l.includes("tc-7")), "the other pane is hidden");
  // Its header shows 01 — the digit you would press for it now that it is first.
  assert.ok(
    zoomed.some((l) => / 1 {2}tc-6/.test(l)),
    "numbered by position, not by slot",
  );
});

it("with no panes the region explains itself instead of going blank", () => {
  const lines = layoutPanes([], opts({ note: "waiting on tag: build" }), 20, 80);
  assert.equal(lines.length, 20);
  assert.ok(lines[1]?.includes("waiting on tag: build"));
  for (const line of lines) assert.equal(displayWidth(line), 80);
});

it("the chrome row counts agents and queued cases", () => {
  const head = layoutPanes(panesOf(3), opts({ running: 3, parallel: 8, queued: 12 }), 20, 80)[0]!;
  assert.ok(head.includes("3/8"), "running out of the cap");
  assert.ok(head.includes("12 queued"));
  assert.ok(head.includes("Run Everything"));
});

it("PAUSED and DRAINING appear in the chrome row", () => {
  const panes = [pane(0)];
  assert.ok(layoutPanes(panes, opts({ paused: true }), 20, 80)[0]?.includes("PAUSED"));
  assert.ok(layoutPanes(panes, opts({ draining: true }), 20, 80)[0]?.includes("DRAINING"));
});

it("headerFor right-aligns the pane's own model when there is room", () => {
  const width = 100;
  const line = headerFor(pane(0), 1, width);
  assert.equal(displayWidth(line), width, "fills the bar exactly");
  assert.ok(line.trimEnd().endsWith(MODEL), "model on the right");
  assert.ok(line.includes("tc-1 "), "run state still on the left");
  assert.match(line, / {2}cursor-grok-4\.6-high $/, "separated from the left text");
  assert.ok(
    headerFor(pane(0, { model: "composer-2.5" }), 1, width).includes("composer-2.5"),
    "each pane names its own model, not a shared one",
  );
});

it("headerFor drops the model rather than crowding a narrow pane", () => {
  assert.ok(headerFor(pane(0), 1, 45).includes(MODEL), "kept when it fits");
  assert.ok(!headerFor(pane(0), 1, 30).includes(MODEL), "dropped when it does not");
  assert.equal(headerFor(pane(0), 1, 30), headerFor(pane(0)), "falls back to the plain header");
});

it("headerFor omits the model for an idle pane", () => {
  const line = headerFor(pane(0, { name: null, status: "idle" }), 1, 100);
  assert.ok(!line.includes("cursor-grok"), "an idle pane is not running anything");
});

it("headerFor with no model is unchanged", () => {
  assert.equal(headerFor(pane(0, { model: "" }), 1, 100), headerFor(pane(0, { model: "" })));
});

it("headerFor numbers the pane by its screen position, not its slot", () => {
  assert.ok(/ 1 {2}tc-6/.test(headerFor(pane(5), 1)), "slot 5 shown first is numbered 01");
  assert.ok(/ 3 {2}tc-6/.test(headerFor(pane(5), 3)), "the same slot shown third is 03");
});

it("headerFor renders each status shape", () => {
  assert.ok(headerFor(pane(0, { name: null, status: "idle" })).includes("idle"));
  assert.ok(headerFor(pane(0)).includes("* run"));
  assert.ok(headerFor(pane(0, { status: "ok" })).includes("tokens n/a"), "ok with no usage");
  assert.ok(
    headerFor(pane(0, { status: "ok", usage: { inputTokens: 5 } })).includes("in 5"),
    "ok with usage",
  );
  assert.ok(headerFor(pane(0, { status: "timeout", note: "took too long" })).includes("took too"));
});

it("the table pins its header and always renders a totals row", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(i + 1));
  for (const [r, c] of SIZES) {
    const out = layoutTable(rows, totals, 0, r, c);
    assert.equal(out.lines.length, r);
    for (const line of out.lines) assert.equal(displayWidth(line), c);
    if (r >= 2) {
      assert.ok(out.lines[0]?.includes("Status"), "header pinned at the top");
      assert.equal(
        out.lines.filter((l) => l.includes("Total")).length,
        1,
        "exactly one totals row",
      );
    }
  }
});

it("the totals row sits immediately after the last case row", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(i + 1));
  const out = layoutTable(rows, totals, 0, 20, 80);
  assert.equal(out.lines.length, 20);
  assert.ok(out.lines[5]?.includes("tc-5"), "last case row");
  assert.ok(out.lines[6]?.includes("Total"), "totals directly below it, not at the bottom");
  for (const line of out.lines.slice(7)) {
    assert.equal(line.trim(), "", "only blank padding below the totals");
  }
});

it("once the table fills the window the totals row is the last line again", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(i + 1));
  const out = layoutTable(rows, totals, 0, 24, 80);
  assert.ok(out.lines[out.lines.length - 1]?.includes("Total"), "still pinned at the bottom");
  assert.ok(out.lines[out.lines.length - 2]?.includes("tc-"), "a case row directly above it");
});

it("table scroll clamps at both ends and reports the page size", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(i + 1));
  const view = 24 - 2;
  assert.equal(layoutTable(rows, totals, -5, 24, 80).scroll, 0, "clamps at the top");
  assert.equal(layoutTable(rows, totals, 10 ** 9, 24, 80).scroll, 40 - view, "clamps at the end");
  assert.equal(layoutTable(rows, totals, 0, 24, 80).page, view, "page equals the visible window");
});

it("degenerate table heights", () => {
  const rows = [row(1)];
  assert.deepEqual(layoutTable(rows, totals, 0, 0, 80).lines, []);
  assert.equal(layoutTable(rows, totals, 0, 1, 80).lines.length, 1);
  assert.equal(layoutTable(rows, totals, 0, 2, 80).lines.length, 2);
});

it("composeStatus fits, and the right side wins when it cannot", () => {
  assert.equal(displayWidth(composeStatus("left", "right", 40)), 40);
  assert.equal(displayWidth(composeStatus("x".repeat(200), "right", 20)), 20);
  const narrow = composeStatus("left", "a much longer right side than fits", 10);
  assert.equal(displayWidth(narrow), 10);
});

it("shortcutsFor varies by mode and zoom", () => {
  assert.match(shortcutsFor("table", null), /r panes/);
  assert.match(shortcutsFor("panes", null, 8), /1-8 zoom/);
  assert.match(shortcutsFor("panes", null, 3), /1-3 zoom/, "the range tracks the pane count");
  assert.doesNotMatch(shortcutsFor("panes", null, 1), /zoom/, "one pane needs no zoom key");
  assert.match(shortcutsFor("panes", null, 12), /1-9 zoom/, "capped at the nine digits");
  assert.match(shortcutsFor("panes", 3, 8), /0\/esc unzoom/);
});

it("frame appends the status bar as the final row", () => {
  const vm: ViewModel = {
    mode: "panes",
    zoom: null,
    scroll: 0,
    running: 8,
    parallel: 8,
    queued: 2,
    paused: false,
    draining: false,
    panes: panesOf(8),
    panesNote: "no agents running",
    table: [],
    totals,
    statusLeft: " 3+5/10  01:23  tokens —",
  };
  for (const [rows, cols] of SIZES) {
    const out = frame(vm, rows, cols);
    assert.equal(out.lines.length, rows);
    for (const line of out.lines) assert.equal(displayWidth(line), cols);
    assert.ok(out.lines[rows - 1]?.includes("q quit"), "status bar is last");
  }
});

it("frame in table mode returns the clamped scroll and page back to the caller", () => {
  const vm: ViewModel = {
    mode: "table",
    zoom: null,
    scroll: 999,
    running: 0,
    parallel: 8,
    queued: 0,
    paused: false,
    draining: false,
    panes: [],
    panesNote: "no agents running",
    table: Array.from({ length: 40 }, (_, i) => row(i + 1)),
    totals,
    statusLeft: " x ",
  };
  const out = frame(vm, 24, 80);
  assert.ok(out.scroll < 999, "scroll was clamped");
  assert.ok(out.page > 0);
});

it("BLANK_METRICS is all em dashes", () => {
  assert.deepEqual(Object.values(BLANK_METRICS), ["—", "—", "—", "—", "—", "—"]);
});
