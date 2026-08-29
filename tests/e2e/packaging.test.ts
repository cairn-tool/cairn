import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");

let tmpDir: string;
let packedFiles: string[];

// Pack a real tarball and read its table of contents. Parsing `npm pack --json`
// stdout is not safe: npm and lifecycle scripts (husky) may print ahead of the JSON.
beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-pack-"));
  await exec("npm", ["pack", "--ignore-scripts", "--pack-destination", tmpDir], {
    cwd: repoRoot,
  });

  const tarball = fs.readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm pack produced no .tgz in ${tmpDir}`);

  const { stdout } = await exec("tar", ["-tzf", path.join(tmpDir, tarball)], {
    maxBuffer: 32 * 1024 * 1024,
  });
  // Entries are prefixed with the conventional "package/" root directory.
  packedFiles = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().replace(/^package\//, ""));
}, 120_000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("published package contents", () => {
  it("ships the CLI entry point declared in bin", () => {
    expect(packedFiles).toContain("dist/cli.js");
  });

  // markdown-lint.ts resolves its config as dist/checkers/../../.markdownlintrc, i.e. the
  // package root. It falls back to {} silently when the file is absent, so leaving this
  // out of package.json "files" would not crash — `md lint --style` would just start
  // reporting rules (MD013 in particular) that are disabled everywhere else.
  it("ships .markdownlintrc so --style uses the intended rule config", () => {
    expect(packedFiles).toContain(".markdownlintrc");
  });

  // The published schemas and target profiles are TypeScript modules under src/ rather
  // than data directories, precisely so they compile into dist and ship via the existing
  // files entry. A top-level schemas/ or .json profile would be omitted with no error at
  // all — `schema <id>` would report every id as unknown, and `agent specs` would crash.
  it("ships the contract schemas and target profiles", () => {
    expect(packedFiles).toContain("dist/contract/registry.js");
    expect(packedFiles).toContain("dist/contract/schemas/index.js");
    expect(packedFiles).toContain("dist/agent/targets/index.js");
    expect(packedFiles).toContain("dist/commands/describe.js");
    expect(packedFiles).toContain("dist/commands/schema.js");
    expect(packedFiles).toContain("dist/commands/agent-doctor.js");
  });

  // src/serve/ is a new top-level directory under rootDir: "src", so it compiles
  // into dist and ships via the existing files entry — but only as long as its
  // contents stay TypeScript modules. A tool manifest kept as a .json file would
  // be silently absent and `serve mcp` would advertise no tools.
  it("ships the MCP server", () => {
    expect(packedFiles).toContain("dist/commands/serve.js");
    expect(packedFiles).toContain("dist/serve/server.js");
    expect(packedFiles).toContain("dist/serve/tools.js");
  });

  // Same trap again: src/scripts/ only reaches dist while every file in it stays
  // a TypeScript module. Without these, `scripts run` would resolve nothing and
  // report every name as undeclared.
  it("ships the script resolver and executor", () => {
    expect(packedFiles).toContain("dist/commands/scripts.js");
    expect(packedFiles).toContain("dist/scripts/registry.js");
    expect(packedFiles).toContain("dist/scripts/resolve.js");
    expect(packedFiles).toContain("dist/scripts/execute.js");
  });

  it("ships the docs but not the sources or tests", () => {
    expect(packedFiles).toContain("README.md");
    expect(packedFiles).toContain("LICENSE");
    expect(packedFiles.some((f) => f.startsWith("src/"))).toBe(false);
    expect(packedFiles.some((f) => f.startsWith("tests/"))).toBe(false);
  });
});
