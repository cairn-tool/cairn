import os from "node:os";
import { spawn } from "node:child_process";
import type { ScriptDefinition, ScriptRegistry } from "./registry.js";

/**
 * Runs a resolved script.
 *
 * This is the only module in the tool that executes anything, and the shape of
 * both forms is chosen to keep argument content out of anything that gets
 * re-parsed. `exec:` hands an argv array straight to `execve`. `run:` passes the
 * body to `sh -c` and the forwarded arguments as *separate* argv entries, which
 * the shell binds to `$1…$n` without ever lexing them as source — so an argument
 * containing `; rm -rf ~` is one inert positional parameter. Building a command
 * line by interpolating arguments into the body, or reaching for
 * `spawn(cmd, { shell: true })`, would give that guarantee away.
 */

/** POSIX default. Not `$SHELL`: a login shell may be fish or csh, neither of
 * which binds positional parameters for `-c`, which would make a registry
 * behave differently on different machines — the exact problem this feature
 * exists to solve. */
const DEFAULT_SHELL = "/bin/sh";

/** Captured output past this is dropped, but still drained. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** Deep enough for real composition, shallow enough to stop a runaway. */
export const MAX_SCRIPT_DEPTH = 8;

const DEPTH_VARIABLE = "CAIRN_SCRIPT_DEPTH";
const STACK_VARIABLE = "CAIRN_SCRIPT_STACK";
const LEGACY_DEPTH_VARIABLE = "CLAUDE_CLI_SCRIPT_DEPTH";
const LEGACY_STACK_VARIABLE = "CLAUDE_CLI_SCRIPT_STACK";

/** `$1`, `${1}`, `$@`, `$*` — any reference to a positional parameter. */
const POSITIONAL_PARAMETER = /\$\{?[0-9@*]/;

export interface ScriptExecution {
  /** `pass-through` for llm and human, `capture` for json. */
  mode: "pass-through" | "capture";
  definition: ScriptDefinition;
  registry: ScriptRegistry;
  workingDirectory: string;
  invokedFrom: string;
  /** Verbatim tokens after the first `--`. */
  args: readonly string[];
}

export interface ScriptOutcome {
  /** The child's status, or null when a signal killed it or it never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Capture mode only. */
  stdout?: string;
  stderr?: string;
  truncated?: { stdout: boolean; stderr: boolean };
  durationMs: number;
  /** Set when the child could not be started at all. */
  startupError?: string;
}

// Both spellings are read as well as written. A script from before the rename
// may re-export only the legacy variable, and reading just the current one there
// would reset the counter to zero and defeat the recursion guard entirely.
function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env[DEPTH_VARIABLE] ?? env[LEGACY_DEPTH_VARIABLE] ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function currentStack(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[STACK_VARIABLE] ?? env[LEGACY_STACK_VARIABLE];
  return raw ? raw.split("\n").filter(Boolean) : [];
}

function frameFor(execution: ScriptExecution): string {
  return `${execution.registry.file}#${execution.definition.name}`;
}

/**
 * The child's environment.
 *
 * Every variable is exported under both the current and the pre-rename spelling.
 * A script is user code this tool does not get to edit, so one already reading
 * `CLAUDE_CLI_SCRIPT_ROOT` has to keep working; duplicating six variables is the
 * cheap half of that bargain.
 */
export function scriptEnvironment(execution: ScriptExecution): NodeJS.ProcessEnv {
  const depth = String(currentDepth() + 1);
  const stack = [...currentStack(), frameFor(execution)].join("\n");
  return {
    ...process.env,
    CAIRN_SCRIPT_NAME: execution.definition.name,
    CAIRN_SCRIPT_ROOT: execution.registry.directory,
    CAIRN_SCRIPT_REGISTRY: execution.registry.file,
    CAIRN_INVOKED_FROM: execution.invokedFrom,
    [DEPTH_VARIABLE]: depth,
    [STACK_VARIABLE]: stack,
    CLAUDE_CLI_SCRIPT_NAME: execution.definition.name,
    CLAUDE_CLI_SCRIPT_ROOT: execution.registry.directory,
    CLAUDE_CLI_SCRIPT_REGISTRY: execution.registry.file,
    CLAUDE_CLI_INVOKED_FROM: execution.invokedFrom,
    [LEGACY_DEPTH_VARIABLE]: depth,
    [LEGACY_STACK_VARIABLE]: stack,
    // A nested `cairn` must not write an update notice into a stream the outer
    // hook is capturing. The argv gate in src/update-notifier.ts covers this
    // invocation; this covers every one the script makes.
    CAIRN_NO_UPDATE_NOTIFIER: "1",
    CLAUDE_CLI_NO_UPDATE_NOTIFIER: "1",
  };
}

/**
 * Refuses a script that is already running.
 *
 * This is a footgun guard, not a security control — a script can clear either
 * variable. It exists so a self-referential definition fails immediately instead
 * of forking until something else gives out.
 */
export function checkRecursionDepth(execution: ScriptExecution): void {
  if (currentStack().includes(frameFor(execution))) {
    throw new Error(
      `Script recursion detected: '${execution.definition.name}' is already running from ${execution.registry.file}`,
    );
  }
  if (currentDepth() >= MAX_SCRIPT_DEPTH) {
    throw new Error(
      `Script recursion limit exceeded (${MAX_SCRIPT_DEPTH}): '${execution.definition.name}'`,
    );
  }
}

interface SpawnPlan {
  command: string;
  argv: string[];
}

/**
 * The program and argv for one script.
 *
 * Exported for the unit tests, which assert the exact argv rather than
 * inspecting behavior through a child process.
 */
export function spawnPlan(execution: ScriptExecution): SpawnPlan {
  const { definition, args } = execution;

  if (definition.exec) {
    return { command: definition.exec[0], argv: [...definition.exec.slice(1), ...args] };
  }

  const body = definition.run!;
  if (process.platform === "win32") {
    // cmd.exe has no positional-parameter mechanism, and emulating one means
    // splicing caller-supplied text into a command line.
    if (args.length > 0) {
      throw new Error(
        `Script '${definition.name}' uses run: and cannot forward arguments on Windows; use exec:`,
      );
    }
    const shell = definition.shell ?? process.env.ComSpec ?? "cmd.exe";
    return { command: shell, argv: ["/d", "/s", "/c", body] };
  }

  if (args.length > 0 && !POSITIONAL_PARAMETER.test(body)) {
    throw new Error(
      `scripts.${definition.name}.run takes no positional parameters; add "$@" to forward arguments`,
    );
  }
  // `$0` is the script name rather than `sh`, so `set -u` and syntax errors name
  // the script a reader can find.
  return {
    command: definition.shell ?? DEFAULT_SHELL,
    argv: ["-c", body, definition.name, ...args],
  };
}

function collect(
  stream: NodeJS.ReadableStream,
  onDone: (text: string, truncated: boolean) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer) => {
    // Past the cap the data is dropped but the stream keeps flowing: pausing it
    // fills the OS pipe buffer and deadlocks the child.
    if (size < MAX_CAPTURE_BYTES) {
      chunks.push(chunk);
      size += chunk.length;
    } else {
      truncated = true;
    }
  });
  stream.on("end", () => onDone(Buffer.concat(chunks).toString("utf-8"), truncated));
}

export async function executeScript(execution: ScriptExecution): Promise<ScriptOutcome> {
  checkRecursionDepth(execution);
  const plan = spawnPlan(execution);
  const capture = execution.mode === "capture";
  const started = Date.now();

  return await new Promise<ScriptOutcome>((resolve) => {
    // stdin is inherited in both modes: a hook piping a payload into a script is
    // ordinary, and stdin is never part of the captured output.
    const child = spawn(plan.command, plan.argv, {
      cwd: execution.workingDirectory,
      env: scriptEnvironment(execution),
      stdio: capture ? ["inherit", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let truncatedOut = false;
    let truncatedErr = false;
    let pending = 0;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;

    // Forwarded without exiting, so the parent survives long enough to write its
    // payload. `once` means a second interrupt reaches Node's default handler,
    // so a child that ignores SIGINT cannot make this process unkillable.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInterrupt = forward("SIGINT");
    const onTerminate = forward("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);

    const settle = (outcome: Omit<ScriptOutcome, "durationMs">) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      resolve({ ...outcome, durationMs: Date.now() - started });
    };

    const finish = () => {
      if (!closed || pending > 0) return;
      settle({
        code: closed.code,
        signal: closed.signal,
        ...(capture
          ? { stdout, stderr, truncated: { stdout: truncatedOut, stderr: truncatedErr } }
          : {}),
      });
    };

    if (capture && child.stdout && child.stderr) {
      pending = 2;
      collect(child.stdout, (text, truncated) => {
        stdout = text;
        truncatedOut = truncated;
        pending--;
        finish();
      });
      collect(child.stderr, (text, truncated) => {
        stderr = text;
        truncatedErr = truncated;
        pending--;
        finish();
      });
    }

    // ENOENT, EACCES, or a rejected argument. Both `error` and `close` can fire;
    // `settled` keeps the first one authoritative.
    child.on("error", (error: Error) => {
      settle({
        code: null,
        signal: null,
        startupError: error.message,
        ...(capture ? { stdout, stderr, truncated: { stdout: false, stderr: false } } : {}),
      });
    });

    child.on("close", (code, signal) => {
      closed = { code, signal };
      finish();
    });
  });
}

/**
 * The status this process exits with when it passes the child's through.
 *
 * A bare `code & 0xff` would map 256 to 0, reporting success for a child that
 * failed, so an out-of-range code that truncates to zero becomes 1 instead.
 */
export function exitStatusFor(outcome: ScriptOutcome): number {
  if (outcome.startupError) return 1;
  if (outcome.signal) return 128 + (os.constants.signals[outcome.signal] ?? 0);
  const code = outcome.code ?? 1;
  if (code >= 0 && code <= 255) return code;
  return code & 0xff || 1;
}
