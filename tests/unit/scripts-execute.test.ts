import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_SCRIPT_DEPTH,
  executeScript,
  exitStatusFor,
  scriptEnvironment,
  spawnPlan,
} from "../../src/scripts/execute.js";
import type { ScriptExecution } from "../../src/scripts/execute.js";
import type { ScriptDefinition } from "../../src/scripts/registry.js";

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-exec-")));
  for (const key of ["CAIRN_SCRIPT_DEPTH", "CAIRN_SCRIPT_STACK"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function execution(definition: ScriptDefinition, overrides: Partial<ScriptExecution> = {}) {
  return {
    mode: "capture" as const,
    definition,
    registry: { file: path.join(root, ".cairn.yml"), directory: root, scripts: new Map() },
    workingDirectory: root,
    invokedFrom: root,
    args: [],
    ...overrides,
  };
}

const run = (run: string, extra: Partial<ScriptDefinition> = {}): ScriptDefinition => ({
  name: "demo",
  run,
  cwd: { kind: "registry" },
  ...extra,
});

const exec = (argv: string[]): ScriptDefinition => ({
  name: "demo",
  exec: argv,
  cwd: { kind: "registry" },
});

describe("spawn plan", () => {
  it("passes run arguments as positional parameters, never as shell source", () => {
    const plan = spawnPlan(execution(run('echo "$@"'), { args: ["; rm -rf ~", "$(whoami)"] }));
    expect(plan.command).toBe("/bin/sh");
    // The body is one argv entry and each argument is its own entry, so the
    // shell binds them to $1..$n without lexing them.
    expect(plan.argv).toEqual(["-c", 'echo "$@"', "demo", "; rm -rf ~", "$(whoami)"]);
  });

  it("honors a shell override and defaults to /bin/sh", () => {
    expect(spawnPlan(execution(run("echo hi"))).command).toBe("/bin/sh");
    expect(spawnPlan(execution(run("echo hi", { shell: "/bin/bash" }))).command).toBe("/bin/bash");
  });

  it("appends forwarded arguments to an exec argv", () => {
    const plan = spawnPlan(execution(exec(["npm", "run", "lint"]), { args: ["--fix"] }));
    expect(plan.command).toBe("npm");
    expect(plan.argv).toEqual(["run", "lint", "--fix"]);
  });

  it("refuses to drop arguments a run body would ignore", () => {
    expect(() => spawnPlan(execution(run("echo hi"), { args: ["x"] }))).toThrow(
      'scripts.demo.run takes no positional parameters; add "$@" to forward arguments',
    );
    // Any positional reference satisfies it.
    expect(() => spawnPlan(execution(run("echo $1"), { args: ["x"] }))).not.toThrow();
    expect(() => spawnPlan(execution(run('echo "${2}"'), { args: ["x"] }))).not.toThrow();
  });
});

describe("execution", () => {
  it("captures stdout and reports a zero status", async () => {
    const outcome = await executeScript(execution(run("echo captured")));
    expect(outcome.stdout).toBe("captured\n");
    expect(outcome.code).toBe(0);
    expect(exitStatusFor(outcome)).toBe(0);
  });

  it("carries an argument containing shell metacharacters through untouched", async () => {
    const outcome = await executeScript(
      execution(run('printf "%s" "$1"'), { args: ["; echo pwned"] }),
    );
    expect(outcome.stdout).toBe("; echo pwned");
  });

  it("runs in the resolved working directory, not the caller's", async () => {
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    const outcome = await executeScript(
      execution(run("pwd"), { workingDirectory: nested, invokedFrom: root }),
    );
    expect(outcome.stdout.trim()).toBe(nested);
  });

  it("reports a non-zero status", async () => {
    const outcome = await executeScript(execution(run("exit 7")));
    expect(outcome.code).toBe(7);
    expect(exitStatusFor(outcome)).toBe(7);
  });

  it("reports a signal as 128 + the signal number", async () => {
    const outcome = await executeScript(execution(run("kill -TERM $$")));
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.code).toBeNull();
    expect(exitStatusFor(outcome)).toBe(128 + os.constants.signals.SIGTERM);
  });

  it("distinguishes a child that never started from one that failed", async () => {
    const outcome = await executeScript(execution(exec(["definitely-not-a-real-program-xyz"])));
    expect(outcome.startupError).toBeTruthy();
    expect(outcome.code).toBeNull();
    expect(exitStatusFor(outcome)).toBe(1);
  });

  it("passes the script's identity and origin in the environment", () => {
    const env = scriptEnvironment(execution(run("true")));
    expect(env.CAIRN_SCRIPT_NAME).toBe("demo");
    expect(env.CAIRN_SCRIPT_ROOT).toBe(root);
    expect(env.CAIRN_SCRIPT_REGISTRY).toBe(path.join(root, ".cairn.yml"));
    expect(env.CAIRN_INVOKED_FROM).toBe(root);
    expect(env.CAIRN_SCRIPT_DEPTH).toBe("1");
    expect(env.CAIRN_NO_UPDATE_NOTIFIER).toBe("1");
  });

  it("refuses a script that is already on the stack", async () => {
    process.env.CAIRN_SCRIPT_STACK = `${path.join(root, ".cairn.yml")}#demo`;
    await expect(executeScript(execution(run("true")))).rejects.toThrow(
      "Script recursion detected: 'demo' is already running",
    );
  });

  it("refuses past the depth limit", async () => {
    process.env.CAIRN_SCRIPT_DEPTH = String(MAX_SCRIPT_DEPTH);
    await expect(executeScript(execution(run("true")))).rejects.toThrow(
      `Script recursion limit exceeded (${MAX_SCRIPT_DEPTH})`,
    );
  });
});

describe("exit status", () => {
  it("never turns a failing child into a success", () => {
    // 256 truncates to 0 under a bare & 0xff, which would report success.
    expect(exitStatusFor({ code: 256, signal: null, durationMs: 0 })).toBe(1);
    expect(exitStatusFor({ code: 3, signal: null, durationMs: 0 })).toBe(3);
    expect(exitStatusFor({ code: null, signal: null, durationMs: 0 })).toBe(1);
  });
});
