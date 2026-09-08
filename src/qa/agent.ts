import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { flatten, isBlank } from "./format.js";
import { signalNumber } from "./async.js";
import { shellJoin } from "./cases.js";

export interface AgentSpec {
  argv: string[];
  cwd: string;
  logDir: string;
  timeoutMs: number;
  onBytes(n: number): void;
  onEvent(event: Record<string, unknown>): void;
  onRawLine(line: string): void;
  onSpawn(child: ChildProcess): void;
}

export interface AgentRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Signal the whole process group — `detached: true` gave the child its own session, so a
 * negative pid reaches cursor-agent and everything it spawned. Never uses `child.killed` as a
 * guard: that stays false when the group is signalled directly.
 */
export function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, sig);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    try {
      child.kill(sig);
    } catch {
      /* already reaped */
    }
  }
}

/** Python reports -9 for a SIGKILLed child; Node reports {code: null, signal}. */
export function effectiveExitCode(code: number | null, sig: NodeJS.Signals | null): number | null {
  if (code !== null) return code;
  return sig ? -signalNumber(sig) : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function runAgent(spec: AgentSpec): Promise<AgentRun> {
  mkdirSync(spec.logDir, { recursive: true });
  writeFileSync(join(spec.logDir, "command.txt"), `${shellJoin(spec.argv)}\n`, "utf8");

  const [file, ...args] = spec.argv;
  const child = spawn(file!, args, {
    cwd: spec.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // == start_new_session=True; do NOT unref, we must await this child
  });

  // Python raises FileNotFoundError synchronously; Node reports it on 'error'. Convert it back
  // so a bad --agent becomes a per-case error record, not an unhandled rejection.
  //
  // Both listeners are removed as soon as one of them wins. A bare Promise.race leaves the
  // loser attached, and Node emits 'error' on a ChildProcess *after* spawn when a kill fails
  // — reachable from killGroup, where a process.kill(-pid) failing with anything but ESRCH
  // falls through to child.kill(). That would reject a promise nothing awaits, and Cleanup's
  // unhandled-rejection handler calls process.exit(1), tearing down every other running case
  // and truncating a pending --format json write.
  await new Promise<void>((resolve, reject) => {
    const onSpawned = (): void => {
      child.off("error", onFailed);
      resolve();
    };
    const onFailed = (err: Error): void => {
      child.off("spawn", onSpawned);
      reject(err);
    };
    child.once("spawn", onSpawned);
    child.once("error", onFailed);
  });
  spec.onSpawn(child);

  // Note: Node reads up to its 64 KiB highWaterMark rather than the Python's 8 KiB, and spawn
  // does not expose that knob for stdio pipes. The streamed-bytes total is identical; only the
  // on-screen counter's step size differs.

  const streamFd = openSync(join(spec.logDir, "stream.jsonl"), "a");
  const stderrFd = openSync(join(spec.logDir, "stderr.txt"), "w");

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGKILL");
  }, spec.timeoutMs);

  const pumpStderr = (async (): Promise<void> => {
    for await (const chunk of child.stderr!) writeSync(stderrFd, chunk as Buffer);
  })();

  const pumpStdout = (async (): Promise<void> => {
    // StringDecoder holds a multi-byte character split across a chunk boundary. The Python
    // decodes each chunk independently and corrupts those.
    const decoder = new StringDecoder("utf8");
    let buf = "";
    // One path for every line, so the final unterminated one is parsed rather than merely
    // logged. An agent whose last line lacks a newline would otherwise lose its `result`
    // event entirely — the case recording usage: null while stream.jsonl shows the tokens.
    const dispatch = (line: string): void => {
      if (isBlank(line)) return;
      writeSync(streamFd, `${line}\n`);
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        spec.onRawLine(flatten(line).slice(0, 200));
        return;
      }
      if (isRecord(obj)) spec.onEvent(obj);
    };
    for await (const chunk of child.stdout!) {
      const bytes = chunk as Buffer;
      spec.onBytes(bytes.length);
      buf += decoder.write(bytes);
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        dispatch(line);
      }
    }
    buf += decoder.end();
    dispatch(buf);
  })();

  try {
    // 'close' fires after both pipes hit EOF *and* the child exits — the faithful composite of
    // the Python's `async with asyncio.timeout(...): await read_stdout(); await proc.wait()`.
    const [code, sig] = (await Promise.all([pumpStdout, pumpStderr, once(child, "close")]).then(
      ([, , closed]) => closed,
    )) as [number | null, NodeJS.Signals | null];
    return { exitCode: effectiveExitCode(code, sig), signal: sig, timedOut };
  } finally {
    clearTimeout(timer);
    for (const fd of [streamFd, stderrFd]) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}
