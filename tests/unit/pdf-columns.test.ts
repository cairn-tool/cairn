import { describe, expect, it } from "vitest";
import { orderedText, parseColumns, readingOrder } from "../../src/pdf/columns.js";
import type { PositionedRun } from "../../src/pdf/text.js";

let index = 0;
/** A run as extractPage makes one: y grows downwards, width about half an em a character. */
function run(x: number, y: number, text: string, size = 10): PositionedRun {
  return {
    page: 1,
    index: index++,
    text,
    x,
    y,
    width: text.length * size * 0.5,
    height: size,
    size,
    fontKey: `Helvetica@${size}`,
    fontFamily: "Helvetica",
    bold: false,
    italic: false,
    vertical: false,
    angle: 0,
    hasEOL: false,
    mcid: null,
  };
}

/** A page in two columns of `rows` lines each, under a title across both. */
function twoColumns(rows = 12, title = true): PositionedRun[] {
  const runs: PositionedRun[] = [];
  if (title)
    runs.push(
      run(72, 60, "A title that runs right across the page from one margin to the other", 14),
    );
  for (let row = 0; row < rows; row += 1) {
    runs.push(run(72, 100 + row * 12, `left ${row} text of the first column here`));
    runs.push(run(320, 100 + row * 12, `right ${row} text of the second column`));
  }
  return runs;
}

describe("reading order across columns", () => {
  it("reads two columns in turn, with a title across both read first", () => {
    const order = readingOrder(twoColumns(), 612);
    expect(order.layout).toMatchObject({ columns: 2, method: "auto", spanning: 1 });
    expect(order.layout.gutters).toHaveLength(1);
    expect(order.layout.gutters[0]).toBeGreaterThan(280);
    expect(order.layout.gutters[0]).toBeLessThan(320);
    const lines = orderedText(order).split("\n");
    expect(lines[0]).toMatch(/^A title/);
    expect(lines[1]).toMatch(/^left 0/);
    expect(lines[12]).toMatch(/^left 11/);
    expect(lines[13]).toMatch(/^right 0/);
    expect(lines).toHaveLength(25);
  });

  it("reads each stretch between full-width lines in its own columns", () => {
    const runs = twoColumns(6, false);
    runs.push(run(72, 200, "A figure caption that runs across the whole page under both columns"));
    for (let row = 0; row < 6; row += 1) {
      runs.push(run(72, 230 + row * 12, `lower left ${row} of the first column`));
      runs.push(run(320, 230 + row * 12, `lower right ${row} of the second`));
    }
    const lines = orderedText(readingOrder(runs, 612)).split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "left 0 text of the first column here",
      "left 1 text of the first column here",
    ]);
    expect(lines[6]).toMatch(/^right 0/);
    expect(lines[12]).toMatch(/^A figure caption/);
    expect(lines[13]).toMatch(/^lower left 0/);
    expect(lines[19]).toMatch(/^lower right 0/);
  });

  it("leaves one column alone, and a table's short cells read across each row", () => {
    const prose: PositionedRun[] = [];
    for (let row = 0; row < 20; row += 1)
      prose.push(
        run(
          72,
          100 + row * 12,
          "a full line of prose in the one column the page has, word after word",
        ),
      );
    expect(readingOrder(prose, 612).layout.columns).toBe(1);

    const table: PositionedRun[] = [];
    for (let row = 0; row < 12; row += 1) {
      table.push(run(72, 100 + row * 12, `Item ${row}`));
      table.push(run(320, 100 + row * 12, `${row}.5 kg`));
    }
    const order = readingOrder(table, 612);
    expect(order.layout.columns).toBe(1);
    expect(orderedText(order).split("\n")[0]).toBe("Item 0 0.5 kg");
  });

  it("reads top to bottom with --columns 1, and as many columns as asked otherwise", () => {
    const one = readingOrder(twoColumns(), 612, 1);
    expect(one.layout).toEqual({ columns: 1, method: "forced", gutters: [], spanning: 0 });
    expect(orderedText(one).split("\n")[1]).toMatch(/^left 0 .* right 0/);

    const two = readingOrder(twoColumns(), 612, 2);
    expect(two.layout).toMatchObject({ columns: 2, method: "forced" });
    expect(orderedText(two).split("\n")[13]).toMatch(/^right 0/);
  });

  it("distrusts more gutters than three", () => {
    const runs: PositionedRun[] = [];
    for (let row = 0; row < 10; row += 1)
      for (let column = 0; column < 5; column += 1)
        runs.push(run(40 + column * 110, 100 + row * 12, "cell text"));
    const order = readingOrder(runs, 612);
    expect(order.layout.columns).toBe(1);
    expect(order.uncertain).toBe(5);
  });

  it("parses --columns", () => {
    expect(parseColumns(undefined)).toBe("auto");
    expect(parseColumns("auto")).toBe("auto");
    expect(parseColumns("2")).toBe(2);
    expect(() => parseColumns("0")).toThrow(/--columns/);
    expect(() => parseColumns("two")).toThrow(/--columns/);
  });
});
