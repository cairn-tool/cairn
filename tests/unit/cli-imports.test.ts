import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf-8");

/**
 * `src/cli.ts` reaches every command module through `await import()` inside the
 * action handler. A static `import { xAction } from "./commands/…"` at the top
 * drags that command's whole subgraph — markdownlint, pdf.js, the agent
 * renderer — into every invocation of every other command, which is the
 * ~160ms cold-start regression the arrangement exists to prevent. Type-only
 * imports are erased by tsc and cost nothing, so they stay allowed.
 */
describe("cli.ts command-module imports", () => {
  // `[^;]*` spans the newlines of a braced block but cannot leave the statement,
  // since every import ends at its own semicolon.
  const statements = source.match(/^import\b[^;]*from "\.\/commands\/[\w-]+\.js";$/gm) ?? [];

  it("reaches every command module lazily, never with a static value import", () => {
    const eager = statements.filter((statement) => !statement.startsWith("import type "));
    expect(eager).toEqual([]);
  });

  it("still imports the option types it annotates handlers with", () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it("loads a command module in every action handler", () => {
    const handlers = source.match(/^ {2}\.action\(/gm) ?? [];
    const dynamic = source.match(/import\("\.\/commands\/[\w-]+\.js"\)/g) ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // Every handler loads at least one module; the `agent` subcommands load two,
    // because `agentActionBoundary` lives beside the four actions in commands/agent.ts
    // while the rest have their own modules.
    expect(dynamic.length).toBeGreaterThanOrEqual(handlers.length);
  });

  it("keeps `collect` a single static import", () => {
    // src/contract/describe.ts detects a repeatable option by comparing its
    // coercion against `collect` by identity, so a second instance would report
    // every repeatable option as `repeatable: false`.
    expect(source).toContain('import { collect } from "./option-utils.js";');
    expect(source).not.toMatch(/import\("\.\/option-utils\.js"\)/);
  });
});
