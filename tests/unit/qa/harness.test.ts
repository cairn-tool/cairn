import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "vitest";
import { makeFixture, makeHarness, pidAlive, wait } from "./helpers.js";

it("classifies every terminal status and promotes only clean runs", async () => {
  const fx = makeFixture({
    "tc-1": "ok",
    "tc-2": "no-folder",
    "tc-3": "no-report",
    "tc-4": "no-results",
    "tc-5": "exit-nonzero",
  });
  const harness = makeHarness(fx, { parallel: 3 });
  const code = await harness.run();

  const statuses = new Map(
    (harness as unknown as { records: { name: string; status: string }[] }).records.map((r) => [
      r.name,
      r.status,
    ]),
  );
  assert.equal(statuses.get("tc-1"), "ok");
  assert.equal(statuses.get("tc-2"), "no-folder");
  assert.equal(statuses.get("tc-3"), "no-output");
  assert.equal(statuses.get("tc-4"), "no-output");
  assert.equal(statuses.get("tc-5"), "error");

  // Only the clean run is promoted; failures leave their temp folder behind for inspection.
  assert.ok(existsSync(join(fx.runs, "tc-1")), "tc-1 promoted");
  assert.ok(!existsSync(join(fx.runs, "tc-2-temp")), "tc-2 never created a folder");
  for (const n of ["tc-3", "tc-4", "tc-5"]) {
    assert.ok(!existsSync(join(fx.runs, n)), `${n} not promoted`);
    assert.ok(existsSync(join(fx.runs, `${n}-temp`)), `${n}-temp left in place`);
  }
  assert.equal(code, 1, "exit 1 when any case failed");
});

it("exits 0 when every case succeeds", async () => {
  const fx = makeFixture({ "tc-1": "ok", "tc-2": "ok" });
  const harness = makeHarness(fx);
  assert.equal(await harness.run(), 0);
});

it("a timeout kills the agent AND its grandchild", async () => {
  const fx = makeFixture({ "tc-1": "grandchild" });
  const harness = makeHarness(fx, { parallel: 1, timeoutMs: 2500 });
  const code = await harness.run();

  const records = (harness as unknown as { records: { status: string }[] }).records;
  assert.equal(records[0]?.status, "timeout");
  assert.equal(code, 1);

  const pidFile = join(fx.repo, "grandchild-tc-1.pid");
  assert.ok(existsSync(pidFile), "the fake agent spawned a grandchild");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await wait(300);
  // This is what proves detached:true + process.kill(-pid): a plain child.kill() would
  // leave this orphan running forever.
  assert.equal(pidAlive(pid), false, `grandchild ${pid} was reaped with the group`);
});

it("requestStop() while paused does not deadlock the workers", async () => {
  const fx = makeFixture({ "tc-1": "slow", "tc-2": "slow", "tc-3": "slow", "tc-4": "slow" });
  const harness = makeHarness(fx, { parallel: 1 });

  const running = harness.run();
  await wait(150);
  harness.togglePause();
  assert.equal(harness.paused, true);
  await wait(150);
  harness.requestStop();

  // The whole point: a promise gate can hang here if requestStop forgets to open it.
  const outcome = await Promise.race([
    running.then(() => "resolved" as const),
    wait(8000).then(() => "timed-out" as const),
  ]);
  assert.equal(outcome, "resolved", "run() must resolve after stop, even while paused");
});

it("requestDrain() starts no new cases but finishes the running one", async () => {
  const fx = makeFixture({
    "tc-1": "slow",
    "tc-2": "slow",
    "tc-3": "slow",
    "tc-4": "slow",
    "tc-5": "slow",
  });
  const harness = makeHarness(fx, { parallel: 1 });
  const running = harness.run();
  await wait(120);
  harness.requestDrain();
  await running;

  const records = (harness as unknown as { records: unknown[] }).records;
  assert.ok(records.length >= 1, "the in-flight case finished");
  assert.ok(records.length < 5, `drain stopped dispatch (ran ${records.length} of 5)`);
});

/** When each case ran, from the records' own start/duration. */
interface Window {
  name: string;
  start: number;
  end: number;
}

function windows(harness: unknown): Window[] {
  const records = (harness as { records: { name: string; startedS: number; durationS: number }[] })
    .records;
  return records.map((r) => ({ name: r.name, start: r.startedS, end: r.startedS + r.durationS }));
}

const overlaps = (a: Window, b: Window): boolean => a.start < b.end && b.start < a.end;

it("tagged cases never overlap and an exclusive case runs alone", async () => {
  const fx = makeFixture({
    "tc-1": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-2": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-3": { mode: "slow" },
    "tc-4": { mode: "slow", parallel: false, tags: ["db"] },
    "tc-5": { mode: "slow", parallel: false },
    "tc-6": { mode: "slow" },
    "tc-7": { mode: "slow", parallel: false, tags: ["build", "db"] },
  });
  const harness = makeHarness(fx, { parallel: 4 });
  await harness.run();

  const runs = windows(harness);
  assert.equal(runs.length, 7, "every case ran");
  const tags: Record<string, string[]> = {
    "tc-1": ["build"],
    "tc-2": ["build"],
    "tc-3": [],
    "tc-4": ["db"],
    "tc-5": [],
    "tc-6": [],
    "tc-7": ["build", "db"],
  };
  for (const a of runs) {
    for (const b of runs) {
      if (a === b || !overlaps(a, b)) continue;
      const shared = tags[a.name]!.filter((t) => tags[b.name]!.includes(t));
      assert.deepEqual(shared, [], `${a.name} and ${b.name} overlapped holding ${shared}`);
      assert.notEqual(a.name, "tc-5", "tc-5 is exclusive and must run alone");
      assert.notEqual(b.name, "tc-5", "nothing may start beside tc-5");
    }
  }
  const parallelism = runs.filter((r) =>
    overlaps(
      r,
      runs.find((x) => x.name === "tc-3")!,
    ),
  ).length;
  assert.ok(parallelism > 1, "unconstrained cases still ran concurrently");
});

it("a stop while every worker is parked on a tag still resolves", async () => {
  // The new deadlock surface: parked workers are reached by sched.wake(), not by the pause gate.
  const fx = makeFixture({
    "tc-1": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-2": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-3": { mode: "slow", parallel: false, tags: ["build"] },
  });
  const harness = makeHarness(fx, { parallel: 3 });
  const running = harness.run();
  await wait(200); // one case in flight, two workers parked on the tag
  harness.requestStop();

  const outcome = await Promise.race([
    running.then(() => "resolved" as const),
    wait(8000).then(() => "timed-out" as const),
  ]);
  assert.equal(outcome, "resolved", "run() must resolve with workers parked on a tag");
});

it("each case runs under its own model, and that model reaches the record", async () => {
  const fx = makeFixture({
    "tc-1": { mode: "ok", model: "composer-2.5" },
    "tc-2": { mode: "ok" },
  });
  const harness = makeHarness(fx, { parallel: 2, model: "fallback-model" });
  await harness.run();

  const records = (harness as unknown as { records: { name: string; model: string }[] }).records;
  const byName = new Map(records.map((r) => [r.name, r.model]));
  assert.equal(byName.get("tc-1"), "composer-2.5", "the YAML model wins");
  assert.equal(byName.get("tc-2"), "fallback-model", "and --model fills in when there is none");

  const logRoot = (harness as unknown as { logRoot: string }).logRoot;
  const command = readFileSync(join(logRoot, "tc-1", "command.txt"), "utf8");
  assert.ok(command.includes("--model composer-2.5"), "it reached the actual argv");

  const summary = JSON.parse(readFileSync(join(logRoot, "summary.json"), "utf8")) as {
    default_model: string;
    cases: { name: string; model: string }[];
  };
  assert.equal(summary.default_model, "fallback-model");
  assert.equal(summary.cases.find((c) => c.name === "tc-1")?.model, "composer-2.5");
});

it("the pane list tracks the agents actually running", async () => {
  const fx = makeFixture({
    "tc-1": { mode: "slow" },
    "tc-2": { mode: "slow" },
    "tc-3": { mode: "slow", parallel: false },
  });
  const harness = makeHarness(fx, { parallel: 4 });

  assert.deepEqual(harness.viewModel().panes, [], "nothing running before the queue starts");

  const running = harness.run();
  await wait(200);
  const busy = harness.viewModel();
  assert.equal(busy.panes.length, 2, "two panes for two agents, not four for four slots");
  assert.equal(busy.running, 2);
  assert.deepEqual(busy.panes.map((p) => p.name).sort(), ["tc-1", "tc-2"]);
  assert.equal(busy.parallel, 4, "the cap is still reported");

  await running;
  const done = harness.viewModel();
  assert.ok(done.panes.length > 0, "the final frame keeps the results on screen");
  assert.equal(done.running, 0);
});

it("a queue held up by a tag shows why, instead of stale finished panes", async () => {
  const fx = makeFixture({
    "tc-1": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-2": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-3": { mode: "slow", parallel: false, tags: ["build"] },
  });
  const harness = makeHarness(fx, { parallel: 3 });
  const running = harness.run();
  await wait(200);
  const vm = harness.viewModel();
  assert.equal(vm.panes.length, 1, "only the one that got the tag");
  assert.ok(vm.queued >= 1, "the rest are still queued");
  await running;
});

it("a drain while every worker is parked on a tag still resolves", async () => {
  const fx = makeFixture({
    "tc-1": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-2": { mode: "slow", parallel: false, tags: ["build"] },
    "tc-3": { mode: "slow", parallel: false, tags: ["build"] },
  });
  const harness = makeHarness(fx, { parallel: 3 });
  const running = harness.run();
  await wait(200); // one in flight, two parked on the tag
  harness.requestDrain();

  const outcome = await Promise.race([
    running.then(() => "resolved" as const),
    wait(8000).then(() => "timed-out" as const),
  ]);
  assert.equal(outcome, "resolved", "drain must reach workers parked on a tag too");
  const records = (harness as unknown as { records: unknown[] }).records;
  assert.equal(records.length, 1, "the in-flight case finished; the parked ones never started");
});

it("an exclusive case gets the pane region to itself", async () => {
  const fx = makeFixture({
    "tc-1": { mode: "slow", parallel: false },
    "tc-2": { mode: "slow" },
    "tc-3": { mode: "slow" },
  });
  const harness = makeHarness(fx, { parallel: 3 });
  const running = harness.run();
  await wait(200);
  const vm = harness.viewModel();
  assert.equal(vm.panes.length, 1, "one pane, full height, while the barrier holds");
  assert.equal(vm.panes[0]?.name, "tc-1");
  await running;
});

it("a pane names the model its own case is running under", async () => {
  const fx = makeFixture({
    "tc-1": { mode: "slow", model: "composer-2.5" },
    "tc-2": { mode: "slow" },
  });
  const harness = makeHarness(fx, { parallel: 2, model: "fallback-model" });
  const running = harness.run();
  await wait(200);
  const models = new Map(harness.viewModel().panes.map((p) => [p.name, p.model]));
  assert.equal(models.get("tc-1"), "composer-2.5");
  assert.equal(models.get("tc-2"), "fallback-model");
  await running;
});

it("a case whose folder appears before dispatch is recorded skipped", async () => {
  const fx = makeFixture({ "tc-1": "ok", "tc-2": "ok" });
  const harness = makeHarness(fx, { parallel: 1 });
  // Create tc-2/ after discovery but before the worker reaches it.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(fx.runs, "tc-2"), { recursive: true });

  await harness.run();
  const records = (harness as unknown as { records: { name: string; status: string }[] }).records;
  const skipped = records.find((r) => r.name === "tc-2");
  assert.equal(skipped?.status, "skipped");
});
