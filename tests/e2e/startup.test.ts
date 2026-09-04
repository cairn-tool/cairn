import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "dist", "cli.js");

// CI is set so the update notifier stays silent and cannot spawn its detached
// refresh child in the middle of a measurement (src/update-notifier.ts).
const env = { ...process.env, CI: "1" };

function elapsed(args: string[]): number {
  const started = performance.now();
  spawnSync(process.execPath, args, { stdio: "ignore", env });
  return performance.now() - started;
}

const best = (args: string[], runs = 7): number =>
  Math.min(...Array.from({ length: runs }, () => elapsed(args)));

/**
 * `src/cli.ts` loads each command module on demand, so starting the CLI costs
 * commander plus the config/runtime prelude rather than every command in the
 * tool. The budget is expressed against a bare `node -e ''` measured in the same
 * run, not in milliseconds: a slower CI runner moves both numbers together, and
 * an absolute threshold would flake there.
 *
 * Reference points, measured locally: eagerly importing all 52 command modules
 * cost 10.9x the baseline; loading them on demand costs 4.2x.
 */
describe("cli startup", () => {
  it("starts well inside the budget for the bare node baseline", () => {
    const baseline = best(["-e", ""]);
    const ratio = best([cli, "--help"]) / baseline;
    expect(ratio).toBeLessThan(6);
  }, 60_000);

  it("does not load a command's dependencies to print its help", () => {
    // `pdf` pulls pdf.js and `md lint` pulls markdownlint and katex when they
    // run. Printing help must not, so neither may cost meaningfully more than
    // the bare `--help` that registers the same tree.
    const bare = best([cli, "--help"]);
    for (const args of [
      ["pdf", "inspect"],
      ["md", "lint"],
      ["usage", "tokens"],
    ]) {
      expect(best([cli, ...args, "--help"])).toBeLessThan(bare * 1.5);
    }
  }, 60_000);
});
