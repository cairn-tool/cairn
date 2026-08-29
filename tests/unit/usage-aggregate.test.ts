import { describe, expect, it } from "vitest";
import {
  rollupAgents,
  rollupCommands,
  rollupHooks,
  rollupProjects,
  rollupSessions,
  rollupSkills,
  rollupTokens,
  rollupTools,
  summarize,
  totalsOf,
  weekOf,
} from "../../src/usage/aggregate.js";
import type { DayBucket, FileAggregate, TokenTotals } from "../../src/usage/events.js";
import { emptyBucket, emptyTokens, totalTokens } from "../../src/usage/events.js";

function tokens(overrides: Partial<TokenTotals> = {}): TokenTotals {
  return { ...emptyTokens(), requests: 1, ...overrides };
}

function bucket(overrides: Partial<DayBucket> = {}): DayBucket {
  return { ...emptyBucket(), ...overrides };
}

function file(overrides: Partial<FileAggregate> = {}): FileAggregate {
  return {
    file: "/logs/projects/p/s.jsonl",
    size: 1,
    mtimeMs: 1,
    provider: "claude-code",
    sessionId: "s1",
    kind: "main",
    project: "/tmp/alpha",
    firstTs: "2026-08-03T10:00:00.000Z",
    lastTs: "2026-08-03T11:00:00.000Z",
    days: {},
    malformedLines: 0,
    ...overrides,
  };
}

/** A main transcript and the subagent transcript it spawned. */
function pair(): FileAggregate[] {
  return [
    file({
      title: "Alpha",
      days: {
        "2026-08-03": bucket({
          models: { "claude-opus-5": tokens({ output: 100, cacheRead: 900 }) },
          tools: { Bash: 3, Agent: 1, mcp__srv__q: 2 },
          agents: { Explore: { count: 1, maxDepth: 0 } },
          skills: { commit: 1 },
          hooks: {
            "PostToolUse:Write": { count: 2, failures: 1, cancelled: 0, totalMs: 100, maxMs: 90 },
          },
          commands: { "/commit": 1 },
          prompts: 2,
          errors: 1,
          compactions: 1,
        }),
        "2026-08-04": bucket({
          models: { "claude-sonnet-5": tokens({ output: 10, cacheRead: 90 }) },
          tools: { Read: 1 },
        }),
      },
    }),
    file({
      file: "/logs/projects/p/s1/subagents/agent-a.jsonl",
      kind: "subagent",
      parentSessionId: "s1",
      agentId: "a",
      agentType: "Explore",
      spawnDepth: 1,
      days: {
        "2026-08-03": bucket({
          models: { "claude-opus-5": tokens({ output: 40, cacheRead: 60 }) },
          tools: { Grep: 5 },
        }),
      },
    }),
  ];
}

describe("summarize", () => {
  it("folds a session's subagent transcripts into it while keeping the split visible", () => {
    const summary = summarize(pair());
    expect(summary.sessions).toBe(1);
    expect(summary.transcripts).toBe(2);
    expect(summary.subagentTranscripts).toBe(1);
    expect(summary.projects).toBe(1);
    expect(summary.days).toBe(2);
    expect(summary.firstDay).toBe("2026-08-03");
    expect(summary.lastDay).toBe("2026-08-04");
    expect(summary.tokens.output).toBe(150);
    expect(totalTokens(summary.tokensByKind.main)).toBe(1100);
    expect(totalTokens(summary.tokensByKind.subagent)).toBe(100);
    expect(totalTokens(summary.tokens)).toBe(1200);
  });

  it("counts each feature surface once", () => {
    const summary = summarize(pair());
    expect(summary.features).toEqual({
      skills: 1,
      subagents: 1,
      hooks: 2,
      hookFailures: 1,
      slashCommands: 1,
      // Only the mcp__-prefixed tool, not Bash or Agent.
      mcpCalls: 2,
    });
    expect(summary.prompts).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.compactions).toBe(1);
  });
});

describe("rollupTokens", () => {
  it("ranks a non-time dimension by token total", () => {
    const rows = rollupTokens(pair(), "model");
    expect(rows.map((row) => row.key)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(rows[0].tokens!.output).toBe(140);
    expect(rows[0].sessions).toBe(1);
  });

  it("orders a time dimension chronologically instead", () => {
    expect(rollupTokens(pair(), "day").map((row) => row.key)).toEqual(["2026-08-03", "2026-08-04"]);
  });

  it("collapses days into the week they start in", () => {
    // Monday-based, so 2026-08-03 (a Monday) and 2026-08-04 share a bucket.
    expect(weekOf("2026-08-03")).toBe("2026-08-03");
    expect(weekOf("2026-08-04")).toBe("2026-08-03");
    expect(rollupTokens(pair(), "week").map((row) => row.key)).toEqual(["2026-08-03"]);
    expect(rollupTokens(pair(), "month").map((row) => row.key)).toEqual(["2026-08"]);
  });

  it("attributes a subagent's tokens to the project and session that spawned it", () => {
    expect(rollupTokens(pair(), "project")[0]).toMatchObject({ key: "/tmp/alpha" });
    const sessions = rollupTokens(pair(), "session");
    expect(sessions).toHaveLength(1);
    expect(totalTokens(sessions[0].tokens!)).toBe(1200);
  });
});

describe("rollupTools", () => {
  it("splits an MCP name into its server and tool halves", () => {
    const byName = rollupTools(pair(), "name");
    const mcp = byName.find((row) => row.key === "mcp__srv__q");
    expect(mcp).toMatchObject({ kind: "mcp", server: "srv", count: 2 });
  });

  it("filters to one kind", () => {
    expect(rollupTools(pair(), "name", "mcp").map((row) => row.key)).toEqual(["mcp__srv__q"]);
    expect(rollupTools(pair(), "name", "agent").map((row) => row.key)).toEqual(["Agent"]);
  });

  it("groups builtins under a single server bucket", () => {
    const rows = rollupTools(pair(), "server");
    expect(rows.find((row) => row.key === "(builtin)")!.count).toBe(10);
    expect(rows.find((row) => row.key === "srv")!.count).toBe(2);
  });
});

describe("rollupSessions", () => {
  it("takes identity from the main transcript and counts the subagents", () => {
    const rows = rollupSessions(pair());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "s1",
      title: "Alpha",
      project: "/tmp/alpha",
      subagents: 1,
      prompts: 2,
    });
    expect(rows[0].toolCalls).toBe(12);
    expect(rows[0].models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("orders by the requested key", () => {
    const other = file({
      sessionId: "s2",
      lastTs: "2026-09-01T00:00:00.000Z",
      days: { "2026-09-01": bucket({ models: { m: tokens({ output: 1 }) }, tools: { Read: 99 } }) },
    });
    const files = [...pair(), other];
    expect(rollupSessions(files, "recent")[0].key).toBe("s2");
    expect(rollupSessions(files, "tokens")[0].key).toBe("s1");
    expect(rollupSessions(files, "tools")[0].key).toBe("s2");
  });
});

describe("rollupAgents", () => {
  it("takes spawns from the parent and tokens from the subagent transcript", () => {
    // The parent's own tool result records only the subagent's final message,
    // so it is never the source of the token figure.
    const rows = rollupAgents(pair());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "Explore", count: 1, sessions: 1, maxDepth: 1 });
    expect(totalTokens(rows[0].tokens!)).toBe(100);
    expect(rows[0].toolCalls).toBe(5);
  });

  it("files a subagent whose type was not recorded rather than dropping it", () => {
    const [main, sub] = pair();
    const { agentType: _agentType, ...anonymous } = sub;
    const rows = rollupAgents([main, anonymous as FileAggregate]);
    expect(rows.map((row) => row.key).sort()).toEqual(["(unrecorded)", "Explore"]);
  });
});

describe("the remaining rollups", () => {
  it("counts skills, hooks, commands, and projects with their session reach", () => {
    const files = pair();
    expect(rollupSkills(files)).toEqual([{ key: "commit", count: 1, sessions: 1 }]);
    expect(rollupCommands(files)).toEqual([{ key: "/commit", count: 1, sessions: 1 }]);
    expect(rollupHooks(files)[0]).toMatchObject({
      key: "PostToolUse:Write",
      count: 2,
      failures: 1,
      meanMs: 50,
      maxMs: 90,
    });
    expect(rollupProjects(files)[0]).toMatchObject({
      key: "/tmp/alpha",
      sessions: 1,
      toolCalls: 12,
      prompts: 2,
    });
  });

  it("files a transcript with no recorded cwd under a named bucket", () => {
    const rows = rollupProjects([file({ project: "", days: { "2026-08-03": bucket() } })]);
    expect(rows[0].key).toBe("(unknown)");
  });
});

describe("totalsOf", () => {
  it("includes cache reads, which are most of what a request actually costs", () => {
    const totals = totalsOf(pair());
    expect(totals.cacheRead).toBe(1050);
    expect(totals.requests).toBe(3);
    expect(totalTokens(totals)).toBe(1200);
  });
});
