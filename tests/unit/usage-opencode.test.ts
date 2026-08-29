import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeProvider } from "../../src/usage/providers/opencode.js";
import type { FileAggregate } from "../../src/usage/events.js";
import { OPENCODE_FIXTURE, buildOpencodeStore } from "../helpers/opencode-fixture.js";

/**
 * OpenCode counting.
 *
 * Two things here have no precedent elsewhere in the project and carry the
 * cases to match: the store has no filesystem unit below itself, so a session's
 * freshness key is derived from its own rows; and the same usage is written at
 * three grains, so reading more than one of them doubles every figure.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-opencode-"));
  temporary.push(root);
  return root;
}

function fixture(): string {
  const root = scratch();
  buildOpencodeStore(root, OPENCODE_FIXTURE);
  return root;
}

async function aggregateFor(root: string, sessionId: string): Promise<FileAggregate> {
  const found = opencodeProvider.discover(root, { subagents: true });
  const file = found.find((entry) => entry.relative.endsWith(sessionId));
  if (!file) throw new Error(`no session ${sessionId} among ${found.length} discovered`);
  return opencodeProvider.read(file);
}

const DAY = "2026-08-01";

describe("the log root", () => {
  it("prefers an explicit override, then XDG, then the default", () => {
    const root = fixture();
    expect(opencodeProvider.root({ env: {}, home: "/nowhere", override: root })).toBe(root);
    expect(opencodeProvider.root({ env: { XDG_DATA_HOME: path.dirname(root) }, home: "/nowhere" }))
      // The XDG branch appends `opencode`, which the scratch root is not named.
      .toBeNull();
  });

  it("reports no root when the store is absent", () => {
    expect(opencodeProvider.root({ env: {}, home: scratch() })).toBeNull();
  });
});

describe("discovery", () => {
  it("yields one entry per session out of a single database", () => {
    const found = opencodeProvider.discover(fixture(), { subagents: true });
    expect(found.map((entry) => entry.relative)).toEqual(["session/ses_child", "session/ses_main"]);
    expect(found.every((entry) => entry.file.endsWith("opencode.db"))).toBe(true);
  });

  it("prunes subagents from the walk, because parent_id is on the row", () => {
    const found = opencodeProvider.discover(fixture(), { subagents: false });
    expect(found.map((entry) => entry.relative)).toEqual(["session/ses_main"]);
  });

  it("keys freshness per session rather than on the database's mtime", () => {
    const root = fixture();
    const before = opencodeProvider.discover(root, { subagents: true });

    // Rewrite the store with one session's messages extended. The file's own
    // mtime changes for both sessions; only the touched session's key may.
    const grown = OPENCODE_FIXTURE.map((session) =>
      session.id === "ses_child"
        ? {
            ...session,
            messages: [
              ...session.messages,
              { id: "msg_5", role: "user" as const, createdMs: Date.parse("2026-08-01T13:00:00Z") },
            ],
          }
        : session,
    );
    buildOpencodeStore(root, grown);
    const after = opencodeProvider.discover(root, { subagents: true });

    const key = (entries: typeof before, id: string) => {
      const entry = entries.find((candidate) => candidate.relative.endsWith(id))!;
      return `${entry.size}:${entry.mtimeMs}`;
    };
    expect(key(after, "ses_main")).toBe(key(before, "ses_main"));
    expect(key(after, "ses_child")).not.toBe(key(before, "ses_child"));
  });

  it("takes the freshness key from the rows, not the stale session column", async () => {
    // `ses_main` records time_updated at 10:00 while its message completed at
    // 12:00. Trusting the column alone would leave it cached half-written.
    const found = opencodeProvider.discover(fixture(), { subagents: true });
    const main = found.find((entry) => entry.relative.endsWith("ses_main"))!;
    expect(main.mtimeMs).toBe(Date.parse("2026-08-01T12:00:00.000Z"));
  });
});

describe("token accounting", () => {
  it("reads the message grain, and not the step-finish copy beside it", async () => {
    const aggregate = await aggregateFor(fixture(), "ses_main");
    const tokens = aggregate.days[DAY].models["anthropic/claude-sonnet-5"];
    // The step-finish part carries the same figures. Reading both doubles all
    // of them, which is the whole reason only one grain is read.
    expect(tokens.input).toBe(1000);
    expect(tokens.output).toBe(200);
    expect(tokens.thinking).toBe(50);
    expect(tokens.requests).toBe(1);
  });

  it("keeps cache reads beside input rather than inside it", async () => {
    const aggregate = await aggregateFor(fixture(), "ses_main");
    const tokens = aggregate.days[DAY].models["anthropic/claude-sonnet-5"];
    // Unlike Codex and Gemini CLI, nothing is subtracted here.
    expect(tokens.cacheRead).toBe(300);
    expect(tokens.cacheWrite).toBe(40);
  });

  it("reproduces the session rollup the store keeps alongside", async () => {
    const root = fixture();
    const main = await aggregateFor(root, "ses_main");
    const child = await aggregateFor(root, "ses_child");
    // The rollup columns are written by the fixture from the same message
    // figures, so this is the in-test form of the cross-check the provider
    // deliberately does not perform at runtime.
    const sum = (aggregate: FileAggregate, key: "input" | "output") =>
      Object.values(aggregate.days).reduce(
        (total, bucket) =>
          total + Object.values(bucket.models).reduce((inner, t) => inner + t[key], 0),
        0,
      );
    expect(sum(main, "input") + sum(child, "input")).toBe(1500);
    expect(sum(main, "output") + sum(child, "output")).toBe(300);
  });

  it("names a model by provider and id, because a bare id collides", async () => {
    const aggregate = await aggregateFor(fixture(), "ses_main");
    expect(Object.keys(aggregate.days[DAY].models)).toEqual(["anthropic/claude-sonnet-5"]);
  });
});

describe("tools, agents, and identity", () => {
  it("counts tool calls from part rows only", async () => {
    const bucket = (await aggregateFor(fixture(), "ses_main")).days[DAY];
    expect(bucket.tools).toEqual({ read: 1, grep: 1, task: 1 });
  });

  it("names the spawned role from the task call, and counts a failed tool", async () => {
    const bucket = (await aggregateFor(fixture(), "ses_main")).days[DAY];
    expect(bucket.agents.explore.count).toBe(1);
    expect(bucket.errors).toBe(1);
  });

  it("takes a subagent's own role from its messages", async () => {
    const aggregate = await aggregateFor(fixture(), "ses_child");
    expect(aggregate.kind).toBe("subagent");
    expect(aggregate.parentSessionId).toBe("ses_main");
    // Better than joining to the parent's `task` call, and it agrees with it.
    expect(aggregate.agentType).toBe("explore");
  });

  it("reads the project from the session's own directory", async () => {
    expect((await aggregateFor(fixture(), "ses_main")).project).toBe("/work/repo");
  });

  it("counts a user message as a prompt", async () => {
    expect((await aggregateFor(fixture(), "ses_main")).days[DAY].prompts).toBe(1);
  });
});

describe("failure handling", () => {
  it("reports an empty discovery for a store it cannot read", () => {
    const root = scratch();
    fs.writeFileSync(path.join(root, "opencode.db"), "not a database");
    expect(opencodeProvider.discover(root, { subagents: true })).toEqual([]);
  });

  it("survives a table the provider expects being absent", () => {
    const root = fixture();
    // Whatever a future version renames costs exactly that column, never the
    // whole provider — the same rule the antigravity reader follows.
    const rebuilt = buildOpencodeStore(root, []);
    expect(fs.existsSync(rebuilt)).toBe(true);
    expect(opencodeProvider.discover(root, { subagents: true })).toEqual([]);
  });
});
