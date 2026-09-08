import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "vitest";
import { acquireLock } from "../../../src/qa/lock.js";
import { UserError } from "../../../src/qa/config.js";

const runsDir = (): string => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "tcl-"))), "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
};

// The two implementations refuse contention differently, and a single test can
// only assert what the running platform actually guarantees. The kernel lock is
// held by an open fd, so it refuses a second acquire from anyone including this
// process. The fallback is a pid file, and it deliberately lets a process
// reclaim its *own* leftover lock -- real contention there is another live pid.
// Asserting the kernel's behaviour everywhere passed on macOS and failed on
// Linux, which is exactly the gap the split makes visible.
const KERNEL_LOCK = process.platform === "darwin" || process.platform.endsWith("bsd");

it.skipIf(!KERNEL_LOCK)("kernel lock: a second acquire is refused and names the holder", () => {
  const runs = runsDir();
  const first = acquireLock(runs);
  try {
    assert.throws(
      () => acquireLock(runs),
      (err: unknown) =>
        err instanceof UserError &&
        err.message.includes("another harness already holds") &&
        err.message.includes(String(process.pid)),
    );
  } finally {
    first.release();
  }
});

it.skipIf(KERNEL_LOCK)("pid file: a lock held by another live process is refused", () => {
  // The parent of the test runner: a real pid, alive, and not this process.
  // `readPid` rejects anything <= 1, so an orphaned runner would invalidate this.
  assert.ok(process.ppid > 1, "expected a real parent pid to stand in for another harness");
  const runs = runsDir();
  writeFileSync(join(runs, ".harness.lock"), String(process.ppid));
  assert.throws(
    () => acquireLock(runs),
    (err: unknown) =>
      err instanceof UserError &&
      err.message.includes("another harness already holds") &&
      err.message.includes(String(process.ppid)),
  );
});

it.skipIf(KERNEL_LOCK)("pid file: this process reclaims its own leftover lock", () => {
  // Not contention: a crash can leave the file behind, and the next run of the
  // same process must not be locked out by its own corpse.
  const runs = runsDir();
  writeFileSync(join(runs, ".harness.lock"), String(process.pid));
  const lock = acquireLock(runs);
  lock.release();
});

it.skipIf(KERNEL_LOCK)("pid file: a lock naming a dead process is reclaimed", () => {
  const runs = runsDir();
  // A pid that cannot be running: above the platform maximum.
  writeFileSync(join(runs, ".harness.lock"), "4194304");
  const lock = acquireLock(runs);
  lock.release();
});

it("the lock is re-acquirable after release", () => {
  const runs = runsDir();
  acquireLock(runs).release();
  const again = acquireLock(runs);
  again.release();
  assert.ok(true, "no throw");
});

it("release is idempotent", () => {
  const runs = runsDir();
  const lock = acquireLock(runs);
  lock.release();
  lock.release();
  assert.ok(true, "no throw");
});

it("the lock file records our pid", () => {
  const runs = runsDir();
  const lock = acquireLock(runs);
  try {
    assert.equal(readFileSync(lock.path, "utf8").trim(), String(process.pid));
  } finally {
    lock.release();
  }
});

it("a lock file left by a dead process is reclaimed", () => {
  const runs = runsDir();
  const path = join(runs, ".harness.lock");
  // PID 2^22 is above the max on Linux and macOS, so it cannot be live.
  writeFileSync(path, "4194303");
  const lock = acquireLock(runs);
  try {
    assert.equal(readFileSync(path, "utf8").trim(), String(process.pid), "stale lock stolen");
  } finally {
    lock.release();
  }
});

it("the lock path lives inside the runs dir", () => {
  const runs = runsDir();
  const lock = acquireLock(runs);
  try {
    assert.equal(lock.path, join(runs, ".harness.lock"));
    assert.ok(existsSync(lock.path));
  } finally {
    lock.release();
  }
});
