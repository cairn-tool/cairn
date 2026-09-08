import assert from "node:assert/strict";
import { it } from "vitest";
import { Case } from "../../../src/qa/cases.js";
import type { CaseFile } from "../../../src/qa/casefile.js";
import { Scheduler } from "../../../src/qa/schedule.js";

/** A case with only the fields the scheduler reads set meaningfully. */
function kase(name: string, parallel = true, tags: string[] = [], agent = "cursor"): Case {
  const spec: CaseFile = {
    name,
    number: Number.parseInt(name.slice(3), 10),
    file: `/repo/runs/_plans/${name}.yaml`,
    id: name.toUpperCase(),
    title: name,
    agent,
    model: null,
    parallel,
    tags,
    plan: "# x\n",
  };
  return new Case(spec, `/repo/runs/${name}`, "/repo", "model-x");
}

const taken = (s: Scheduler, n: number): Array<string | null> =>
  Array.from({ length: n }, () => s.take()?.name ?? null);

it("parallel cases dispatch in queue order, as many as are asked for", () => {
  const sched = new Scheduler([kase("tc-1"), kase("tc-2"), kase("tc-3")]);
  assert.deepEqual(taken(sched, 4), ["tc-1", "tc-2", "tc-3", null]);
  assert.equal(sched.size, 0);
  assert.equal(sched.inFlight, 3);
});

it("two cases sharing a tag never run at once", () => {
  const sched = new Scheduler([
    kase("tc-1", false, ["build"]),
    kase("tc-2", false, ["build"]),
    kase("tc-3"),
  ]);
  const first = sched.take()!;
  assert.equal(first.name, "tc-1");
  // tc-2 is blocked on the tag, so the scan continues past it rather than stalling.
  assert.equal(sched.take()?.name, "tc-3");
  assert.equal(sched.take(), null, "tc-2 still cannot start");
  assert.match(sched.blockedReason() ?? "", /waiting on tag: build/);
  sched.release(first);
  assert.equal(sched.take()?.name, "tc-2", "the tag is free again");
});

it("cases with disjoint tags run together", () => {
  const sched = new Scheduler([kase("tc-1", false, ["build"]), kase("tc-2", false, ["db"])]);
  assert.deepEqual(taken(sched, 2), ["tc-1", "tc-2"]);
});

it("a tag list is held whole — any overlap blocks", () => {
  const sched = new Scheduler([
    kase("tc-1", false, ["build", "db"]),
    kase("tc-2", false, ["db"]),
    kase("tc-3", false, ["net"]),
  ]);
  assert.equal(sched.take()?.name, "tc-1");
  assert.equal(sched.take()?.name, "tc-3", "tc-2 overlaps on db and is skipped");
  assert.equal(sched.take(), null);
});

it("an exclusive case waits for every agent to finish, and blocks the queue behind it", () => {
  const one = kase("tc-1");
  const sched = new Scheduler([one, kase("tc-2", false), kase("tc-3")]);
  assert.equal(sched.take()?.name, "tc-1");
  assert.equal(sched.take(), null, "tc-2 is a barrier — tc-3 must not jump it");
  assert.match(sched.blockedReason() ?? "", /waiting for 1 agent\(s\) to finish before tc-2/);
  sched.release(one);
  assert.equal(sched.take()?.name, "tc-2", "now that nothing is running it may start");
});

it("nothing runs beside an exclusive case", () => {
  const solo = kase("tc-1", false);
  const sched = new Scheduler([solo, kase("tc-2"), kase("tc-3")]);
  assert.equal(sched.take()?.name, "tc-1");
  assert.equal(sched.take(), null);
  assert.match(sched.blockedReason() ?? "", /tc-1 is running alone/);
  sched.release(solo);
  assert.deepEqual(taken(sched, 2), ["tc-2", "tc-3"], "dispatch resumes afterwards");
});

it("an empty queue reports no blockage — that is completion, not a stall", () => {
  const sched = new Scheduler([]);
  assert.equal(sched.take(), null);
  assert.equal(sched.blockedReason(), null);
});

it("releasing a case it never took does not corrupt the counters", () => {
  const sched = new Scheduler([kase("tc-1")]);
  sched.release(kase("tc-9"));
  assert.equal(sched.inFlight, 0, "the running count floors at zero");
  assert.equal(sched.take()?.name, "tc-1");
});

it("the generation guard turns a wake into an immediate re-scan", async () => {
  const sched = new Scheduler([kase("tc-1", false, ["build"]), kase("tc-2", false, ["build"])]);
  const held = sched.take()!;
  const generation = sched.generationId;
  assert.equal(sched.take(), null, "blocked on the tag");
  // A release landing between the sample and the park must not be slept through.
  sched.release(held);
  await sched.changed(generation);
  assert.equal(sched.take()?.name, "tc-2", "we woke rather than parking forever");
});

it("a parked worker is woken by a release", async () => {
  const sched = new Scheduler([kase("tc-1", false, ["build"]), kase("tc-2", false, ["build"])]);
  const held = sched.take()!;
  const generation = sched.generationId;
  assert.equal(sched.take(), null);
  const parked = sched.changed(generation);
  let woken = false;
  void parked.then(() => {
    woken = true;
  });
  await Promise.resolve();
  assert.equal(woken, false, "still parked while the tag is held");
  sched.release(held);
  await parked;
  assert.equal(woken, true);
});

it("wake() releases parked workers without freeing anything — the stop path", async () => {
  const sched = new Scheduler([kase("tc-1", false, ["build"]), kase("tc-2", false, ["build"])]);
  sched.take();
  const generation = sched.generationId;
  assert.equal(sched.take(), null);
  const parked = sched.changed(generation);
  sched.wake();
  await parked; // resolves, so a worker can observe stopLevel and exit
  assert.equal(sched.inFlight, 1, "nothing was released");
});

it("the queue can never stall: something is always startable with nothing running", () => {
  // The anti-deadlock invariant, over a randomised mix of every constraint shape.
  const shapes: Array<() => [boolean, string[]]> = [
    () => [true, []],
    () => [false, []],
    () => [false, ["build"]],
    () => [false, ["db"]],
    () => [false, ["build", "db"]],
    () => [false, ["net"]],
  ];
  for (let seed = 0; seed < 200; seed += 1) {
    let x = seed * 2654435761 + 1;
    const rand = (n: number): number => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x % n;
    };
    const queue = Array.from({ length: 10 }, (_, i) => {
      const [parallel, tags] = shapes[rand(shapes.length)]!();
      return kase(`tc-${i + 1}`, parallel, tags);
    });
    const sched = new Scheduler(queue);
    const running: Case[] = [];
    let steps = 0;
    while (sched.size > 0 || running.length > 0) {
      assert.ok((steps += 1) < 1000, `seed ${seed}: no progress`);
      const next = running.length < 4 ? sched.take() : null;
      if (next !== null) {
        running.push(next);
        continue;
      }
      assert.ok(
        running.length > 0,
        `seed ${seed}: nothing running and nothing startable with ${sched.size} queued`,
      );
      // Finish one at random, the way real agents complete out of order.
      const [done] = running.splice(rand(running.length), 1);
      sched.release(done!);
    }
  }
});

it("constraints hold at every moment of a randomised run", () => {
  for (let seed = 0; seed < 200; seed += 1) {
    let x = seed * 40503 + 7;
    const rand = (n: number): number => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x % n;
    };
    const pool = [
      [true, []],
      [false, []],
      [false, ["build"]],
      [false, ["db"]],
      [false, ["build", "db"]],
    ] as Array<[boolean, string[]]>;
    const queue = Array.from({ length: 12 }, (_, i) => {
      const [parallel, tags] = pool[rand(pool.length)]!;
      return kase(`tc-${i + 1}`, parallel, tags);
    });
    const sched = new Scheduler(queue);
    const running: Case[] = [];
    while (sched.size > 0 || running.length > 0) {
      const next = running.length < 5 ? sched.take() : null;
      if (next !== null) {
        // No two running cases may share a tag.
        for (const other of running) {
          for (const tag of next.tags) {
            assert.ok(!other.tags.includes(tag), `seed ${seed}: ${tag} held twice`);
          }
        }
        // An exclusive case runs alone, in both directions.
        const exclusive = (c: Case): boolean => !c.parallel && c.tags.length === 0;
        assert.ok(!exclusive(next) || running.length === 0, `seed ${seed}: exclusive not alone`);
        assert.ok(!running.some(exclusive), `seed ${seed}: started beside an exclusive case`);
        running.push(next);
        continue;
      }
      const [done] = running.splice(rand(running.length), 1);
      sched.release(done!);
    }
  }
});

it("a per-agent cap skips a backend at maxParallel when something is already running", () => {
  const sched = new Scheduler(
    [
      kase("tc-1", true, [], "cursor"),
      kase("tc-2", true, [], "cursor"),
      kase("tc-3", true, [], "claude-code"),
    ],
    new Map([
      ["cursor", 1],
      ["claude-code", 8],
    ]),
  );
  assert.equal(sched.take()?.name, "tc-1");
  assert.equal(sched.take()?.name, "tc-3", "cursor is at cap; claude-code is not");
  assert.equal(sched.take(), null);
  assert.match(sched.blockedReason() ?? "", /waiting on agent cap: cursor/);
});

it("skips the cap when the queue is idle so a cap of 1 cannot deadlock", () => {
  const sched = new Scheduler(
    [kase("tc-1", true, [], "cursor"), kase("tc-2", true, [], "cursor")],
    new Map([["cursor", 1]]),
  );
  const first = sched.take()!;
  assert.equal(first.name, "tc-1");
  assert.equal(sched.take(), null);
  sched.release(first);
  assert.equal(sched.take()?.name, "tc-2", "idle queue ignores the cap");
});
