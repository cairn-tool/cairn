import { RENDER_HZ } from "./config.js";
import { frame } from "./layout.js";
import type { PaneView, TableRow, ViewModel } from "./layout.js";
import { Screen } from "./screen.js";
import { sleep } from "./async.js";
import type { SlotStatus } from "./slot.js";

const TRANSCRIPT = [
  "\x1b[2mmodel cursor-grok-4.6-high\x1b[0m",
  "\x1b[2m> \x1b[0mReading the plan to work out which files this case touches.",
  "\x1b[36m! \x1b[0mRead  work/tc-runs/_plans/tc-11.yaml",
  "» Starting on the migration checks described in the plan.",
  "\x1b[36m! \x1b[0mShell  npm run build && npm test -- --reporter=dot",
  "\x1b[31mx \x1b[0mShell  npm run build && npm test -- --reporter=dot",
  "\x1b[2m> \x1b[0mThe build failed on a type error; re-reading the offending module.",
  "\x1b[36m! \x1b[0mGlob  src/**/*.{ts,tsx}",
  "» ⚠️ One expected result could not be confirmed — recording it as UNVERIFIED.",
  "\x1b[36m! \x1b[0mWrite  work/tc-runs/tc-11-temp/_results.md",
];

const usage = (n: number) => ({
  inputTokens: 1200 * n + 431,
  outputTokens: 90 * n + 17,
  cacheReadTokens: 5600 * n,
  cacheWriteTokens: n % 3 === 0 ? 0 : 128 * n,
});

const MODELS = ["cursor-grok-4.6-high", "composer-2.5", "cursor-grok-4.6-high", "composer-2.5"];

function demoPanes(): PaneView[] {
  const shapes: [SlotStatus, boolean][] = [
    ["run", false],
    ["run", true],
    ["ok", true],
    ["error", false],
    ["timeout", false],
    ["no-output", false],
    ["no-folder", false],
    ["idle", false],
  ];
  return shapes.map(([status, withUsage], i) => ({
    slot: i,
    name: status === "idle" ? null : `tc-${i * 7 + 11}`,
    model: MODELS[i % MODELS.length]!,
    status,
    elapsedSeconds: status === "idle" ? 0 : 37 + i * 211,
    tools: status === "idle" ? 0 : 3 + i * 17,
    streamedBytes: status === "idle" ? 0 : 1024 * (i + 1) * 37,
    usage: withUsage ? usage(i + 1) : null,
    note: status === "timeout" ? "agent exceeded the 60 minute deadline" : "",
    transcript: status === "run" || status === "ok" ? TRANSCRIPT : TRANSCRIPT.slice(0, 3),
    thinking: status === "run" ? "Now checking the remaining assertions" : "",
  }));
}

function demoTable(): TableRow[] {
  const rows: TableRow[] = [];
  for (let i = 1; i <= 40; i += 1) {
    const kind = i % 5;
    if (kind === 0) {
      rows.push({
        name: `tc-${i}`,
        status: "Prior",
        outcome: "Passed",
        duration: "—",
        tools: "—",
        inn: "—",
        out: "—",
        cache_r: "—",
        cache_w: "—",
      });
    } else if (kind === 1) {
      rows.push({
        name: `tc-${i}`,
        status: "Pending",
        outcome: "—",
        duration: "—",
        tools: "—",
        inn: "—",
        out: "—",
        cache_r: "—",
        cache_w: "—",
      });
    } else if (kind === 2) {
      rows.push({
        name: `tc-${i}`,
        status: "Running",
        outcome: "—",
        duration: "04:31",
        tools: "87",
        inn: "—",
        out: "—",
        cache_r: "—",
        cache_w: "—",
      });
    } else if (kind === 3) {
      rows.push({
        name: `tc-${i}`,
        status: "Done",
        outcome: "Passed",
        duration: "12:04",
        tools: "143",
        inn: "1.2k",
        out: "340",
        cache_r: "5.6k",
        cache_w: "128",
      });
    } else {
      rows.push({
        name: `tc-${i}`,
        status: "Failed",
        outcome: i % 3 === 0 ? "Unverified" : "Timeout",
        duration: "1:02:03",
        tools: "12",
        inn: "1.5M",
        out: "12.3k",
        cache_r: "999",
        cache_w: "0",
      });
    }
  }
  return rows;
}

const TOTALS: TableRow = {
  name: "Total",
  status: "—",
  outcome: "—",
  duration: "3:41:12",
  tools: "1834",
  inn: "1.5M",
  out: "48.2k",
  cache_r: "212.4k",
  cache_w: "3.1k",
};

export interface DemoOptions {
  rows?: number;
  cols?: number;
  table?: boolean;
  once?: boolean;
  /** How many panes to show, so the dynamic pane region can be eyeballed at any width. */
  panes?: number;
}

/** A canned frame, so the TUI can be eyeballed at any size without launching an agent. */
export async function runDemo(opts: DemoOptions): Promise<number> {
  const panes = demoPanes();
  const table = demoTable();
  const screen = new Screen(opts.once !== true);
  if (opts.table) screen.mode = "table";

  const shown = panes.slice(0, opts.panes ?? panes.length);

  const build = (): ViewModel => {
    screen.visibleSlots = shown.map((p) => p.slot);
    return {
      mode: screen.mode,
      zoom: screen.zoom,
      scroll: screen.scroll,
      running: shown.filter((p) => p.status === "run").length,
      parallel: panes.length,
      queued: 27,
      paused: false,
      draining: false,
      panes: shown,
      panesNote: "waiting on tag: build",
      table,
      totals: TOTALS,
      statusLeft: " 2+27/40  1:14:22  in 1.5M  out 48.2k  cache-r 212.4k  cache-w 3.1k",
    };
  };

  const size = (): [number, number] => {
    const [r, c] = screen.size();
    return [opts.rows ?? r, opts.cols ?? c];
  };

  if (opts.once === true || !screen.enabled) {
    const [rows, cols] = [opts.rows ?? 24, opts.cols ?? 80];
    process.stdout.write(`${frame(build(), rows, cols).lines.join("\n")}\n`);
    return 0;
  }

  let stop = false;
  screen.enter();
  const restore = (): void => screen.restore();
  process.once("exit", restore);
  screen.listen({
    requestStop: () => {
      stop = true;
    },
    requestDrain: () => {},
    togglePause: () => {},
  });

  try {
    while (!stop) {
      const [rows, cols] = size();
      const laid = frame(build(), rows, cols);
      screen.scroll = laid.scroll;
      screen.page = laid.page;
      screen.render(laid.lines, rows, cols);
      await sleep(1000 / RENDER_HZ);
    }
  } finally {
    screen.restore();
    process.off("exit", restore);
  }
  return 0;
}
