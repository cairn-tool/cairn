import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const hook = path.resolve("plugins/cairn-agent/hooks/guard-generated.mjs");
const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(cwd: string, ...args: string[]): Promise<Run> {
  try {
    const result = await exec("node", [cli, ...args], { cwd, env: { ...process.env, CI: "1" } });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

/**
 * Runs the bundle's hook script with `event` on stdin, against a PATH where
 * `cairn` is this build. The shim is what makes the test exercise the script's
 * real `spawnSync("cairn", …)` rather than a stubbed call.
 */
async function runHook(cwd: string, shimDir: string, event: unknown): Promise<Run> {
  const child = execFile(
    "node",
    [hook],
    {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
    () => undefined,
  );
  child.stdin?.end(JSON.stringify(event));
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = await new Promise<number>((resolve) =>
    child.on("close", (code) => resolve(code ?? 0)),
  );
  return { stdout, stderr, exitCode };
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

/** A repository with one bundle, a `.cairn.yml`, and a `cairn` shim on PATH. */
function workspace(guard = "  guard:\n    mode: block\n"): { root: string; shim: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-e2e-")));
  temporary.push(root);
  write(
    path.join(root, "bundles/demo/agent-bundle.yaml"),
    'schemaVersion: "2"\nname: demo\nversion: 1.0.0\ndescription: Demo.\n',
  );
  write(
    path.join(root, "bundles/demo/skills/greet/SKILL.md"),
    "---\nname: greet\ndescription: Say hello.\n---\n\n# Greet\n",
  );
  write(
    path.join(root, ".cairn.yml"),
    [
      "version: 1",
      "agent:",
      "  install:",
      "    targets: [claude-code, codex, cursor]",
      "    scope: project",
      "    into: .",
      "    bundles:",
      "      - path: bundles/demo",
      guard,
    ].join("\n"),
  );
  const shim = path.join(root, ".shim");
  write(path.join(shim, "cairn"), `#!/bin/sh\nexec node ${cli} "$@"\n`, 0o755);
  return { root, shim };
}

function payload(result: Run): Record<string, unknown> {
  return (JSON.parse(result.stdout) as { guard: Record<string, unknown> }).guard;
}

describe("agent guard", () => {
  it("exits 0 and reports not-configured where no block is declared", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-bare-")));
    temporary.push(root);
    write(path.join(root, "notes.md"), "# Notes\n");
    const result = await run(root, "agent", "guard", "notes.md", "--format", "json");
    expect(result.exitCode).toBe(0);
    expect(payload(result)).toMatchObject({ reason: "not-configured", decision: "allow" });
    expect(result.stderr).toBe("");
  });

  it("blocks a generated file and names the bundle source on stdout", async () => {
    const { root } = workspace();
    expect((await run(root, "agent", "install", "--config", ".cairn.yml")).exitCode).toBe(0);

    const result = await run(
      root,
      "agent",
      "guard",
      ".claude/skills/greet/SKILL.md",
      "--format",
      "json",
    );
    expect(result.exitCode).toBe(2);
    // Every agent subcommand puts findings on stdout, including this one.
    expect(result.stderr).toBe("");
    expect(payload(result)).toMatchObject({
      decision: "block",
      reason: "generated",
      bundle: { name: "demo", path: "bundles/demo" },
      sources: ["bundles/demo/skills/greet/SKILL.md"],
    });
  });

  it("blocks the same file for every target the install declares", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    for (const generated of [
      ".claude/skills/greet/SKILL.md",
      ".agents/skills/greet/SKILL.md",
      ".cursor/skills/greet/SKILL.md",
    ]) {
      const result = await run(root, "agent", "guard", generated, "--format", "json");
      expect(result.exitCode, generated).toBe(2);
      expect(payload(result).sources).toEqual(["bundles/demo/skills/greet/SKILL.md"]);
    }
  });

  it("allows the bundle source and an unrelated file", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    for (const allowed of ["bundles/demo/skills/greet/SKILL.md", ".cairn.yml"]) {
      const result = await run(root, "agent", "guard", allowed, "--format", "json");
      expect(result.exitCode, allowed).toBe(0);
      expect(payload(result).decision).toBe("allow");
    }
  });

  it("warns without blocking under mode: warn", async () => {
    const { root } = workspace("  guard:\n    mode: warn\n");
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const result = await run(
      root,
      "agent",
      "guard",
      ".claude/skills/greet/SKILL.md",
      "--format",
      "json",
    );
    expect(result.exitCode).toBe(0);
    expect(payload(result)).toMatchObject({ decision: "warn", reason: "generated" });
  });

  it("never writes, even to a destination it refuses", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const before = fs.readdirSync(root).sort();
    const generated = path.join(root, ".claude/skills/greet/SKILL.md");
    const bytes = fs.readFileSync(generated);
    await run(root, "agent", "guard", ".claude/skills/greet/SKILL.md");
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.readFileSync(generated)).toEqual(bytes);
  });
});

describe("the cairn-agent pre-tool-use hook", () => {
  it("refuses a write to a generated file with the reason on stderr", async () => {
    const { root, shim } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const result = await runHook(root, shim, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, ".claude/skills/greet/SKILL.md") },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Refusing to edit a cairn-generated file.");
    expect(result.stderr).toContain("bundles/demo/skills/greet/SKILL.md");
  });

  it("answers Cursor with a deny decision on stdout rather than an exit code", async () => {
    const { root, shim } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const result = await runHook(root, shim, {
      conversation_id: "c1",
      workspace_roots: [root],
      tool_name: "Write",
      tool_input: { file_path: path.join(root, ".cursor/skills/greet/SKILL.md") },
    });
    // Cursor ignores the status, so a nonzero one here would be a silent no-op.
    expect(result.exitCode).toBe(0);
    const decision = JSON.parse(result.stdout) as Record<string, string>;
    expect(decision.permission).toBe("deny");
    expect(decision.agentMessage).toContain("bundles/demo/skills/greet/SKILL.md");
  });

  it("filters on the tool name itself, for the host that drops the matcher", async () => {
    const { root, shim } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const result = await runHook(root, shim, {
      conversation_id: "c1",
      workspace_roots: [root],
      tool_name: "Bash",
      tool_input: { command: `cat ${path.join(root, ".claude/skills/greet/SKILL.md")}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("allows the edit when cairn is not on PATH", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const empty = path.join(root, ".empty");
    fs.mkdirSync(empty, { recursive: true });
    const result = await runHook(root, empty, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, ".claude/skills/greet/SKILL.md") },
    });
    // A guard that failed closed would block every edit on a machine without
    // the CLI, which is far worse than the edit it exists to prevent.
    expect(result.exitCode).toBe(0);
  });

  it("allows an unparseable event, an unknown tool, and a call with no path", async () => {
    const { root, shim } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    for (const event of [
      { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} },
      { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: "https://x" } },
      { hook_event_name: "PreToolUse" },
    ]) {
      const result = await runHook(root, shim, event);
      expect(result.exitCode, JSON.stringify(event)).toBe(0);
    }
  });

  it("allows an edit in a repository that declares no guard block", async () => {
    const { root, shim } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const generated = path.join(root, ".claude/skills/greet/SKILL.md");
    fs.writeFileSync(
      path.join(root, ".cairn.yml"),
      "version: 1\nagent:\n  install:\n    targets: [claude-code]\n    scope: project\n    into: .\n    bundles:\n      - path: bundles/demo\n",
    );
    const result = await runHook(root, shim, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: generated },
    });
    expect(result.exitCode).toBe(0);
  });
});
