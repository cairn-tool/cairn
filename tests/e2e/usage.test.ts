import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";
import { ANTIGRAVITY_FIXTURE, buildAntigravityLogs } from "../helpers/antigravity-fixture.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const logs = path.resolve("tests/fixtures/usage-logs");
const temporary: string[] = [];

/** Every case reads the fixture corpus rather than whatever this machine has. */
const FIXTURE = ["--logs", logs];
const CODEX = ["--provider", "codex", "--logs", path.resolve("tests/fixtures/usage-logs-codex")];

/**
 * Antigravity's fixture is generated rather than committed: half of it is a
 * SQLite store of schema-less protobuf, and a binary nobody can read is a poor
 * thing to assert against.
 */
let antigravityRoot = "";
const ANTIGRAVITY = (): string[] => ["--provider", "antigravity", "--logs", antigravityRoot];

beforeAll(() => {
  antigravityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usage-e2e-antigravity-"));
  buildAntigravityLogs(antigravityRoot, ANTIGRAVITY_FIXTURE);
});

afterAll(() => {
  fs.rmSync(antigravityRoot, { recursive: true, force: true });
});

/** The CSI introducer, so the styling assertions do not embed a raw control byte. */
const ESCAPE = "\u001b[";

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A cache home of its own, so the suite neither reads nor grows the real one. */
function cacheHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-e2e-cache-"));
  temporary.push(root);
  return root;
}

async function runWith(cache: string, ...args: string[]): Promise<Run> {
  const env = { ...process.env, CI: "1", XDG_CACHE_HOME: cache };
  try {
    const result = await exec("node", [cli, ...args], { env });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

async function run(...args: string[]): Promise<Run> {
  return runWith(cacheHome(), ...args);
}

function json(result: Run): Record<string, unknown> {
  return JSON.parse(result.stdout.trim() || result.stderr.trim());
}

function validate(schemaId: string, payload: unknown): void {
  const entry = SCHEMA_BY_ID.get(schemaId);
  expect(entry, `schema ${schemaId} is not published`).toBeDefined();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const check = ajv.compile(entry!.schema);
  expect(check(payload), ajv.errorsText(check.errors, { separator: "; " })).toBe(true);
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("usage summary", () => {
  it("reports the fixture corpus without double-counting the response fan-out", async () => {
    const result = await run("usage", "summary", ...FIXTURE, "-fj");
    expect(result.exitCode).toBe(0);
    const payload = json(result);
    validate("usage-summary", payload);

    const summary = payload.summary as {
      sessions: number;
      transcripts: number;
      subagentTranscripts: number;
      prompts: number;
      tokens: { requests: number; cacheWrite: number; cacheWrite5m: number };
      features: Record<string, number>;
    };
    // Six deduplicated responses across both transcripts: one of them was
    // written over three lines, and a synthetic record is not counted at all.
    expect(summary.sessions).toBe(1);
    expect(summary.transcripts).toBe(2);
    expect(summary.subagentTranscripts).toBe(1);
    expect(summary.tokens.requests).toBe(6);
    // Two typed turns; the injected meta turn is not a prompt.
    expect(summary.prompts).toBe(2);
    // Only one record carried a TTL split, so the split sums to less than the
    // authoritative total rather than equalling it.
    expect(summary.tokens.cacheWrite).toBe(442);
    expect(summary.tokens.cacheWrite5m).toBe(100);
    expect(summary.features).toEqual({
      skills: 2,
      subagents: 1,
      hooks: 3,
      hookFailures: 1,
      slashCommands: 1,
      mcpCalls: 1,
    });
  });

  it("reports the malformed line rather than failing on it", async () => {
    const payload = json(await run("usage", "summary", ...FIXTURE, "-fj"));
    expect(payload.scan).toMatchObject({ malformed: 1, skipped: 0 });
  });

  it("excludes subagent transcripts on request", async () => {
    const withSub = json(await run("usage", "summary", ...FIXTURE, "-fj")).summary as {
      tokens: { requests: number };
    };
    const without = json(await run("usage", "summary", ...FIXTURE, "--no-subagents", "-fj"))
      .summary as { transcripts: number; tokens: { requests: number } };
    expect(without.transcripts).toBe(1);
    expect(without.tokens.requests).toBeLessThan(withSub.tokens.requests);
  });
});

describe("scope selection", () => {
  it("narrows to a project and reports the selector back", async () => {
    const hit = json(await run("usage", "tokens", ...FIXTURE, "--project", "alpha", "-fj"));
    expect((hit.scope as { projects: string[] }).projects).toEqual(["alpha"]);
    expect((hit.rows as unknown[]).length).toBeGreaterThan(0);

    const miss = json(await run("usage", "tokens", ...FIXTURE, "--project", "nothing", "-fj"));
    expect(miss.rows).toEqual([]);
  });

  it("clips to an inclusive day window", async () => {
    const payload = json(
      await run("usage", "tokens", ...FIXTURE, "--by", "day", "--until", "2026-08-01", "-fj"),
    );
    expect((payload.rows as Array<{ key: string }>).map((row) => row.key)).toEqual(["2026-08-01"]);
    expect(payload.scope).toMatchObject({ window: { until: "2026-08-01" } });
  });

  it("rejects a window it cannot honour, naming both accepted forms", async () => {
    const bad = await run("usage", "summary", ...FIXTURE, "--since", "last tuesday");
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("Invalid --since value");

    const inverted = await run(
      "usage",
      "summary",
      ...FIXTURE,
      "--since",
      "2026-08-10",
      "--until",
      "2026-08-01",
    );
    expect(inverted.exitCode).toBe(1);
    expect(inverted.stderr).toContain("is after --until");
  });

  it("refuses a log root with nothing in it", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "usage-empty-"));
    temporary.push(empty);
    const result = await run("usage", "summary", "--logs", empty);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No Claude Code logs found");
  });
});

describe("rollups", () => {
  it("classifies MCP, subagent, and skill tool calls apart from builtins", async () => {
    const payload = json(await run("usage", "tools", ...FIXTURE, "-fj"));
    validate("usage-rollup", payload);
    const rows = payload.rows as Array<{ key: string; kind: string; server?: string }>;
    const byName = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byName["mcp__acme_srv__query"]).toMatchObject({ kind: "mcp", server: "acme_srv" });
    expect(byName.Agent.kind).toBe("agent");
    expect(byName.Skill.kind).toBe("skill");
    expect(byName.Bash.kind).toBe("builtin");
  });

  it("reports a subagent's own token cost, not the parent's summary of it", async () => {
    const payload = json(await run("usage", "agents", ...FIXTURE, "-fj"));
    const rows = payload.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "Explore", count: 1, sessions: 1, maxDepth: 1 });
  });

  it("counts hooks with their failures", async () => {
    const rows = json(await run("usage", "hooks", ...FIXTURE, "-fj")).rows as Array<{
      key: string;
      count: number;
      failures: number;
    }>;
    expect(rows.find((row) => row.key === "PostToolUse:Write")).toMatchObject({
      count: 2,
      failures: 1,
    });
    expect(rows.find((row) => row.key === "Stop")!.count).toBe(1);
  });

  it("finds the slash command in the message text", async () => {
    const rows = json(await run("usage", "commands", ...FIXTURE, "-fj")).rows as Array<{
      key: string;
    }>;
    expect(rows.map((row) => row.key)).toEqual(["/commit"]);
  });

  it("clips to --top while leaving the totals whole", async () => {
    const clipped = json(await run("usage", "tools", ...FIXTURE, "--top", "1", "-fj"));
    const totals = clipped.totals as { rows: number };
    expect(clipped.rows).toHaveLength(1);
    expect(clipped.truncated).toBe(true);
    expect(totals.rows).toBeGreaterThan(1);

    const all = json(await run("usage", "tools", ...FIXTURE, "--top", "0", "-fj"));
    expect(all.truncated).toBe(false);
    expect((all.rows as unknown[]).length).toBe(totals.rows);
  });

  it("rejects a dimension it does not have", async () => {
    const result = await run("usage", "tokens", ...FIXTURE, "--by", "phase");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --by value: phase");
  });
});

describe("the scan index", () => {
  it("parses on the first run and serves the second from cache", async () => {
    const cache = cacheHome();
    const first = json(await runWith(cache, "usage", "summary", ...FIXTURE, "-fj"));
    expect(first.scan).toMatchObject({ parsed: 2, cached: 0 });

    const second = json(await runWith(cache, "usage", "summary", ...FIXTURE, "-fj"));
    expect(second.scan).toMatchObject({ parsed: 0, cached: 2 });
  });

  it("answers identically with the cache warm, cold, or bypassed", async () => {
    const cache = cacheHome();
    // `scan` and `scope` are exactly the parts that are meant to differ.
    const report = (payload: Record<string, unknown>): unknown => {
      const { scan: _scan, scope: _scope, ...rest } = payload;
      return rest;
    };
    const cold = json(await runWith(cache, "usage", "tokens", ...FIXTURE, "-fj"));
    const warm = json(await runWith(cache, "usage", "tokens", ...FIXTURE, "-fj"));
    const bypassed = json(await run("usage", "tokens", ...FIXTURE, "--no-index", "-fj"));
    expect(report(warm)).toEqual(report(cold));
    expect(report(bypassed)).toEqual(report(cold));
  });

  it("does not evict entries a filtered scan never looked at", async () => {
    // A --since or --no-subagents walk sees only part of the corpus, so it must
    // merge into the stored shard rather than rebuild it. Rebuilding would make
    // the next full scan re-parse everything it had already done.
    const cache = cacheHome();
    await runWith(cache, "usage", "summary", ...FIXTURE, "-fj");
    await runWith(cache, "usage", "summary", ...FIXTURE, "--no-subagents", "-fj");
    const full = json(await runWith(cache, "usage", "summary", ...FIXTURE, "-fj"));
    expect(full.scan).toMatchObject({ cached: 2, parsed: 0 });
  });

  it("reports, rebuilds, and clears the cache", async () => {
    const cache = cacheHome();
    const empty = json(await runWith(cache, "usage", "index", "-fj"));
    validate("usage-index", empty);
    expect(empty.action).toBe("status");
    expect(empty.cache).toMatchObject({ present: false, entries: 0 });

    const rebuilt = json(await runWith(cache, "usage", "index", "--rebuild", ...FIXTURE, "-fj"));
    expect(rebuilt.action).toBe("rebuild");
    expect(rebuilt.scan).toMatchObject({ parsed: 2 });
    expect(rebuilt.cache).toMatchObject({ entries: 2 });

    const cleared = json(await runWith(cache, "usage", "index", "--clear", "-fj"));
    expect(cleared.action).toBe("clear");
    expect(cleared.removed).toBe(1);
    expect(cleared.cache).toMatchObject({ entries: 0 });
  });

  it("refuses to clear and rebuild in one invocation", async () => {
    const result = await run("usage", "index", "--clear", "--rebuild", ...FIXTURE);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });
});

describe("--strict", () => {
  it("passes over a malformed line by default and blocks on it under --strict", async () => {
    expect((await run("usage", "summary", ...FIXTURE)).exitCode).toBe(0);

    const strict = await run("usage", "summary", ...FIXTURE, "--strict", "-fj");
    expect(strict.exitCode).toBe(2);
    // A findings exit moves the payload to stderr, as the contract declares.
    expect(strict.stdout.trim()).toBe("");
    expect(JSON.parse(strict.stderr).scan.malformed).toBe(1);
  });
});

describe("usage providers", () => {
  it("reports the fixture root as available and describes what it can answer", async () => {
    const result = await run("usage", "providers", ...FIXTURE, "-fj");
    expect(result.exitCode).toBe(0);
    const payload = json(result);
    validate("usage-providers", payload);
    const providers = payload.providers as Array<Record<string, unknown>>;
    // `--logs` is a discovery override, so it makes every provider look for its
    // own layout under the one directory. Only Claude Code's is there.
    expect(providers.find((provider) => provider.name === "claude-code")).toMatchObject({
      name: "claude-code",
      default: true,
      available: true,
      root: logs,
    });
  });

  it("rejects a provider it does not have, listing the ones it does", async () => {
    const result = await run("usage", "summary", "--provider", "gpt-5", ...FIXTURE);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown provider: gpt-5 (known: claude-code");
  });
});

describe("formats", () => {
  it("writes a readable digest in llm and human", async () => {
    const llm = await run("usage", "summary", ...FIXTURE);
    expect(llm.exitCode).toBe(0);
    expect(llm.stdout).toContain("Tokens");
    // llm output carries no styling; human does.
    expect(llm.stdout).not.toContain(ESCAPE);

    const human = await run("usage", "summary", ...FIXTURE, "-fh");
    expect(human.stdout).toContain(ESCAPE);
  });

  it("says so when nothing matched", async () => {
    const result = await run("usage", "skills", ...FIXTURE, "--since", "2027-01-01");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No matching activity.");
  });

  it("rejects an unknown format and --envelope without json", async () => {
    const format = await run("usage", "summary", ...FIXTURE, "--format", "yaml");
    expect(format.exitCode).toBe(1);
    expect(format.stderr).toContain("Invalid output format: yaml");

    const envelope = await run("usage", "summary", ...FIXTURE, "--envelope");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.stderr).toContain("--envelope requires --format json");
  });
});

describe("the codex provider", () => {
  it("differences the running total instead of summing the per-request field", async () => {
    const payload = json(
      await run("usage", "tokens", "--by", "model", ...CODEX, "--no-index", "-fj"),
    );
    validate("usage-rollup", payload);
    const rows = payload.rows as Array<{ key: string; tokens: Record<string, number> }>;
    const sol = rows.find((row) => row.key === "gpt-5.6-sol")!;
    const terra = rows.find((row) => row.key === "gpt-5.6-terra")!;
    // Three deltas for sol across two threads, one for terra after the switch.
    // The duplicate re-emission in the fixture contributes nothing.
    expect(sol.tokens.requests).toBe(3);
    expect(terra.tokens.requests).toBe(1);
    // input + cacheRead reconstructs Codex's own `input_tokens`, which includes
    // the cached part; keeping them merged would inflate input several-fold.
    expect(sol.tokens.input + sol.tokens.cacheRead).toBe(1900);
    expect(terra.tokens.input + terra.tokens.cacheRead).toBe(200);
  });

  it("folds a subagent thread into its parent's project and reports its own tokens", async () => {
    const summary = json(await run("usage", "summary", ...CODEX, "--no-index", "-fj")).summary as {
      transcripts: number;
      subagentTranscripts: number;
      tokensByKind: { subagent: { output: number } };
    };
    expect(summary.transcripts).toBe(2);
    expect(summary.subagentTranscripts).toBe(1);
    expect(summary.tokensByKind.subagent.output).toBe(20);
  });

  it("excludes subagents even though its path does not reveal them", async () => {
    // Codex records the thread source inside the file, so the filter cannot run
    // at discovery the way it does for a provider that encodes it in the path.
    const without = json(
      await run("usage", "summary", ...CODEX, "--no-subagents", "--no-index", "-fj"),
    ).summary as { transcripts: number };
    expect(without.transcripts).toBe(1);
  });

  it("normalizes MCP names and namespaced builtins", async () => {
    const rows = json(await run("usage", "tools", ...CODEX, "--no-index", "-fj")).rows as Array<{
      key: string;
      kind: string;
      server?: string;
    }>;
    const byName = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byName["mcp__node_repl__js"]).toMatchObject({ kind: "mcp", server: "node_repl" });
    expect(byName["web.run"].kind).toBe("builtin");
    expect(byName["collaboration.spawn_agent"].kind).toBe("builtin");
  });

  it("groups subagents by role and by task path", async () => {
    const byRole = json(
      await run("usage", "agents", ...CODEX, "--by", "role", "--no-index", "-fj"),
    ) as { dimension: string; rows: Array<{ key: string }> };
    expect(byRole.dimension).toBe("role");
    expect(byRole.rows.map((row) => row.key)).toContain("worker");

    const byPath = json(
      await run("usage", "agents", ...CODEX, "--by", "path", "--no-index", "-fj"),
    ) as { dimension: string; rows: Array<{ key: string }> };
    expect(byPath.dimension).toBe("path");
    expect(byPath.rows.map((row) => row.key)).toContain("/root/explore");
  });

  it("says it does not record hooks, rather than reporting none", async () => {
    const result = await run("usage", "hooks", ...CODEX, "--no-index");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("does not record hook executions");
    expect(result.stdout).toContain("Available:");

    const payload = json(await run("usage", "hooks", ...CODEX, "--no-index", "-fj"));
    expect(payload.supported).toBe(false);
    expect(payload.rows).toEqual([]);
  });
});

describe("the antigravity provider", () => {
  it("sums per-request rows from the database and tools from the transcript", async () => {
    const payload = json(
      await run("usage", "tokens", "--by", "day", ...ANTIGRAVITY(), "--no-index", "-fj"),
    );
    validate("usage-rollup", payload);
    const rows = payload.rows as Array<{ key: string; tokens: Record<string, number> }>;
    // Prompt tokens are a per-request context size, not a running total.
    expect(rows.map((row) => row.key)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(rows[0].tokens.input).toBe(1500);
    expect(rows[1].tokens.input).toBe(900);

    const tools = json(await run("usage", "tools", ...ANTIGRAVITY(), "--no-index", "-fj"))
      .rows as Array<{ key: string }>;
    expect(tools.map((row) => row.key).sort()).toEqual([
      "invoke_subagent",
      "send_message",
      "write_to_file",
    ]);
  });

  it("reports no cache detail and no skills, because neither is recorded", async () => {
    const summary = json(await run("usage", "summary", ...ANTIGRAVITY(), "--no-index", "-fj"))
      .summary as { tokens: { cacheRead: number; cacheWrite: number } };
    expect(summary.tokens.cacheRead).toBe(0);
    expect(summary.tokens.cacheWrite).toBe(0);

    const skills = await run("usage", "skills", ...ANTIGRAVITY(), "--no-index");
    expect(skills.exitCode).toBe(0);
    expect(skills.stdout).toContain("does not record skill invocations");
  });

  it("keeps stderr clean, which the sqlite experimental warning would not", async () => {
    // stderr carries the JSON payload whenever a command reports findings, so a
    // stray runtime warning there would corrupt a consumer's parse.
    const result = await run("usage", "summary", ...ANTIGRAVITY(), "--no-index", "-fj");
    expect(result.stderr).toBe("");
  });

  it("reads slash commands from the shared history file", async () => {
    const rows = json(await run("usage", "commands", ...ANTIGRAVITY(), "--no-index", "-fj"))
      .rows as Array<{ key: string }>;
    expect(rows.map((row) => row.key)).toContain("/skills");
  });
});

describe("--provider all", () => {
  /**
   * A home directory of its own holding all three layouts.
   *
   * `--logs` names one directory and so cannot serve several providers, and
   * pointing the suite at the real machine would make it scan gigabytes. Every
   * provider discovers under `$HOME`, so supplying one makes the whole set
   * hermetic. `CODEX_HOME` is cleared because it would otherwise win.
   */
  let home = "";

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-e2e-home-"));
    fs.cpSync(logs, path.join(home, ".claude"), { recursive: true });
    fs.cpSync(path.resolve("tests/fixtures/usage-logs-codex"), path.join(home, ".codex"), {
      recursive: true,
    });
    buildAntigravityLogs(path.join(home, ".gemini", "antigravity-cli"), ANTIGRAVITY_FIXTURE);
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function runHome(...args: string[]): Promise<Run> {
    const env = { ...process.env, CI: "1", HOME: home, XDG_CACHE_HOME: cacheHome() };
    delete env.CODEX_HOME;
    delete env.CLAUDE_CONFIG_DIR;
    try {
      const result = await exec("node", [cli, ...args], { env });
      return { ...result, exitCode: 0 };
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.code ?? 1,
      };
    }
  }

  it("merges every provider that has logs, and breaks them down", async () => {
    const payload = json(
      await runHome("usage", "tokens", "--by", "provider", "--provider", "all", "-fj"),
    );
    validate("usage-rollup", payload);
    const scope = payload.scope as { provider: string; providers: string[] };
    expect(scope.provider).toBe("all");
    expect(scope.providers).toEqual(["claude-code", "codex", "antigravity"]);
    const rows = payload.rows as Array<{ key: string; tokens: { requests: number } }>;
    expect(rows.map((row) => row.key).sort()).toEqual(["antigravity", "claude-code", "codex"]);
    // Each provider's own figure, unchanged by being reported alongside others.
    const byName = Object.fromEntries(rows.map((row) => [row.key, row.tokens.requests]));
    expect(byName["claude-code"]).toBe(6);
    expect(byName.codex).toBe(4);
    expect(byName.antigravity).toBe(3);
  });

  it("sums the same activity into one headline", async () => {
    const summary = json(await runHome("usage", "summary", "--provider", "all", "-fj")).summary as {
      sessions: number;
      tokens: { requests: number };
    };
    expect(summary.tokens.requests).toBe(13);
    // Two Claude Code and Codex sessions each, two Antigravity trajectories.
    expect(summary.sessions).toBe(5);
  });

  it("keeps a capability the others lack available to the one that has it", async () => {
    const hooks = json(await runHome("usage", "hooks", "--provider", "all", "-fj"));
    expect(hooks.supported).toBe(true);
    expect((hooks.rows as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses a single log root for several providers", async () => {
    const result = await run("usage", "summary", "--provider", "all", "--logs", logs);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--logs cannot be combined with --provider all");
  });

  it("leaves the default meaning exactly what it did", async () => {
    const cache = cacheHome();
    const strip = (payload: Record<string, unknown>): unknown => {
      const { scan: _scan, ...rest } = payload;
      return rest;
    };
    const bare = json(await runWith(cache, "usage", "tokens", ...FIXTURE, "-fj"));
    const named = json(
      await runWith(cache, "usage", "tokens", "--provider", "claude-code", ...FIXTURE, "-fj"),
    );
    expect(strip(named)).toEqual(strip(bare));
  });

  it("names an unknown provider's alternatives, including all", async () => {
    const result = await run("usage", "summary", "--provider", "gemini-cli", ...FIXTURE);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("claude-code, codex, antigravity, all");
  });

  it("reports every registered provider and what each can answer", async () => {
    const payload = json(await run("usage", "providers", "-fj"));
    validate("usage-providers", payload);
    const providers = payload.providers as Array<{
      name: string;
      capabilities: Record<string, boolean>;
    }>;
    expect(providers.map((provider) => provider.name)).toEqual([
      "claude-code",
      "codex",
      "antigravity",
    ]);
    expect(providers[1].capabilities.hooks).toBe(false);
    expect(providers[2].capabilities.cacheTokens).toBe(false);
  });

  it("reports a cache per provider", async () => {
    const cache = cacheHome();
    const payload = json(await runWith(cache, "usage", "index", "--provider", "all", "-fj"));
    validate("usage-index", payload);
    const caches = payload.caches as Array<{ provider: string }>;
    expect(caches.map((entry) => entry.provider)).toEqual(["claude-code", "codex", "antigravity"]);
  });
});
