import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_AGENT } from "../unit/qa/helpers.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function run(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await exec("node", [cli, ...args], { cwd, env: { ...process.env, CI: "1" } });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

function planYaml(name: string, agent: string, mode = "ok"): string {
  return [
    `id: ${name.toUpperCase()}`,
    `name: Plan ${name}`,
    `agent: ${agent}`,
    "parallel: true",
    "plan: |",
    `  # Plan ${name}`,
    "",
    `  MODE: ${mode}`,
    "",
  ].join("\n");
}

function qaWorkspace(): { repo: string; runs: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qa-e2e-")));
  temporary.push(repo);
  const runs = path.join(repo, "runs");
  fs.mkdirSync(path.join(runs, "_plans"), { recursive: true });
  return { repo, runs };
}

describe("qa e2e", () => {
  it("dry-run shows Claude Code argv without --workspace and Cursor argv with it", async () => {
    const { repo, runs } = qaWorkspace();
    fs.writeFileSync(path.join(runs, "_plans", "tc-1.yaml"), planYaml("tc-1", "cursor"));
    fs.writeFileSync(path.join(runs, "_plans", "tc-2.yaml"), planYaml("tc-2", "claude-code"));
    const result = await run(
      repo,
      "qa",
      "run",
      "--repo",
      repo,
      "--runs-dir",
      runs,
      "--dry-run",
      "--show-prompts",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--workspace/);
    expect(result.stdout).toMatch(/--dangerously-skip-permissions/);
    expect(result.stdout).toMatch(/--verbose/);
    const cursorBlock = result.stdout.slice(
      result.stdout.indexOf("tc-1"),
      result.stdout.indexOf("tc-2"),
    );
    const claudeBlock = result.stdout.slice(result.stdout.indexOf("tc-2"));
    expect(cursorBlock).toMatch(/--workspace/);
    expect(cursorBlock).not.toMatch(/--dangerously-skip-permissions/);
    expect(claudeBlock).toMatch(/--dangerously-skip-permissions/);
    expect(claudeBlock).not.toMatch(/--workspace/);
  });

  it("runs a mixed cursor and claude-code queue through the fake agent", async () => {
    const { repo, runs } = qaWorkspace();
    fs.writeFileSync(path.join(runs, "_plans", "tc-1.yaml"), planYaml("tc-1", "cursor"));
    fs.writeFileSync(path.join(runs, "_plans", "tc-2.yaml"), planYaml("tc-2", "claude-code"));
    const result = await run(
      repo,
      "qa",
      "run",
      "--repo",
      repo,
      "--runs-dir",
      runs,
      "--agent",
      FAKE_AGENT,
      "--no-tui",
      "-fj",
    );
    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      cases: Array<{
        name: string;
        status: string;
        tools: number;
        usage: Record<string, number> | null;
      }>;
      summary: { ok: number; tools: number; usage: Record<string, number> | null };
    };
    expect(payload.ok).toBe(true);
    expect(payload.cases.map((row) => row.name).sort()).toEqual(["tc-1", "tc-2"]);
    for (const row of payload.cases) {
      expect(row.status, row.name).toBe("ok");
      expect(row.tools, row.name).toBeGreaterThan(0);
      expect(
        (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0),
        row.name,
      ).toBeGreaterThan(0);
    }
    expect(payload.summary.ok).toBe(2);
    expect(payload.summary.tools).toBeGreaterThan(0);
    const summary = fs.readFileSync(path.join(runs, "summary.md"), "utf8");
    expect(summary).toMatch(/tc-1/i);
    expect(summary).toMatch(/tc-2/i);
  });

  it("accepts --repo outside a discovered config.root", async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qa-cfg-")));
    temporary.push(home);
    const configRoot = path.join(home, "project");
    const repo = path.join(home, "other");
    fs.mkdirSync(path.join(configRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(configRoot, ".cairn.yml"), "version: 1\nroot: docs\n");
    const runs = path.join(repo, "runs");
    fs.mkdirSync(path.join(runs, "_plans"), { recursive: true });
    fs.writeFileSync(path.join(runs, "_plans", "tc-1.yaml"), planYaml("tc-1", "cursor"));
    const result = await run(configRoot, "qa", "list", "--repo", repo, "--runs-dir", runs, "-fj");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/outside configured workspace root/);
    const payload = JSON.parse(result.stdout) as { cases: Array<{ name: string }> };
    expect(payload.cases.map((row) => row.name)).toEqual(["tc-1"]);
  });

  it("lists pending cases without launching", async () => {
    const { repo, runs } = qaWorkspace();
    fs.writeFileSync(path.join(runs, "_plans", "tc-1.yaml"), planYaml("tc-1", "cursor"));
    const result = await run(repo, "qa", "list", "--repo", repo, "--runs-dir", runs);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/tc-1\s+pending/);
  });
});
