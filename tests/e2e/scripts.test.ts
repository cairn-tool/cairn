import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";

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

/** A git repository with a registry at its root, plus a nested working directory. */
function workspace(registry: string, nested = "pkg/deep"): { root: string; deep: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scripts-e2e-")));
  temporary.push(root);
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, ".cairn.yml"), registry);
  const deep = path.join(root, nested);
  fs.mkdirSync(deep, { recursive: true });
  return { root, deep };
}

const REGISTRY = `version: 1
scripts:
  where:
    description: Print the working directory
    run: pwd
  echo-args:
    run: printf '%s\\n' "$@"
  fails:
    run: exit 7
  argv:
    exec: ["node", "-e", "console.log(process.argv.slice(1).join('|'))"]
`;

function validate(schemaId: string, payload: unknown): void {
  const entry = SCHEMA_BY_ID.get(schemaId);
  expect(entry, `schema ${schemaId} is published`).toBeDefined();
  const ajv = new Ajv2020({ strict: false });
  const valid = ajv.compile(entry!.schema)(payload);
  expect(ajv.errors ?? [], `${schemaId} validation errors`).toEqual([]);
  expect(valid).toBe(true);
}

describe("scripts run", () => {
  it("resolves and runs from a nested directory, pinned to the registry", async () => {
    const { root, deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "run", "where");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(root);
  });

  it("passes the script's exit status through verbatim", async () => {
    const { deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "run", "fails");
    expect(result.code).toBe(7);
  });

  it("forwards arguments after -- without a shell re-reading them", async () => {
    const { deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "run", "echo-args", "--", "one", "; echo pwned");
    expect(result.stdout).toBe("one\n; echo pwned\n");
  });

  it("does not rewrite a format shorthand that belongs to the script", async () => {
    const { deep } = workspace(REGISTRY);
    // -fj after `--` is the script's argument, not this command's format.
    const result = await run(deep, "scripts", "run", "echo-args", "--", "-fj");
    expect(result.stdout).toBe("-fj\n");
  });

  it("appends forwarded arguments to an exec argv", async () => {
    const { deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "run", "argv", "--", "a", "b");
    expect(result.stdout.trim()).toBe("a|b");
  });

  it("captures the streams under --format json and exits 2 on failure", async () => {
    const { root, deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "run", "fails", "-fj");
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.exit).toEqual({ code: 7, signal: null, status: 7 });
    expect(payload.workingDirectory).toBe(root);
    expect(payload.invokedFrom).toBe(deep);
    validate("script-run", payload);
  });

  it("exits 1 rather than 2 when the script never started", async () => {
    const { deep } = workspace(
      'version: 1\nscripts:\n  ghost:\n    exec: ["no-such-program-xyz"]\n',
    );
    const result = await run(deep, "scripts", "run", "ghost", "-fj");
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.startupError).toBeTruthy();
    expect(payload.exit.code).toBeNull();
    validate("script-run", payload);
  });

  it("wraps the payload when --envelope is given", async () => {
    const { deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "run", "where", "-fj", "--envelope");
    const envelope = JSON.parse(result.stdout);
    expect(envelope.command).toBe("scripts run");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.schema).toContain("/v1/script-run.json");
    validate("script-run", envelope.data);
  });

  it("refuses to run outside a Git repository unless --root is given", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scripts-norepo-")));
    temporary.push(root);
    fs.writeFileSync(path.join(root, ".cairn.yml"), REGISTRY);

    const refused = await run(root, "scripts", "run", "where");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/Refusing to run a script outside a Git repository/);

    const allowed = await run(root, "scripts", "run", "where", "--root", ".");
    expect(allowed.code).toBe(0);
    expect(allowed.stdout.trim()).toBe(root);
  });

  it("reports an unknown name as an invocation error", async () => {
    const { deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "run", "nope");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/No script named 'nope'/);
  });
});

describe("scripts which", () => {
  it("names the winning registry from a nested directory", async () => {
    const { root, deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "which", "where");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(path.join(root, ".cairn.yml"));
  });

  it("reports the shadowed definition a nested registry hides", async () => {
    const { root, deep } = workspace(REGISTRY);
    fs.writeFileSync(
      path.join(root, "pkg", ".cairn.yml"),
      "version: 1\nscripts:\n  where:\n    run: echo nested\n",
    );
    const result = await run(deep, "scripts", "which", "where", "-fj");
    const payload = JSON.parse(result.stdout);
    expect(payload.registry).toBe(path.join(root, "pkg", ".cairn.yml"));
    expect(payload.shadowed.map((entry: { file: string }) => entry.file)).toEqual([
      path.join(root, ".cairn.yml"),
    ]);
    validate("script-which", payload);
  });

  it("exits 2 with the findings on stderr when the name is unknown", async () => {
    const { deep } = workspace(REGISTRY);
    const result = await run(deep, "scripts", "which", "nope", "-fj");
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr);
    expect(payload.found).toBe(false);
    validate("script-which", payload);
  });
});

describe("scripts list", () => {
  it("lists every visible name with nearest-wins applied", async () => {
    const { root, deep } = workspace(REGISTRY);
    fs.writeFileSync(
      path.join(root, "pkg", ".cairn.yml"),
      "version: 1\nscripts:\n  where:\n    run: echo nested\n",
    );
    const result = await run(deep, "scripts", "list", "-fj");
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.scripts.map((entry: { name: string }) => entry.name)).toEqual([
      "argv",
      "echo-args",
      "fails",
      "where",
    ]);
    const where = payload.scripts.find((entry: { name: string }) => entry.name === "where");
    expect(where.file).toBe(path.join(root, "pkg", ".cairn.yml"));
    expect(where.shadows).toEqual([path.join(root, ".cairn.yml")]);
    validate("script-list", payload);
  });

  it("reports an unreadable configuration file and exits 2", async () => {
    const { root, deep } = workspace(REGISTRY);
    fs.writeFileSync(path.join(root, "pkg", ".cairn.yml"), "scripts:\n  a:\n    run: [oops\n");
    const result = await run(deep, "scripts", "list", "-fj");
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr);
    expect(payload.invalid).toBe(1);
    validate("script-list", payload);
  });
});

describe("the scripts block in project configuration", () => {
  it("does not disturb the md toolset", async () => {
    const { root, deep } = workspace(REGISTRY);
    fs.writeFileSync(path.join(root, "README.md"), "# Title\n\nBody.\n");
    const result = await run(deep, "md", "lint", path.join(root, "README.md"));
    expect(result.code).toBe(0);
  });

  it("is validated by every command that loads configuration", async () => {
    const { root, deep } = workspace("version: 1\nscripts:\n  a:\n    exce: typo\n");
    fs.writeFileSync(path.join(root, "README.md"), "# Title\n");
    const result = await run(deep, "md", "lint", path.join(root, "README.md"));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown scripts.a key: exce/);
  });
});
