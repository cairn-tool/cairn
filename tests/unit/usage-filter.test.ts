import { describe, expect, it } from "vitest";
import {
  clipToWindow,
  dayInWindow,
  matchesProject,
  modifiedSinceFor,
  parseDay,
  parseProject,
  resolveWindow,
} from "../../src/usage/filter.js";
import type { FileAggregate } from "../../src/usage/events.js";
import { emptyBucket } from "../../src/usage/events.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function aggregate(days: string[]): FileAggregate {
  return {
    file: "/logs/projects/p/s.jsonl",
    size: 1,
    mtimeMs: 1,
    provider: "claude-code",
    sessionId: "s",
    kind: "main",
    project: "/tmp/proj",
    firstTs: `${days[0]}T00:00:00.000Z`,
    lastTs: `${days[days.length - 1]}T00:00:00.000Z`,
    days: Object.fromEntries(days.map((day) => [day, emptyBucket()])),
    malformedLines: 0,
  };
}

describe("parseDay", () => {
  it("resolves a relative span against now", () => {
    expect(parseDay("7d", "--since", NOW)).toBe("2026-08-22");
    expect(parseDay("2w", "--since", NOW)).toBe("2026-08-15");
    // A span, not a calendar month: 30 days.
    expect(parseDay("3m", "--since", NOW)).toBe("2026-05-31");
    expect(parseDay("1y", "--since", NOW)).toBe("2025-08-29");
  });

  it("accepts an ISO date unchanged", () => {
    expect(parseDay("2026-01-09", "--since", NOW)).toBe("2026-01-09");
  });

  it("rejects anything else with a message naming both forms", () => {
    expect(() => parseDay("yesterday", "--since", NOW)).toThrow("Invalid --since value: yesterday");
    // An instant would promise a precision the day-bucketed index cannot keep.
    expect(() => parseDay("2026-01-09T10:00:00Z", "--since", NOW)).toThrow("Invalid --since");
    expect(() => parseDay("7x", "--until", NOW)).toThrow("Invalid --until");
  });
});

describe("resolveWindow", () => {
  it("leaves an unset bound null", () => {
    expect(resolveWindow(undefined, undefined, NOW)).toEqual({ since: null, until: null });
  });

  it("refuses an inverted window", () => {
    expect(() => resolveWindow("2026-08-10", "2026-08-01", NOW)).toThrow(
      "--since 2026-08-10 is after --until 2026-08-01",
    );
  });

  it("treats both bounds as inclusive", () => {
    const window = resolveWindow("2026-08-01", "2026-08-03", NOW);
    expect(dayInWindow("2026-08-01", window)).toBe(true);
    expect(dayInWindow("2026-08-03", window)).toBe(true);
    expect(dayInWindow("2026-07-31", window)).toBe(false);
    expect(dayInWindow("2026-08-04", window)).toBe(false);
  });
});

describe("modifiedSinceFor", () => {
  it("is undefined without a lower bound, so nothing is pruned", () => {
    expect(modifiedSinceFor({ since: null, until: null })).toBeUndefined();
  });

  it("allows a day of slack below the window", () => {
    // Absorbs clock skew between the record timestamps and the filesystem, at
    // the cost of opening at most one extra day of transcripts.
    const value = modifiedSinceFor({ since: "2026-08-10", until: null });
    expect(new Date(value!).toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });
});

describe("parseProject and matchesProject", () => {
  it("matches everything when nothing was selected", () => {
    expect(matchesProject("/anywhere", [])).toBe(true);
  });

  it("treats a bare token as a case-insensitive fragment", () => {
    const selectors = [parseProject("Claude-CLI")];
    expect(selectors[0].absolute).toBeNull();
    expect(matchesProject("/Users/x/dev/claude-cli", selectors)).toBe(true);
    expect(matchesProject("/Users/x/dev/other", selectors)).toBe(false);
  });

  it("treats a path as a prefix, so a subdirectory still matches", () => {
    const selectors = [parseProject(".", "/Users/x/dev/app")];
    expect(matchesProject("/Users/x/dev/app", selectors)).toBe(true);
    expect(matchesProject("/Users/x/dev/app/packages/ui", selectors)).toBe(true);
    // Not a prefix at a path boundary.
    expect(matchesProject("/Users/x/dev/apples", selectors)).toBe(false);
  });
});

describe("clipToWindow", () => {
  it("keeps only the days inside the window", () => {
    const clipped = clipToWindow(aggregate(["2026-08-01", "2026-08-05", "2026-08-09"]), {
      since: "2026-08-02",
      until: "2026-08-08",
    });
    expect(Object.keys(clipped!.days)).toEqual(["2026-08-05"]);
  });

  it("drops a transcript with nothing left in it", () => {
    expect(
      clipToWindow(aggregate(["2026-08-01"]), { since: "2026-08-02", until: null }),
    ).toBeNull();
  });

  it("returns the aggregate untouched when the window is unbounded", () => {
    const input = aggregate(["2026-08-01"]);
    expect(clipToWindow(input, { since: null, until: null })).toBe(input);
  });
});
