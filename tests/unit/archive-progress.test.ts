import { describe, expect, it } from "vitest";
import { createReporter, progressAllowed } from "../../src/archive/progress.js";

/**
 * Progress reporting, tested without a terminal.
 *
 * `progressAllowed` is a separate pure function precisely so this suite can
 * exist: the transient line is drawn only when stderr is a TTY, and a test that
 * needed a real one would either be skipped in CI or would not be written.
 */

/** A `WriteStream` far enough along to satisfy the reporter. */
function fakeStream(options: { isTTY: boolean; columns?: number }) {
  const chunks: string[] = [];
  return {
    stream: {
      isTTY: options.isTTY,
      columns: options.columns ?? 100,
      write(text: string) {
        chunks.push(text);
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0),
  };
}

describe("progressAllowed", () => {
  it("draws only on a terminal", () => {
    const tty = fakeStream({ isTTY: true }).stream;
    const piped = fakeStream({ isTTY: false }).stream;
    expect(progressAllowed("llm", tty, {})).toBe(true);
    // A \r-rewritten line is corruption in a redirected log.
    expect(progressAllowed("llm", piped, {})).toBe(false);
  });

  it("never draws over a machine-readable format", () => {
    const tty = fakeStream({ isTTY: true }).stream;
    expect(progressAllowed("json", tty, {})).toBe(false);
    expect(progressAllowed("human", tty, {})).toBe(true);
  });

  it("stays out of CI transcripts", () => {
    const tty = fakeStream({ isTTY: true }).stream;
    expect(progressAllowed("llm", tty, { CI: "1" })).toBe(false);
  });
});

describe("the transient line", () => {
  it("rewrites in place rather than scrolling", () => {
    const sink = fakeStream({ isTTY: true });
    let clock = 0;
    const reporter = createReporter({
      progress: true,
      verbose: false,
      stream: sink.stream,
      // Past the 100ms throttle every time, so each file draws.
      now: () => (clock += 500),
    });
    reporter.start!({ files: 2, bytes: 200 });
    reporter.file!({ path: "/a/one.md", class: "plan", size: 100, disposition: "stored" });
    reporter.file!({ path: "/a/two.md", class: "plan", size: 100, disposition: "stored" });
    reporter.finish!();

    const text = sink.text();
    expect(text).toContain("\r");
    // One line, rewritten: no newline is ever emitted by the transient path.
    expect(text).not.toContain("\n");
    expect(text).toContain("1/2 files");
    expect(text).toContain("2/2 files");
    // `finish` wipes the line so the shell prompt lands on a clean row.
    expect(text.endsWith("\r")).toBe(true);
  });

  it("throttles, because redrawing per file is most of the work at scale", () => {
    const sink = fakeStream({ isTTY: true });
    let clock = 0;
    const reporter = createReporter({
      progress: true,
      verbose: false,
      stream: sink.stream,
      // 10ms apart: inside the throttle window.
      now: () => (clock += 10),
    });
    reporter.start!({ files: 100, bytes: 1000 });
    for (let index = 0; index < 100; index++) {
      reporter.file!({ path: `/a/${index}`, class: "plan", size: 10, disposition: "stored" });
    }
    const draws = sink.text().split("\r").length - 1;
    expect(draws).toBeGreaterThan(0);
    expect(draws).toBeLessThan(100);
  });

  it("gives the path up before the counters when the terminal is narrow", () => {
    const sink = fakeStream({ isTTY: true, columns: 60 });
    let clock = 0;
    const reporter = createReporter({
      progress: true,
      verbose: false,
      stream: sink.stream,
      now: () => (clock += 500),
    });
    reporter.start!({ files: 1, bytes: 10 });
    reporter.file!({
      path: "/very/deeply/nested/project/slug/session/tool-results/report.pdf",
      class: "artifact",
      size: 10,
      disposition: "stored",
    });
    const frame = sink.text().split("\r").at(-1) ?? "";
    expect(frame.length).toBeLessThanOrEqual(59);
    // On a 60-column terminal the counters leave only a few characters for the
    // path, and they are the ones that survive: how far along the run is matters
    // more than which file it is on. What is left of the path is its tail.
    expect(frame).toContain("1/1 files");
    expect(frame).toContain("10B/10B");
    expect(frame).toMatch(/…\S*port\.pdf$/);
    expect(frame).not.toContain("/very/deeply");
  });

  it("shows the whole path when there is room for it", () => {
    const sink = fakeStream({ isTTY: true, columns: 140 });
    let clock = 0;
    const reporter = createReporter({
      progress: true,
      verbose: false,
      stream: sink.stream,
      now: () => (clock += 500),
    });
    reporter.start!({ files: 1, bytes: 10 });
    const file = "/very/deeply/nested/project/slug/session/tool-results/report.pdf";
    reporter.file!({ path: file, class: "artifact", size: 10, disposition: "stored" });
    expect(sink.text().split("\r").at(-1)).toContain(file);
  });
});

describe("verbose", () => {
  it("writes a durable line per artifact, whether or not there is a terminal", () => {
    const sink = fakeStream({ isTTY: false });
    const reporter = createReporter({ progress: false, verbose: true, stream: sink.stream });
    reporter.start!({ files: 3, bytes: 300 });
    reporter.file!({
      path: "/a/one.md",
      class: "plan",
      size: 100,
      disposition: "stored",
      sha256: "abcdef0123456789",
    });
    reporter.file!({
      path: "/a/two.md",
      class: "plan",
      size: 100,
      disposition: "duplicate",
      sha256: "abcdef0123456789",
    });
    reporter.file!({ path: "/a/three.md", class: "plan", size: 100, disposition: "unchanged" });
    reporter.segment!({ name: "seg-000001.tar.gz", bytes: 50, blobs: 1 });
    reporter.finish!();

    const lines = sink.lines();
    expect(lines[0]).toContain("archiving 3 artifacts");
    expect(lines[1]).toMatch(/^stored\s+plan\s+100B\s+abcdef012345\s+\/a\/one\.md$/);
    expect(lines[2]).toContain("duplicate");
    // Unchanged files are never opened, so there is no hash to report.
    expect(lines[3]).toContain("unchanged");
    expect(lines[3]).toContain("------------");
    expect(lines[4]).toContain("sealed    seg-000001.tar.gz");
    expect(lines[5]).toContain("archived 100B of new content");
    // Nothing transient: every line is durable, so redirecting keeps it readable.
    expect(sink.text()).not.toContain("\r");
  });

  it("suppresses the transient line, which would fight it for the row", () => {
    const sink = fakeStream({ isTTY: true });
    const reporter = createReporter({ progress: true, verbose: true, stream: sink.stream });
    reporter.start!({ files: 1, bytes: 10 });
    reporter.file!({ path: "/a/one.md", class: "plan", size: 10, disposition: "stored" });
    expect(sink.text()).not.toContain("\r");
  });

  it("reports an unreadable file durably at either level", () => {
    // The one thing in a long run nobody should have to scroll back for.
    for (const verbose of [true, false]) {
      const sink = fakeStream({ isTTY: true });
      const reporter = createReporter({ progress: true, verbose, stream: sink.stream });
      reporter.start!({ files: 1, bytes: 10 });
      reporter.failure!({ file: "/a/locked.db", reason: "EACCES" });
      expect(sink.text()).toContain("unreadable /a/locked.db: EACCES");
    }
  });

  it("does nothing at all when both are off", () => {
    const sink = fakeStream({ isTTY: true });
    const reporter = createReporter({ progress: false, verbose: false, stream: sink.stream });
    expect(reporter.start).toBeUndefined();
    expect(sink.text()).toBe("");
  });
});
