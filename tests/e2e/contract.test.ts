import { exec as execShell, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { COMMAND_CONTRACTS } from "../../src/contract/registry.js";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";
import { CONTRACT_VERSION } from "../../src/contract/version.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const fixtures = path.resolve("tests/fixtures");
const temporary: string[] = [];
/**
 * A cache and data home of its own, so no case reads or writes whatever this
 * machine holds for real. `usage index` reports on that directory directly, and
 * the usage store lives under `XDG_DATA_HOME` rather than the cache.
 */
const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "contract-cache-"));
const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(...args: string[]): Promise<Run> {
  // A non-zero exit arrives as a rejection, so the exit code comes from here.
  try {
    const result = await exec("node", [cli, ...args], {
      env: { ...process.env, CI: "1", XDG_CACHE_HOME: cacheHome, XDG_DATA_HOME: cacheHome },
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-e2e-"));
  temporary.push(root);
  fs.writeFileSync(path.join(root, "index.md"), "# Index\n\n- [Clean](./clean.md)\n");
  fs.writeFileSync(path.join(root, "clean.md"), "# Clean\n\n- [x] Done\n- [ ] Pending\n");
  fs.writeFileSync(path.join(root, "loner.md"), "# Loner\n\nNothing links here.\n");
  return root;
}

/**
 * A workspace of its own, so the stale marker block cannot perturb the counts
 * every other case reads out of the shared one.
 */
function staleToc(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-toc-"));
  temporary.push(root);
  fs.writeFileSync(
    path.join(root, "stale.md"),
    "# Doc\n\n<!-- cairn:toc:start -->\nold\n<!-- cairn:toc:end -->\n\n## Section\n",
  );
  return root;
}

/**
 * A baseline recording a finding that no longer occurs, so the payload carries
 * a populated `stale` list and the `baselineEntry` shape is actually validated.
 */
function auditBaseline(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-baseline-"));
  temporary.push(root);
  const file = path.join(root, "baseline.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      baselineFormat: "cairn-md-audit-baseline",
      version: "1",
      generator: { name: "@cairn-tool/cairn", version: "0.0.0" },
      entries: [{ checker: "toc", file: "gone.md", message: "stale", count: 1 }],
    }),
  );
  return file;
}

function bundle(manifest?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-bundle-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "skills", "hello"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agent-bundle.yaml"),
    manifest ?? "schemaVersion: '1'\nname: hello\nversion: 1.0.0\ndescription: Hello bundle\n",
  );
  fs.writeFileSync(
    path.join(root, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: Say hello\n---\nSay hello.\n",
  );
  return root;
}

/**
 * The v1 bundle above cannot carry a `marketplace` block (AB127), and
 * claude-code's catalog requires an owner, so the packaging cases get a v2
 * sibling. `agent upgrade --to-schema 2` still needs the v1 one.
 */
function publishedBundle(): string {
  return bundle(
    "schemaVersion: '2'\nname: hello\nversion: 1.0.0\ndescription: Hello bundle\n" +
      "marketplace:\n  publisher:\n    name: Example\n",
  );
}

/**
 * `usage` reads logs outside the workspace, so every case points it at a fixture
 * corpus and bypasses the scan cache: a contract test must not depend on, or
 * write to, whatever this machine happens to have in its real log root.
 */
const USAGE_FIXTURE = ["--logs", path.join(fixtures, "usage-logs"), "-fj"];
/**
 * `archive` writes, so every case points it at a directory of this run's own and
 * reads the fixture corpus rather than this machine's real log roots.
 */
const ARCHIVE_LOGS = [
  "--logs",
  path.join(fixtures, "usage-logs"),
  "--include",
  "transcripts",
  "-fj",
];
let archiveHome = "";
const archiveRoot = (): string => {
  if (!archiveHome) {
    archiveHome = fs.mkdtempSync(path.join(os.tmpdir(), "contract-archive-"));
    temporary.push(archiveHome);
  }
  return archiveHome;
};
const USAGE_LOGS = [...USAGE_FIXTURE, "--no-index"];
/** A second provider, to prove the payload shape is not Claude Code's alone. */
const CODEX_LOGS = [
  "--provider",
  "codex",
  "--logs",
  path.join(fixtures, "usage-logs-codex"),
  "-fj",
  "--no-index",
];

function validate(schemaId: string, payload: unknown, label: string): void {
  const entry = SCHEMA_BY_ID.get(schemaId);
  expect(entry, `${label}: schema ${schemaId} is not published`).toBeDefined();
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const check = ajv.compile(entry!.schema);
  const valid = check(payload);
  expect(valid, `${label}: ${ajv.errorsText(check.errors, { separator: "; " })}`).toBe(true);
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(cacheHome, { recursive: true, force: true });
});

describe("describe", () => {
  it("describes the whole CLI", async () => {
    const result = await run("describe", "--format", "json");
    expect(result.exitCode).toBe(0);
    const described = JSON.parse(result.stdout);
    expect(described.schemaVersion).toBe(CONTRACT_VERSION);
    const ids = described.commands.map((command: { id: string }) => command.id);
    for (const id of ["md graph", "agent convert", "agent doctor", "describe", "schema"])
      expect(ids).toContain(id);
    // The internal cache refresh is hidden and must not be described.
    expect(ids).not.toContain("__refresh-update-cache");
  });

  it("is self-consistent with its own published schema", async () => {
    const result = await run("describe", "-fj");
    validate("describe", JSON.parse(result.stdout), "describe");
  });

  it("matches the registry in both directions", async () => {
    const result = await run("describe", "-fj");
    const described = JSON.parse(result.stdout) as {
      commands: Array<{ id: string; stability: string }>;
    };
    // Leaf commands are the ones a contract applies to; groups are containers.
    const groups = new Set(["md", "agent", "scripts", "usage", "archive"]);
    const walked = described.commands
      .map((command) => command.id)
      .filter((id) => !groups.has(id))
      .sort();
    expect(walked).toEqual(Object.keys(COMMAND_CONTRACTS).sort());
    const undeclared = described.commands.filter(
      (command) => !groups.has(command.id) && command.stability === "undeclared",
    );
    expect(undeclared.map((command) => command.id)).toEqual([]);
  });

  it("narrows to a single command path", async () => {
    const result = await run("describe", "md", "graph", "--format", "json");
    expect(result.exitCode).toBe(0);
    const described = JSON.parse(result.stdout);
    expect(described.commands).toHaveLength(1);
    expect(described.commands[0].id).toBe("md graph");
    expect(described.commands[0].usage).toContain("md graph");
  });

  it("survives a reader that closes the pipe early", async () => {
    // describe is ~150KB, past the pipe buffer, so its write completes
    // asynchronously. `describe -fj | head` and `| jq '.commands[0]'` are normal
    // usage and must not surface an unhandled EPIPE.
    const { stdout, stderr } = await promisify(execShell)(
      `node ${JSON.stringify(cli)} describe --format json | head -c 200`,
      { env: { ...process.env, CI: "1" } },
    );
    expect(stderr).not.toMatch(/EPIPE/);
    expect(stdout.startsWith("{")).toBe(true);
  });

  it("rejects an unknown command path and an unsupported format", async () => {
    const unknown = await run("describe", "md", "nope");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown command/);
    expect((await run("describe", "--format", "sarif")).exitCode).toBe(1);
  });
});

describe("schema", () => {
  it("lists the published schemas", async () => {
    const result = await run("schema", "--format", "json");
    expect(result.exitCode).toBe(0);
    const listing = JSON.parse(result.stdout);
    validate("schema-list", listing, "schema listing");
    expect(listing.schemas.map((entry: { id: string }) => entry.id)).toContain("agent-result");
  });

  it("retrieves a schema document regardless of format", async () => {
    for (const args of [
      ["schema", "md-graph"],
      ["schema", "md-graph", "--format", "human"],
    ]) {
      const result = await run(...args);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).$id).toContain("/v1/md-graph.json");
    }
  });

  it("rejects an unknown id", async () => {
    const result = await run("schema", "nope");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Unknown schema id/);
  });
});

describe("declared output schemas match real output", () => {
  interface Case {
    label: string;
    schema: string;
    args: (context: {
      workspace: string;
      bundle: string;
      publishedBundle: string;
      staleToc: string;
      auditBaseline: string;
    }) => string[];
    outcome: "success" | "findings";
    exitCode: number;
  }

  const cases: Case[] = [
    {
      label: "md lint (clean)",
      schema: "issue-list",
      args: () => ["md", "lint", path.join(fixtures, "clean.md"), "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md lint (findings)",
      schema: "issue-list",
      args: () => ["md", "lint", path.join(fixtures, "mixed-errors.md"), "-fj"],
      outcome: "findings",
      exitCode: 2,
    },
    {
      label: "md lint-dir --summary",
      schema: "lint-dir-summary",
      args: (c) => ["md", "lint-dir", c.workspace, "--summary", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md graph",
      schema: "md-graph",
      args: (c) => ["md", "graph", c.workspace, "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md audit",
      schema: "md-audit",
      args: (c) => ["md", "audit", c.workspace, "--no-external", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md audit --no-graph",
      schema: "md-audit",
      args: (c) => ["md", "audit", c.workspace, "--no-external", "--no-graph", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md audit --baseline",
      schema: "md-audit",
      args: (c) => [
        "md",
        "audit",
        c.workspace,
        "--no-external",
        "--baseline",
        c.auditBaseline,
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md query tasks",
      schema: "md-query",
      args: (c) => ["md", "query", "tasks", c.workspace, "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md query links-to",
      schema: "md-query",
      args: (c) => ["md", "query", "links-to", c.workspace, "--target", "clean.md", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md query frontmatter-keys",
      schema: "md-query",
      args: (c) => ["md", "query", "frontmatter-keys", c.workspace, "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md query documents (composable)",
      schema: "md-query",
      args: (c) => ["md", "query", "documents", c.workspace, "--where", "has:h1", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md query links --select",
      schema: "md-query",
      args: (c) => ["md", "query", "links", c.workspace, "--select", "file,line,target", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md query tasks --group-by",
      schema: "md-query",
      args: (c) => ["md", "query", "tasks", c.workspace, "--group-by", "checked", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md query duplicates",
      schema: "md-query",
      args: (c) => ["md", "query", "duplicates", c.workspace, "--field", "title", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md check-urls (no external urls)",
      schema: "md-check-urls",
      args: () => ["md", "check-urls", path.join(fixtures, "clean.md"), "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    // Fixtures rather than a temporary workspace: source reads are bounded by
    // the workspace root, which for this suite is the repository it runs in.
    {
      label: "md check-snippets (up to date)",
      schema: "md-check-snippets",
      args: () => ["md", "check-snippets", path.join(fixtures, "snippet-current.md"), "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md check-snippets (drift)",
      schema: "md-check-snippets",
      args: () => ["md", "check-snippets", path.join(fixtures, "snippet-stale.md"), "-fj"],
      outcome: "findings",
      exitCode: 2,
    },
    {
      label: "md orphans",
      schema: "md-orphans",
      args: (c) => ["md", "orphans", c.workspace, "-fj"],
      outcome: "findings",
      exitCode: 2,
    },
    {
      // Revision mode needs a Git repository, which the shared workspace
      // helper does not build; it is covered in tests/unit/git.test.ts instead.
      // The payload shape is identical between the two modes.
      label: "md diff (files)",
      schema: "md-diff",
      args: (c) => [
        "md",
        "diff",
        path.join(c.workspace, "clean.md"),
        path.join(c.workspace, "loner.md"),
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md fix --check (findings)",
      schema: "md-fix",
      args: (c) => ["md", "fix", c.staleToc, "-fj"],
      outcome: "findings",
      exitCode: 2,
    },
    {
      // A non-empty plan is a success in dry-run: it is an explicit request to
      // see the plan, and only a conflict means --write could not follow.
      label: "md fix --dry-run",
      schema: "md-fix",
      args: (c) => ["md", "fix", c.staleToc, "--dry-run", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md context",
      schema: "md-context",
      args: (c) => ["md", "context", path.join(c.workspace, "index.md"), "--depth", "1", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md context (truncated by budget)",
      schema: "md-context",
      args: (c) => [
        "md",
        "context",
        path.join(c.workspace, "index.md"),
        "--depth",
        "1",
        "--budget",
        "20",
        "-fj",
      ],
      // A truncated pack is still a success: the budget was honored, not violated.
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "md index status",
      schema: "md-index",
      args: (c) => ["md", "index", "status", c.workspace, "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent inspect",
      schema: "agent-result",
      args: (c) => ["agent", "inspect", c.bundle, "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent audit",
      schema: "agent-result",
      args: (c) => ["agent", "audit", c.bundle, "--target", "claude-code", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent convert --dry-run",
      schema: "agent-result",
      args: (c) => [
        "agent",
        "convert",
        c.bundle,
        "--target",
        "all",
        "--output",
        path.join(c.workspace, "out"),
        "--dry-run",
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent doctor",
      schema: "agent-result",
      args: (c) => ["agent", "doctor", c.bundle, "--target", "all", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent specs",
      schema: "agent-result",
      args: () => ["agent", "specs", "--target", "all", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent inspect --target",
      schema: "agent-result",
      args: (c) => ["agent", "inspect", c.bundle, "--target", "codex", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent validate (invocation failure)",
      schema: "agent-result",
      args: (c) => ["agent", "validate", path.join(c.workspace, "absent"), "-fj"],
      outcome: "success",
      exitCode: 1,
    },
    {
      label: "agent init --dry-run",
      schema: "agent-result",
      args: (c) => [
        "agent",
        "init",
        "demo",
        "--output",
        path.join(c.workspace, "demo"),
        "--dry-run",
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent add --dry-run",
      schema: "agent-result",
      args: (c) => ["agent", "add", "skill", "extra", c.bundle, "--dry-run", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent upgrade --dry-run",
      schema: "agent-result",
      args: (c) => ["agent", "upgrade", c.bundle, "--to-schema", "2", "--dry-run", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent import --dry-run",
      schema: "agent-result",
      args: (c) => [
        "agent",
        "import",
        c.bundle,
        "--from",
        "claude-code-project",
        "--output",
        path.join(c.workspace, "imported"),
        "--dry-run",
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent package --dry-run",
      schema: "agent-result",
      args: (c) => [
        "agent",
        "package",
        c.publishedBundle,
        "--target",
        "claude-code",
        "--output",
        path.join(c.workspace, "pkg"),
        "--dry-run",
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent install --dry-run",
      schema: "agent-result",
      args: (c) => [
        "agent",
        "install",
        c.bundle,
        "--target",
        "cursor",
        "--into",
        path.join(c.workspace, "plugins"),
        "--dry-run",
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent uninstall --check",
      schema: "agent-result",
      args: (c) => [
        "agent",
        "uninstall",
        "hello",
        "--target",
        "cursor",
        "--into",
        path.join(c.workspace, "plugins"),
        "--check",
        "-fj",
      ],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "agent installed",
      schema: "agent-result",
      args: (c) => ["agent", "installed", "--into", c.workspace, "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "scripts list",
      schema: "script-list",
      args: () => ["scripts", "list", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage summary",
      schema: "usage-summary",
      args: () => ["usage", "summary", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage tokens",
      schema: "usage-rollup",
      args: () => ["usage", "tokens", "--by", "day", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage tools",
      schema: "usage-rollup",
      args: () => ["usage", "tools", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage sessions",
      schema: "usage-rollup",
      args: () => ["usage", "sessions", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage projects",
      schema: "usage-rollup",
      args: () => ["usage", "projects", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage skills",
      schema: "usage-rollup",
      args: () => ["usage", "skills", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage agents",
      schema: "usage-rollup",
      args: () => ["usage", "agents", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage hooks",
      schema: "usage-rollup",
      args: () => ["usage", "hooks", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage commands",
      schema: "usage-rollup",
      args: () => ["usage", "commands", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage providers",
      schema: "usage-providers",
      // `usage providers` never scans, so it has no --no-index to give.
      args: () => ["usage", "providers", ...USAGE_FIXTURE],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage index",
      schema: "usage-index",
      args: () => ["usage", "index", ...USAGE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      // `import` and `migrate` write to the store, so they use the fixture corpus
      // with the index on rather than USAGE_LOGS, which bypasses it.
      label: "usage import",
      schema: "usage-import",
      args: () => ["usage", "import", ...USAGE_FIXTURE],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage migrate",
      schema: "usage-import",
      args: () => ["usage", "migrate", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage migrate (check)",
      schema: "usage-import",
      args: () => ["usage", "migrate", "--check", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      // The archive commands act on a directory of this run's own, never on
      // whatever the developer has archived for real.
      label: "archive run",
      schema: "archive-result",
      args: () => ["archive", "run", "--archive", archiveRoot(), ...ARCHIVE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "archive run (dry run)",
      schema: "archive-result",
      args: () => ["archive", "run", "--archive", archiveRoot(), "--dry-run", ...ARCHIVE_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "archive status",
      schema: "archive-listing",
      args: () => ["archive", "status", "--archive", archiveRoot(), "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "archive list",
      schema: "archive-listing",
      args: () => ["archive", "list", "--archive", archiveRoot(), "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "archive verify",
      schema: "archive-result",
      args: () => ["archive", "verify", "--archive", archiveRoot(), "--deep", "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "archive migrate",
      schema: "archive-result",
      args: () => ["archive", "migrate", "--archive", archiveRoot(), "-fj"],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage summary (codex)",
      schema: "usage-summary",
      args: () => ["usage", "summary", ...CODEX_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage agents (codex, by path)",
      schema: "usage-rollup",
      args: () => ["usage", "agents", "--by", "path", ...CODEX_LOGS],
      outcome: "success",
      exitCode: 0,
    },
    {
      label: "usage hooks (codex, unsupported)",
      schema: "usage-rollup",
      args: () => ["usage", "hooks", ...CODEX_LOGS],
      outcome: "success",
      exitCode: 0,
    },
  ];

  // Groups whose id is two tokens.
  const GROUPS = new Set(["md", "agent", "scripts", "usage", "archive"]);

  it.each(cases)("$label", async (testCase) => {
    const context = {
      workspace: workspace(),
      bundle: bundle(),
      publishedBundle: publishedBundle(),
      staleToc: staleToc(),
      auditBaseline: auditBaseline(),
    };
    const args = testCase.args(context);
    const result = await run(...args);

    const id = GROUPS.has(args[0]) ? `${args[0]} ${args[1]}` : args[0];
    const contract = COMMAND_CONTRACTS[id];
    expect(contract, `${id} has no contract entry`).toBeDefined();
    expect(
      contract.exitCodes.map((exit) => exit.code),
      `${testCase.label} exited ${result.exitCode}`,
    ).toContain(testCase.exitCode);
    expect(result.exitCode, testCase.label).toBe(testCase.exitCode);

    const declared =
      testCase.outcome === "findings" ? (contract.stream.findings ?? "stdout") : "stream";
    const stream = declared === "stderr" ? result.stderr : result.stdout;
    expect(stream.trim(), `${testCase.label} wrote nothing to the declared stream`).not.toBe("");
    validate(testCase.schema, JSON.parse(stream), testCase.label);
  });
});

describe("automation formats", () => {
  it("emits records matching the jsonl schema", async () => {
    const result = await run(
      "md",
      "lint",
      path.join(fixtures, "mixed-errors.md"),
      "--format",
      "jsonl",
    );
    expect(result.exitCode).toBe(2);
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) validate("diagnostic-record", JSON.parse(line), "jsonl record");
    expect(JSON.parse(lines[lines.length - 1]).type).toBe("summary");
  });
});
