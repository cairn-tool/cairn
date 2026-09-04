import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const commandsDir = path.join(repoRoot, "src", "commands");

/**
 * Command modules used to be imported eagerly by `src/cli.ts`, so any module
 * that failed to load broke `cairn --help` and every other command — loudly, at
 * startup. They are loaded on demand now, so a module that cannot be evaluated
 * would stay invisible until somebody ran that one command. This walks the
 * directory and evaluates each one, restoring what startup used to prove.
 */
describe("command modules", () => {
  const modules = fs
    .readdirSync(commandsDir)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();

  it("finds the command modules", () => {
    expect(modules.length).toBeGreaterThan(40);
  });

  it.each(modules)("%s evaluates and exports an action", async (entry) => {
    const loaded: Record<string, unknown> = await import(path.join(commandsDir, entry));
    expect(Object.keys(loaded).some((name) => name.endsWith("Action"))).toBe(true);
  });
});
