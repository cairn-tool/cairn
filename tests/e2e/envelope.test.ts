import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const fixtures = path.resolve("tests/fixtures");
const temporary: string[] = [];
const usageFixture = ["--logs", path.join(fixtures, "usage-logs")];
/**
 * Scanning cases bypass the index as well.
 *
 * The two spawns share a cache directory, so the first would populate it and
 * the second would report itself as a cache hit — a real difference in the
 * `scan` counters that has nothing to do with `--envelope`.
 */
const usageLogs = [...usageFixture, "--no-index"];

/**
 * A cache directory of this run's own.
 *
 * The workspace index lives under `XDG_CACHE_HOME`, so without this the suite
 * both depends on and grows whatever the developer already has there — and
 * `md index status` reports cache counters, which would make its payload depend
 * on what earlier tests happened to index.
 */
function cacheHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "envelope-cache-"));
  temporary.push(root);
  return root;
}

async function runWith(
  cache: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env = { ...process.env, CI: "1", XDG_CACHE_HOME: cache, XDG_DATA_HOME: cache };
  try {
    const result = await exec("node", [cli, ...args], { env });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1 };
  }
}

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return runWith(cacheHome(), ...args);
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "envelope-e2e-"));
  temporary.push(root);
  fs.writeFileSync(path.join(root, "index.md"), "# Index\n\n- [Clean](./clean.md)\n");
  fs.writeFileSync(path.join(root, "clean.md"), "# Clean\n\n- [ ] Pending\n");
  return root;
}

function bundle(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "envelope-bundle-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "skills", "hello"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agent-bundle.yaml"),
    "schemaVersion: '1'\nname: hello\nversion: 1.0.0\ndescription: Hello bundle\n",
  );
  fs.writeFileSync(
    path.join(root, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: Say hello\n---\nSay hello.\n",
  );
  return root;
}

const envelopeSchema = SCHEMA_BY_ID.get("envelope")!.schema;
const validateEnvelope = new Ajv2020({ allErrors: true, strict: false }).compile(envelopeSchema);

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("--envelope", () => {
  interface Case {
    label: string;
    args: (context: { workspace: string; bundle: string }) => string[];
  }

  // One test per command rather than one test for all of them: each case is two
  // spawns, so a loaded machine cannot push the whole set past a single
  // timeout, and a failure names the command in the test title.
  const cases: Case[] = [
    { label: "md graph", args: (c) => ["md", "graph", c.workspace] },
    { label: "md stats", args: () => ["md", "stats", path.join(fixtures, "clean.md")] },
    { label: "md query tasks", args: (c) => ["md", "query", "tasks", c.workspace] },
    { label: "md lint (clean)", args: () => ["md", "lint", path.join(fixtures, "clean.md")] },
    {
      label: "md lint (findings)",
      args: () => ["md", "lint", path.join(fixtures, "mixed-errors.md")],
    },
    { label: "md orphans", args: (c) => ["md", "orphans", c.workspace] },
    { label: "md index status", args: (c) => ["md", "index", "status", c.workspace] },
    { label: "md headers", args: () => ["md", "headers", path.join(fixtures, "clean.md")] },
    { label: "md toc", args: () => ["md", "toc", path.join(fixtures, "clean.md")] },
    {
      // A fixture rather than a temporary root: source reads are bounded by
      // the workspace root, which for this suite is the repository.
      label: "md check-snippets (findings)",
      args: () => ["md", "check-snippets", path.join(fixtures, "snippet-stale.md")],
    },
    { label: "agent inspect", args: (c) => ["agent", "inspect", c.bundle] },
    { label: "agent specs", args: () => ["agent", "specs", "--target", "all"] },
    // `usage` reads logs outside the workspace, so it is pointed at a fixture
    // corpus.
    { label: "usage summary", args: () => ["usage", "summary", ...usageLogs] },
    { label: "usage tokens", args: () => ["usage", "tokens", "--by", "day", ...usageLogs] },
    { label: "usage tools", args: () => ["usage", "tools", ...usageLogs] },
    { label: "usage sessions", args: () => ["usage", "sessions", ...usageLogs] },
    { label: "usage projects", args: () => ["usage", "projects", ...usageLogs] },
    { label: "usage skills", args: () => ["usage", "skills", ...usageLogs] },
    { label: "usage agents", args: () => ["usage", "agents", ...usageLogs] },
    { label: "usage hooks", args: () => ["usage", "hooks", ...usageLogs] },
    { label: "usage commands", args: () => ["usage", "commands", ...usageLogs] },
    { label: "usage providers", args: () => ["usage", "providers", ...usageFixture] },
    { label: "usage index", args: () => ["usage", "index", ...usageFixture] },
  ];

  it.each(cases)("$label wraps without changing the payload", async (testCase) => {
    const command = testCase.args({ workspace: workspace(), bundle: bundle() });
    const label = testCase.label;
    // Both invocations share one cache directory, so a cache-sensitive payload
    // such as `md index status` sees the same state twice.
    const cache = cacheHome();
    const plain = await runWith(cache, ...command, "--format", "json");
    const wrapped = await runWith(cache, ...command, "--format", "json", "--envelope");

    // The exit code and the stream carrying the payload must not change.
    expect(wrapped.code, `${label}: exit code changed`).toBe(plain.code);
    const plainOut = plain.stdout.trim() || plain.stderr.trim();
    const wrappedRaw = wrapped.stdout.trim() || wrapped.stderr.trim();
    expect(Boolean(wrapped.stdout.trim()), `${label}: stream changed`).toBe(
      Boolean(plain.stdout.trim()),
    );

    const envelope = JSON.parse(wrappedRaw);
    expect(validateEnvelope(envelope), `${label}: ${JSON.stringify(validateEnvelope.errors)}`).toBe(
      true,
    );
    expect(envelope.schemaVersion, label).toBe("2");
    expect(envelope.command, label).toBe(`${command[0]} ${command[1]}`);
    expect(envelope.exitCode, label).toBe(plain.code);
    expect(envelope.ok, label).toBe(plain.code === 0);
    // The whole point: unwrapping yields exactly the unenveloped output.
    expect(envelope.data, `${label}: data differs from the plain payload`).toEqual(
      JSON.parse(plainOut),
    );
  });

  it("carries the schema id when one is published, and null otherwise", async () => {
    const graph = JSON.parse((await run("md", "graph", workspace(), "-fj", "--envelope")).stdout);
    expect(graph.schema).toContain("/v1/md-graph.json");
    const stats = JSON.parse(
      (await run("md", "stats", path.join(fixtures, "clean.md"), "-fj", "--envelope")).stdout,
    );
    expect(stats.schema).toBeNull();
  });

  it("requires --format json", async () => {
    for (const format of ["llm", "human", "jsonl", "sarif"]) {
      const result = await run(
        "md",
        "lint",
        path.join(fixtures, "clean.md"),
        "--format",
        format,
        "--envelope",
      );
      expect(result.code, format).toBe(1);
      expect(result.stderr, format).toMatch(/--envelope requires --format json/);
    }
  });

  it("leaves output untouched when not requested", async () => {
    const root = workspace();
    const before = await run("md", "graph", root, "-fj");
    const after = await run("md", "graph", root, "-fj");
    expect(after.stdout).toBe(before.stdout);
    expect(JSON.parse(before.stdout)).not.toHaveProperty("schemaVersion");
  });
});
