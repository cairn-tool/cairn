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

it("a second acquire is refused and names the holding pid", () => {
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
