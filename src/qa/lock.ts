import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { UserError } from "./config.js";

/**
 * darwin/BSD O_EXLOCK. Node does not export it, but passes numeric flags straight to open(2),
 * so this gives a true kernel flock(LOCK_EX|LOCK_NB) — auto-released on death, exactly like the
 * Python's fcntl.flock. On Linux 0x20 is an undefined bit that open(2) SILENTLY IGNORES, which
 * would produce a lock that does nothing, so the platform gate is load-bearing.
 */
const O_EXLOCK = 0x20;
const KERNEL_LOCK = process.platform === "darwin" || process.platform.endsWith("bsd");

export interface Lock {
  readonly path: string;
  release(): void;
}

function readPid(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    // Reject 0 and negatives: process.kill(0, …) and kill(-n, …) hit our own process group.
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function held(path: string): never {
  const pid = readPid(path);
  throw new UserError(`another harness already holds ${path} (pid ${pid ?? "?"})`);
}

export function acquireLock(runsDir: string): Lock {
  const path = join(runsDir, ".harness.lock");
  mkdirSync(dirname(path), { recursive: true });

  if (KERNEL_LOCK) {
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK,
        0o644,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw err;
      held(path);
    }
    ftruncateSync(fd, 0);
    writeSync(fd, String(process.pid), 0);
    let released = false;
    return {
      path,
      release(): void {
        if (released) return;
        released = true;
        // The kernel drops the lock on close; leave the file, as flock does.
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      },
    };
  }

  // Portable fallback: O_EXCL plus a liveness probe standing in for the kernel's auto-release.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = readPid(path);
      if (pid !== null && pid !== process.pid && isAlive(pid)) held(path);
      try {
        unlinkSync(path);
      } catch {
        /* another starter already reclaimed it */
      }
      continue;
    }
    writeSync(fd, String(process.pid));
    let released = false;
    return {
      path,
      release(): void {
        if (released) return;
        released = true;
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
        try {
          if (readPid(path) === process.pid) unlinkSync(path);
        } catch {
          /* gone, or stolen after a stale-detection window */
        }
      },
    };
  }
  held(path);
}
