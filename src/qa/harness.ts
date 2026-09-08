import { existsSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { ChildProcess } from "node:child_process";
import { DONE_FAIL, DONE_OK, RENDER_HZ } from "./config.js";
import type { Options } from "./config.js";
import { RED, RESET, flatten, fmtDuration } from "./format.js";
import { Cleanup, Gate, sleep } from "./async.js";
import { commandFor, stillEligible } from "./cases.js";
import { Scheduler } from "./schedule.js";
import type { Case } from "./cases.js";
import { Slot } from "./slot.js";
import { agentCaps, asEventList, resolveAgent } from "./agents/index.js";
import {
  FAIL_OUTCOME,
  classify,
  outcomeLabel,
  readVerdict,
  usageCells,
  usageFragment,
  usageTotal,
} from "./outcome.js";
import { BLANK_METRICS, frame } from "./layout.js";
import type { PaneView, TableRow, ViewModel } from "./layout.js";
import { Screen } from "./screen.js";
import { killGroup, runAgent } from "./agent.js";
import { acquireLock } from "./lock.js";
import type { Lock } from "./lock.js";
import { consoleSummary, writeSessionLog, writeSummaryJson } from "./reports.js";
import type { Rec, SessionInfo, SessionStats } from "./reports.js";
import { writeCaseTracker } from "./tracker.js";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") */
export function runId(d = new Date()): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

/** datetime.now().strftime("%H:%M:%S") — local, for line-log timestamps. */
function stamp(d = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export class Harness {
  private readonly options: Options;
  private readonly cases: Case[];
  private readonly allCases: Case[];
  private readonly prior: ReadonlySet<string>;
  private readonly byName: Map<string, Case>;

  private sched: Scheduler;
  private readonly slots: Slot[];
  private readonly live = new Map<number, ChildProcess>();
  private readonly records: Rec[] = [];
  private readonly gate = new Gate(true);
  private readonly cleanup = new Cleanup();
  private readonly screen: Screen;

  private readonly startedMs = performance.now();
  private readonly runId: string;
  private readonly pid = process.pid;
  private readonly logRoot: string;
  private readonly sessionLog: string;
  private trackerPath: string | null = null;
  private lock: Lock | null = null;

  paused = false;
  draining = false;
  stopLevel = 0;

  constructor(options: Options, cases: Case[], allCases: Case[]) {
    this.options = options;
    this.cases = cases;
    this.allCases = allCases.length > 0 ? allCases : [...cases];
    this.prior = new Set(this.allCases.filter((c) => existsSync(c.outDir)).map((c) => c.name));
    this.byName = new Map(this.allCases.map((c) => [c.name, c]));
    this.sched = new Scheduler(this.cases, agentCaps(options.parallel));
    this.slots = Array.from({ length: options.parallel }, (_, i) => new Slot(i));
    this.runId = runId();
    this.logRoot = join(options.runsDir, "_logs", this.runId);
    this.sessionLog = join(options.runsDir, "_runs", `${this.runId}-${this.pid}.md`);
    this.screen = new Screen(!options.noTui);
  }

  private get info(): SessionInfo {
    return {
      runId: this.runId,
      pid: this.pid,
      defaultModel: this.options.model,
      parallel: this.options.parallel,
      repo: this.options.repo,
      runsDir: this.options.runsDir,
      sessionLog: this.sessionLog,
      logRoot: this.logRoot,
    };
  }

  // ---------------------------------------------------------------- view model

  private progress(): [running: number, completed: number, total: number] {
    const running = this.slots.filter((s) => s.status === "run").length;
    const finished = new Set(this.records.filter((r) => r.status !== "skipped").map((r) => r.name));
    const completed = new Set([...this.prior, ...finished]).size;
    return [running, completed, this.allCases.length];
  }

  private finishedRecords(): Rec[] {
    return this.records.filter((r) => r.status !== "skipped");
  }

  sessionStats(): SessionStats {
    const recs = this.finishedRecords();
    return {
      ok: this.records.filter((r) => r.status === DONE_OK).length,
      fail: this.records.filter((r) => DONE_FAIL.has(r.status)).length,
      skipped: this.records.filter((r) => r.status === "skipped").length,
      durationS: recs.reduce((sum, r) => sum + r.durationS, 0),
      tools: recs.reduce((sum, r) => sum + r.tools, 0),
      usage: usageTotal(recs.map((r) => r.usage)),
      wallS: (performance.now() - this.startedMs) / 1000,
    };
  }

  private tableRows(): TableRow[] {
    const latest = new Map<string, Rec>();
    for (const rec of this.records) latest.set(rec.name, rec);
    const running = new Map<string, Slot>();
    for (const slot of this.slots) {
      if (slot.case !== null && slot.status === "run") running.set(slot.case.name, slot);
    }
    const now = performance.now();
    return this.allCases.map((kase) => {
      const rec = latest.get(kase.name);
      const live = running.get(kase.name);
      if (live) {
        return {
          name: kase.name,
          status: "Running",
          outcome: "—",
          duration: fmtDuration(live.elapsedSeconds(now)),
          tools: String(live.tools),
          ...usageCells(null),
        };
      }
      if (rec !== undefined && rec.status !== "skipped") {
        let status: string;
        let outcome: string;
        if (rec.status === DONE_OK) {
          status = "Done";
          outcome = outcomeLabel(readVerdict(kase.outDir));
        } else {
          status = "Failed";
          const verdict = readVerdict(kase.outDir);
          outcome =
            verdict !== "—" ? outcomeLabel(verdict) : (FAIL_OUTCOME[rec.status] ?? rec.status);
        }
        return {
          name: kase.name,
          status,
          outcome,
          duration: fmtDuration(rec.durationS),
          tools: String(rec.tools),
          ...usageCells(rec.usage),
        };
      }
      if (this.prior.has(kase.name) || (rec !== undefined && rec.status === "skipped")) {
        return {
          name: kase.name,
          status: "Prior",
          outcome: outcomeLabel(readVerdict(kase.outDir)),
          ...BLANK_METRICS,
        };
      }
      return { name: kase.name, status: "Pending", outcome: "—", ...BLANK_METRICS };
    });
  }

  private tableTotals(): TableRow {
    const recs = this.finishedRecords();
    if (recs.length === 0) {
      return { name: "Total", status: "—", outcome: "—", ...BLANK_METRICS };
    }
    const stats = this.sessionStats();
    return {
      name: "Total",
      status: "—",
      outcome: "—",
      duration: fmtDuration(stats.durationS),
      tools: String(stats.tools),
      ...usageCells(stats.usage),
    };
  }

  recordOutcome = (rec: Rec): string => {
    const kase = this.byName.get(rec.name);
    const folder = kase !== undefined ? kase.outDir : join(this.options.runsDir, rec.name);
    if (rec.status === DONE_OK) return outcomeLabel(readVerdict(folder));
    if (rec.status === "skipped") return "—";
    const verdict = readVerdict(folder);
    if (verdict !== "—") return outcomeLabel(verdict);
    return FAIL_OUTCOME[rec.status] ?? rec.status;
  };

  private statusLeft(): string {
    const [run, done, total] = this.progress();
    const elapsed = fmtDuration((performance.now() - this.startedMs) / 1000);
    const summed = usageTotal(
      this.records.filter((r) => r.status !== "skipped").map((r) => r.usage),
    );
    const tok = summed ? usageFragment(summed) : "tokens —";
    const flags: string[] = [];
    if (this.paused) flags.push("PAUSED");
    if (this.draining) flags.push("DRAINING");
    const extra = flags.length > 0 ? `  ${flags.join("  ")}` : "";
    return ` ${run}+${done}/${total}  ${elapsed}  ${tok}${extra}`;
  }

  private paneView(slot: Slot, now: number): PaneView {
    return {
      slot: slot.index,
      name: slot.case?.name ?? null,
      model: slot.case?.model ?? "",
      status: slot.status,
      elapsedSeconds: slot.elapsedSeconds(now),
      tools: slot.tools,
      streamedBytes: slot.streamedBytes,
      usage: slot.usage,
      note: slot.note,
      transcript: slot.transcript,
      thinking: slot.thinking,
    };
  }

  /**
   * The slots worth a pane: the ones actually running. With nothing running and nothing left to
   * dispatch — the end of a session — the finished slots stand in so the final frame still shows
   * every result. With work still queued, the region stays empty and says why instead, since a
   * queue held up by a barrier or a tag is exactly the state worth seeing.
   */
  private visibleSlots(): Slot[] {
    const running = this.slots.filter((s) => s.status === "run");
    if (running.length > 0 || this.sched.size > 0) return running;
    return this.slots
      .filter((s) => s.case !== null && s.endedMs !== null)
      .sort((a, b) => (a.endedMs ?? 0) - (b.endedMs ?? 0));
  }

  viewModel(): ViewModel {
    const now = performance.now();
    const visible = this.visibleSlots();
    this.screen.visibleSlots = visible.map((s) => s.index);
    return {
      mode: this.screen.mode,
      zoom: this.screen.zoom,
      scroll: this.screen.scroll,
      running: this.sched.inFlight,
      parallel: this.options.parallel,
      queued: this.sched.size,
      paused: this.paused,
      draining: this.draining,
      panes: visible.map((s) => this.paneView(s, now)),
      panesNote: this.panesNote(),
      table: this.screen.mode === "table" ? this.tableRows() : [],
      totals: this.tableTotals(),
      statusLeft: this.statusLeft(),
    };
  }

  /** Why the pane region is empty — without this a tag-blocked queue looks like a hang. */
  private panesNote(): string {
    if (this.paused) return "paused — press p to resume";
    if (this.draining) return "draining — waiting for the running agents";
    if (this.stopLevel > 0) return "stopping";
    return this.sched.blockedReason() ?? "no agents running";
  }

  private renderOnce(): void {
    const [rows, cols] = this.screen.size();
    if (rows < 1) return;
    const vm = this.viewModel();
    // A zoomed case that finished drops out of the pane list; unzoom rather than silently
    // falling back to showing everything.
    if (vm.zoom !== null && !vm.panes.some((p) => p.slot === vm.zoom)) {
      this.screen.zoom = null;
      vm.zoom = null;
    }
    const laid = frame(vm, rows, cols);
    if (vm.mode === "table") {
      this.screen.scroll = laid.scroll;
      this.screen.page = laid.page;
    }
    this.screen.render(laid.lines, rows, cols);
  }

  // ---------------------------------------------------------------- controls

  togglePause(): void {
    this.paused = !this.paused;
    this.gate.set(!this.paused);
  }

  requestDrain(): void {
    this.draining = true;
    this.gate.set(true); // wake paused workers so they can observe the drain and exit
    this.sched.wake(); // and workers parked on a tag, which the gate does not reach
    this.logPlain("draining — no new cases; waiting for running agents");
  }

  requestStop(): void {
    this.stopLevel += 1;
    this.paused = true;
    this.gate.set(true); // CRITICAL: a paused worker must be woken to see stopLevel
    this.sched.wake(); // likewise for a worker parked waiting on a tag
    const sig: NodeJS.Signals = this.stopLevel >= 2 ? "SIGKILL" : "SIGINT";
    for (const child of [...this.live.values()]) killGroup(child, sig);
  }

  private logPlain(msg: string): void {
    if (this.screen.enabled || this.options.json) return;
    process.stdout.write(`${stamp()}  ${msg}\n`);
  }

  // ---------------------------------------------------------------- reporting

  private writeSummary(): void {
    writeSummaryJson(this.info, this.records, this.recordOutcome);
    writeSessionLog(this.info, this.records, this.sessionStats(), this.recordOutcome);
  }

  private writeTracker(): void {
    try {
      const { path } = writeCaseTracker(this.options.runsDir);
      this.trackerPath = path;
    } catch {
      this.trackerPath = null;
    }
  }

  exitCode(): number {
    if (this.records.length === 0) return 1;
    return this.records.every((r) => r.status === DONE_OK || r.status === "skipped") ? 0 : 1;
  }

  // ---------------------------------------------------------------- execution

  private async runCase(slot: Slot, kase: Case): Promise<void> {
    const logDir = join(this.logRoot, kase.name);
    slot.reset(kase, logDir);
    rmSync(kase.tempDir, { recursive: true, force: true });
    const argv = commandFor(kase, this.options.agent);
    this.logPlain(`slot${slot.index + 1}  ${kase.name}  start`);

    let exitCode: number | null = null;
    let timedOut: boolean | undefined;
    const profile = resolveAgent(kase.agentName);
    try {
      const result = await runAgent({
        argv,
        cwd: this.options.repo,
        logDir,
        timeoutMs: this.options.timeoutMs,
        onBytes: (n) => {
          slot.streamedBytes += n;
        },
        onEvent: (event) => {
          for (const qa of asEventList(profile.normalize(event))) slot.applyEvent(qa);
        },
        onRawLine: (line) => slot.add(line),
        onSpawn: (child) => {
          this.live.set(slot.index, child);
        },
      });
      exitCode = result.exitCode;
      timedOut = result.timedOut;
    } finally {
      this.live.delete(slot.index);
      slot.endedMs = performance.now();
      slot.exitCode = exitCode;
      slot.closeTranscript();
    }

    const [status, note] = classify(kase, exitCode, timedOut === true);
    slot.status = status as Slot["status"];
    if (note && !slot.note) slot.note = note;
    const durationS = slot.elapsedSeconds(performance.now());
    this.records.push({
      name: kase.name,
      model: kase.model,
      status: slot.status,
      exitCode,
      startedS: ((slot.startedMs ?? this.startedMs) - this.startedMs) / 1000,
      durationS,
      durationIsInt: false,
      usage: slot.usage,
      note: slot.note,
      sessionId: slot.sessionId,
      logDir: relative(this.options.runsDir, logDir),
      tools: slot.tools,
    });
    this.writeSummary();
    this.logPlain(
      `slot${slot.index + 1}  ${kase.name}  ${slot.status}  ` +
        `exit=${exitCode === null ? "None" : exitCode}  ${fmtDuration(durationS)}`,
    );
  }

  private recordSkipped(slot: Slot, kase: Case): void {
    slot.reset(kase);
    slot.status = "skipped";
    slot.endedMs = performance.now();
    slot.note = "folder already exists";
    this.records.push({
      name: kase.name,
      model: kase.model,
      status: "skipped",
      exitCode: null,
      startedS: ((slot.startedMs ?? this.startedMs) - this.startedMs) / 1000,
      durationS: 0,
      durationIsInt: true,
      usage: null,
      note: slot.note,
      sessionId: "",
      logDir: "",
      tools: 0,
    });
    this.writeSummary();
    this.logPlain(`slot${slot.index + 1}  ${kase.name}  skipped`);
  }

  private recordHarnessError(slot: Slot, kase: Case, err: unknown): void {
    slot.status = "error";
    slot.endedMs = performance.now();
    slot.note = flatten(err instanceof Error ? err.message : String(err)).slice(0, 160);
    slot.add(`${RED}x harness: ${slot.note}${RESET}`);
    this.records.push({
      name: kase.name,
      model: kase.model,
      status: "error",
      exitCode: null,
      startedS: ((slot.startedMs ?? this.startedMs) - this.startedMs) / 1000,
      durationS: slot.elapsedSeconds(performance.now()),
      durationIsInt: false,
      usage: null,
      note: slot.note,
      sessionId: slot.sessionId,
      logDir: slot.logDir ? relative(this.options.runsDir, slot.logDir) : "",
      tools: slot.tools,
    });
    this.writeSummary();
    this.logPlain(`slot${slot.index + 1}  ${kase.name}  error  ${slot.note}`);
  }

  private async worker(slot: Slot): Promise<void> {
    for (;;) {
      if (this.stopLevel || this.draining) return;
      await this.gate.wait();
      if (this.stopLevel || this.draining) return;

      // Sampled before the take and handed to changed() below, so a release landing between the
      // two cannot be slept through. Nothing may `await` between here and changed().
      const generation = this.sched.generationId;
      const kase = this.sched.take();
      if (kase === null) {
        if (this.sched.size === 0) return; // nothing left for anyone — this worker is done
        await this.sched.changed(generation); // park until a case finishes, or we are shut down
        continue;
      }

      try {
        if (stillEligible(kase)) await this.runCase(slot, kase);
        else this.recordSkipped(slot, kase);
      } catch (err) {
        this.recordHarnessError(slot, kase, err);
      } finally {
        // Both paths: a skipped case still reserved its tags in take().
        this.sched.release(kase);
      }
    }
  }

  private async renderLoop(signal: AbortSignal): Promise<void> {
    const interval = 1000 / RENDER_HZ;
    while (!signal.aborted) {
      this.renderOnce();
      if (this.stopLevel && this.live.size === 0) {
        await sleep(200, signal);
        this.renderOnce();
        return;
      }
      await sleep(interval, signal);
    }
  }

  async run(): Promise<number> {
    this.sched = new Scheduler(this.cases, agentCaps(this.options.parallel));
    this.writeSummary();

    const onSignal = (): void => this.requestStop();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const loops = new AbortController();
    this.screen.listen(this, () => {
      if (this.screen.enabled) this.renderOnce();
    });
    const rendering = this.screen.enabled ? this.renderLoop(loops.signal) : Promise.resolve();
    const onResize = (): void => this.renderOnce();
    if (this.screen.enabled) process.stdout.on("resize", onResize);

    try {
      await Promise.all(this.slots.map((slot) => this.worker(slot)));
      if (this.screen.enabled) {
        this.renderOnce();
        await sleep(500);
      }
    } finally {
      this.stopLevel = Math.max(this.stopLevel, 1);
      loops.abort();
      await rendering.catch(() => undefined);
      if (this.screen.enabled) process.stdout.off("resize", onResize);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      for (const slot of this.slots) slot.closeTranscript();
      this.writeSummary();
      this.writeTracker();
    }
    return this.exitCode();
  }

  /** Acquire the lock, run inside the alt screen, print the summary, always clean up. */
  async main(): Promise<number> {
    this.lock = acquireLock(this.options.runsDir);
    this.cleanup.add(() => this.lock?.release());
    this.cleanup.add(() => this.screen.restore());
    this.cleanup.install((err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    });

    this.screen.enter();
    let code: number;
    try {
      code = await this.run();
    } finally {
      this.screen.restore();
    }
    if (!this.options.json) {
      process.stdout.write(`${consoleSummary(this.info, this.sessionStats(), this.trackerPath)}\n`);
    }
    this.lock.release();
    return code;
  }

  get sessionRecords(): readonly Rec[] {
    return this.records;
  }

  get sessionInfo(): SessionInfo {
    return this.info;
  }
}
