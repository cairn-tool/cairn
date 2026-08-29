import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporary: string[] = [];

async function run(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    // The fish script is close to a megabyte: every `complete` line repeats the whole
    // subcommand guard, so it outgrows the default capture buffer well before
    // it becomes a problem for a shell redirect.
    const result = await exec("node", [cli, ...args], {
      env: { ...process.env, CI: "1" },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "completion-e2e-"));
  temporary.push(root);
  return root;
}

/** Whether an interpreter is on PATH, so a missing shell skips rather than fails. */
async function available(binary: string): Promise<boolean> {
  try {
    await exec("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

describe("completion", () => {
  it("emits a byte-stable script for every shell", async () => {
    for (const shell of SHELLS) {
      const first = await run("completion", shell);
      expect(first.exitCode, shell).toBe(0);
      expect(first.stdout.length, shell).toBeGreaterThan(500);
      const second = await run("completion", shell);
      expect(second.stdout, `${shell} is not deterministic`).toBe(first.stdout);
    }
  });

  it("covers every command and option the contract declares", async () => {
    // Parsed from `describe`, so a new subcommand or flag that the generator
    // fails to pick up breaks this test rather than shipping silently.
    const described = JSON.parse((await run("describe", "--format", "json")).stdout);
    const ids: string[] = described.commands.map((command: { id: string }) => command.id);
    expect(ids.length).toBeGreaterThan(30);

    for (const shell of SHELLS) {
      const script = (await run("completion", shell)).stdout;
      for (const id of ids) expect(script, `${shell} is missing "${id}"`).toContain(id);
      // The hidden refresh command must never become completable.
      expect(script, shell).not.toContain("__refresh-update-cache");
    }

    const bash = (await run("completion", "bash")).stdout;
    for (const command of described.commands) {
      for (const option of command.options)
        if (option.long)
          expect(bash, `bash is missing ${command.id} ${option.long}`).toContain(option.long);
    }
  });

  it("parses under bash and zsh", async () => {
    const root = scratch();
    for (const shell of ["bash", "zsh"] as const) {
      if (!(await available(shell))) continue;
      const file = path.join(root, `completion.${shell}`);
      fs.writeFileSync(file, (await run("completion", shell)).stdout);
      // `-n` parses without executing; a quoting bug in a description shows here.
      await expect(exec(shell, ["-n", file])).resolves.toBeDefined();
    }
  });

  it("actually completes commands and option values under bash", async () => {
    const root = scratch();
    const script = path.join(root, "completion.bash");
    fs.writeFileSync(script, (await run("completion", "bash")).stdout);
    const driver = path.join(root, "drive.bash");
    fs.writeFileSync(
      driver,
      [
        `source ${JSON.stringify(script)}`,
        "try() {",
        '  COMP_WORDS=("$@")',
        "  COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))",
        "  COMPREPLY=()",
        "  _cairn_completions",
        '  echo "${COMPREPLY[*]}"',
        "}",
        'try cairn ""',
        "try cairn md gr",
        'try cairn md graph --output ""',
        'try cairn md audit --format ""',
        'try cairn md graph --format ""',
        'try cairn agent convert --target ""',
        'try cairn completion ""',
      ].join("\n"),
    );
    const { stdout } = await exec("bash", [driver]);
    const [top, prefix, output, auditFormat, graphFormat, targets, shells] = stdout
      .trim()
      .split("\n");

    expect(top.split(" ")).toEqual(
      expect.arrayContaining(["md", "agent", "scripts", "usage", "completion"]),
    );
    expect(prefix).toBe("graph");
    expect(output).toBe("report mermaid dot");
    // --format values come from the contract, so they differ per command.
    expect(auditFormat).toBe("llm human json jsonl sarif");
    expect(graphFormat).toBe("llm human json");
    expect(targets).toBe("claude-code codex cursor all");
    // A positional-argument position offers its vocabulary and the command's
    // own flags, since either is valid there.
    expect(shells.split(" ")).toEqual(
      expect.arrayContaining(["bash", "zsh", "fish", "powershell", "--format"]),
    );
  });

  it("rejects an unknown shell and an unsupported format", async () => {
    const unknown = await run("completion", "tcsh");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown shell");
    const format = await run("completion", "bash", "--format", "sarif");
    expect(format.exitCode).toBe(1);
    expect(format.stderr).toContain("Invalid output format");
  });

  it("writes the script regardless of --format", async () => {
    // The script is the payload; --format is accepted for consistency only.
    const llm = await run("completion", "fish");
    for (const format of ["human", "json"]) {
      const result = await run("completion", "fish", "--format", format);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(llm.stdout);
    }
  });
});
