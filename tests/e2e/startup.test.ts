import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const register = path.join(repoRoot, "tests", "helpers", "import-log-register.mjs");

let logPath: string;

beforeEach(() => {
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-imports-")), "log.txt");
  fs.writeFileSync(logPath, "");
});

afterEach(() => {
  fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
});

/** Every module specifier the CLI resolved while running `args`. */
function modulesLoadedBy(args: string[]): string[] {
  // The hook appends, so each invocation starts from an empty log.
  fs.writeFileSync(logPath, "");
  const result = spawnSync(process.execPath, ["--import", register, cli, ...args], {
    encoding: "utf-8",
    // CI keeps the update notifier from spawning its detached refresh child,
    // whose own resolutions would otherwise land in the same log.
    env: { ...process.env, CI: "1", IMPORT_LOG: logPath },
  });
  expect(result.error).toBeUndefined();
  return fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
}

const commandModules = (urls: string[]): string[] =>
  [...new Set(urls.filter((url) => url.includes("/dist/commands/")))].sort();

/**
 * `src/cli.ts` reaches each command module through `await import()` inside its
 * action handler, so an invocation loads commander and the config/runtime
 * prelude rather than all 52 command modules.
 *
 * This asserts the property directly — which modules were resolved — rather
 * than how long the process took. An earlier version of this test compared
 * startup against a bare `node -e ''` baseline on the assumption that a slower
 * machine moves both numbers together. It does not: `node -e ''` is dominated
 * by fixed V8 init while cairn's startup is dominated by reading and compiling
 * several MB of JavaScript, so the ratio was 4.0x locally and 7.1-7.4x on CI.
 * Module identity has no such spread.
 *
 * Reference points, same machine: before command actions were deferred,
 * `cairn --help` resolved 1852 specifiers including 68 command modules; it now
 * resolves 403 and none.
 */
describe("cli startup", () => {
  it("registers the command tree without loading a single command module", () => {
    expect(commandModules(modulesLoadedBy(["--help"]))).toEqual([]);
  });

  it("prints a subcommand's help without loading that subcommand", () => {
    // `pdf` pulls pdf.js and `md lint` pulls markdownlint and katex when they
    // run. Printing their help must reach neither.
    for (const args of [
      ["pdf", "inspect", "--help"],
      ["md", "lint", "--help"],
      ["usage", "tokens", "--help"],
      ["agent", "convert", "--help"],
    ]) {
      expect(commandModules(modulesLoadedBy(args))).toEqual([]);
    }
  });

  it("loads only the module the invoked command needs", () => {
    expect(commandModules(modulesLoadedBy(["md", "outline", "README.md"]))).toEqual([
      expect.stringContaining("/dist/commands/outline.js"),
    ]);
    expect(commandModules(modulesLoadedBy(["usage", "providers"]))).toEqual([
      expect.stringContaining("/dist/commands/usage.js"),
    ]);
  });

  it("keeps the startup graph far smaller than the whole tool", () => {
    // A blunt ceiling on the prelude, well above the 403 it resolves today and
    // well below the 1852 an eager cli.ts pulled in. This is a count, not a
    // duration, so it does not vary with the machine.
    expect(modulesLoadedBy(["--help"]).length).toBeLessThan(900);
  });
});
