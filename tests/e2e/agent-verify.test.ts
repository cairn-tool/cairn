import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporary: string[] = [];

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(...args: string[]): Promise<Run> {
  try {
    const result = await exec("node", [cli, ...args]);
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

const PINS = `      cli: { min: "0.0.1" }
      profileSchemaVersion: "2"
`;

function config(root: string, body: string): string {
  const file = path.join(root, "cairn-verify.yml");
  fs.writeFileSync(file, body);
  return file;
}

function defaultConfig(root: string, overrides: Record<string, string> = {}): string {
  const entry = {
    name: "hello",
    bundle: "bundle",
    target: "claude-code",
    profile: "project",
    destination: ".",
    ...overrides,
  };
  const lines = Object.entries(entry).map(([key, value]) => `        ${key}: ${value}`);
  return config(
    root,
    `version: 1
agent:
  verify:
    pins:
${PINS}    defaults: { unmanaged: orphaned, scope: project }
    entries:
      -
${lines.join("\n")}
`,
  );
}

/** A repository holding a bundle and the tree that bundle was installed into. */
async function repository(): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-verify-e2e-")));
  temporary.push(root);
  const bundle = path.join(root, "bundle");
  fs.mkdirSync(path.join(bundle, "skills", "hello"), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "agent-bundle.yaml"),
    "schemaVersion: '2'\nname: hello\nversion: 1.0.0\ndescription: Hello bundle\n",
  );
  fs.writeFileSync(
    path.join(bundle, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: Say hello\n---\nSay hello.\n",
  );
  fs.mkdirSync(path.join(bundle, "skills", "second"), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "skills", "second", "SKILL.md"),
    "---\nname: second\ndescription: Second skill\n---\nSecond.\n",
  );
  const installed = await run(
    "agent",
    "install",
    bundle,
    "--target",
    "claude-code",
    "--scope",
    "project",
    "--into",
    root,
  );
  expect(installed.exitCode).toBe(0);
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent verify", () => {
  it("passes on a tree that still matches its bundle", async () => {
    const root = await repository();
    const result = await run("agent", "verify", "--config", defaultConfig(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("verify: ok");
  });

  it("reports AB402 when a generated file was edited by hand", async () => {
    const root = await repository();
    fs.appendFileSync(path.join(root, ".claude/skills/hello/SKILL.md"), "hand edit\n");
    const result = await run("agent", "verify", "--config", defaultConfig(root));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("AB402");
    expect(result.stdout).toContain(".claude/skills/hello/SKILL.md");
  });

  it("reports AB402 when a generated file was deleted", async () => {
    const root = await repository();
    fs.rmSync(path.join(root, ".claude/skills/hello/SKILL.md"));
    const result = await run("agent", "verify", "--config", defaultConfig(root));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("AB402");
  });

  it("reports AB424 for a file the bundle no longer renders", async () => {
    const root = await repository();
    fs.rmSync(path.join(root, "bundle", "skills", "second"), { recursive: true });
    const result = await run("agent", "verify", "--config", defaultConfig(root));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("AB424");
    expect(result.stdout).toContain(".claude/skills/second/SKILL.md");
  });

  it("reports a hand-added file as AB403, which blocks only under --strict", async () => {
    const root = await repository();
    fs.writeFileSync(path.join(root, ".claude/skills/hello/EXTRA.md"), "extra\n");
    const file = defaultConfig(root, { unmanaged: "strict" });

    const lenient = await run("agent", "verify", "--config", file);
    expect(lenient.stdout).toContain("AB403");
    expect(lenient.exitCode).toBe(0);

    const strict = await run("agent", "verify", "--config", file, "--strict");
    expect(strict.exitCode).toBe(2);
  });

  it("never enumerates the repository, however much unrelated content it holds", async () => {
    const root = await repository();
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    for (let index = 0; index < 200; index += 1)
      fs.writeFileSync(path.join(root, "node_modules", "pkg", `f${index}.js`), "x\n");
    fs.writeFileSync(path.join(root, "src", "index.ts"), "x\n");
    fs.writeFileSync(path.join(root, ".git", "config"), "x\n");
    fs.writeFileSync(path.join(root, "README.md"), "x\n");

    const result = await run(
      "agent",
      "verify",
      "--config",
      defaultConfig(root, { unmanaged: "strict" }),
      "--strict",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("unmanaged: 0");
  });

  it("reports each violated pin with its own code", async () => {
    const root = await repository();
    const cases: Array<[string, string]> = [
      [`      cli: { max: "0.0.1" }\n`, "AB420"],
      [`      profileSchemaVersion: "99"\n`, "AB421"],
      [`      targets:\n        claude-code: { min: "2099-01-01" }\n`, "AB422"],
    ];
    for (const [pins, code] of cases) {
      const file = config(
        root,
        `version: 1
agent:
  verify:
    pins:
${pins}    entries:
      - { name: hello, bundle: bundle, target: claude-code, profile: project, destination: "." }
`,
      );
      const result = await run("agent", "verify", "--config", file);
      expect(result.stdout).toContain(code);
      expect(result.exitCode).toBe(2);
    }
  });

  it("reports the running versions even when nothing is pinned", async () => {
    const root = await repository();
    const file = config(
      root,
      `version: 1
agent:
  verify:
    entries:
      - { name: hello, bundle: bundle, target: claude-code, profile: project, destination: "." }
`,
    );
    const result = await run("agent", "verify", "--config", file, "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.verify.pins.cli.status).toBe("unpinned");
    expect(payload.verify.pins.cli.actual).toMatch(/^\d+\.\d+\.\d+/);
    expect(payload.verify.pins.targets[0].actual).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports AB423 for a destination that does not exist", async () => {
    const root = await repository();
    const result = await run(
      "agent",
      "verify",
      "--config",
      defaultConfig(root, { destination: "nowhere" }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("AB423");
  });

  it("treats an absent install manifest as a notice, not as drift", async () => {
    const root = await repository();
    fs.rmSync(path.join(root, ".cairn-install.json"));
    const result = await run("agent", "verify", "--config", defaultConfig(root));
    expect(result.stdout).toContain("AB426");
    expect(result.exitCode).toBe(0);
  });

  it("reports AB806 for a malformed install manifest", async () => {
    const root = await repository();
    fs.writeFileSync(path.join(root, ".cairn-install.json"), "{ not json");
    const result = await run("agent", "verify", "--config", defaultConfig(root));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("AB806");
  });

  it("selects a single entry by name, and refuses an unknown one", async () => {
    const root = await repository();
    const file = defaultConfig(root);
    const selected = await run("agent", "verify", "--config", file, "--name", "hello");
    expect(selected.exitCode).toBe(0);

    const unknown = await run("agent", "verify", "--config", file, "--name", "nope", "-fj");
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.stdout).diagnostics[0].code).toBe("AB000");
  });

  it("exits 1 when no configuration declares the block", async () => {
    const root = await repository();
    const file = config(root, "version: 1\n");
    const result = await run("agent", "verify", "--config", file, "-fj");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).diagnostics[0].message).toContain("agent.verify");
  });

  it("refuses a FIFO promptly rather than blocking on the open", async () => {
    // Opening a FIFO for reading blocks until a writer appears, which would
    // wedge the process with no output. The type is checked before the
    // descriptor exists for exactly this reason.
    const root = await repository();
    const fifo = path.join(root, "fifo.yml");
    execFileSync("mkfifo", [fifo]);
    const result = await run("agent", "verify", "--config", fifo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not a regular file");
  }, 10_000);

  it("refuses a binary file named like a configuration document", async () => {
    const root = await repository();
    const file = path.join(root, "binary.yml");
    fs.writeFileSync(file, Buffer.from([0x59, 0x00, 0x4d, 0x4c]));
    const result = await run("agent", "verify", "--config", file);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not a text file");
  });

  it("follows a symlinked configuration document", async () => {
    const root = await repository();
    const link = path.join(root, "linked.yml");
    fs.symlinkSync(defaultConfig(root), link);
    const result = await run("agent", "verify", "--config", link);
    expect(result.exitCode).toBe(0);
  });

  it("emits a payload carrying the pins, the entries, and the counts", async () => {
    const root = await repository();
    const result = await run("agent", "verify", "--config", defaultConfig(root), "-fj");
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("verify");
    expect(payload.ok).toBe(true);
    expect(payload.verify.counts).toEqual({
      entries: 1,
      ok: 1,
      missing: 0,
      changed: 0,
      orphaned: 0,
      unmanaged: 0,
    });
    expect(payload.verify.entries[0]).toMatchObject({
      name: "hello",
      target: "claude-code",
      profile: "project",
      layout: "merge",
      ok: true,
    });
    expect(payload.verify.entries[0].provenance.source).toBe(".cairn-install.json");
    // An install manifest records no profile schema version. Reported as null
    // rather than invented.
    expect(payload.verify.entries[0].provenance.profileSchemaVersion).toBeNull();
  });
});
