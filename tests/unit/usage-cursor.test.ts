import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cursorProvider } from "../../src/usage/providers/cursor.js";
import { classifyTool } from "../../src/usage/events.js";
import type { FileAggregate } from "../../src/usage/events.js";
import { CURSOR_FIXTURE, buildCursorStore } from "../helpers/cursor-fixture.js";

/**
 * Cursor counting.
 *
 * Three things here have no precedent elsewhere in the project and carry the
 * cases to match: the conversation index is incomplete, so discovery cannot come
 * from it; the token counters are real but stopped being written, so a zeroed
 * turn must contribute nothing rather than a request; and a turn carries no
 * timestamp of its own, so days come from the conversation.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cursor-"));
  temporary.push(root);
  return root;
}

function fixture(): string {
  const root = scratch();
  buildCursorStore(root, CURSOR_FIXTURE);
  return root;
}

const LEGACY = "11111111-1111-4111-8111-111111111111";
const SUBAGENT = "22222222-2222-4222-8222-222222222222";
const UNINDEXED = "33333333-3333-4333-8333-333333333333";
const CURRENT = "44444444-4444-4444-8444-444444444444";
const MULTI_ROOT = "55555555-5555-4555-8555-555555555555";

const DAY = "2025-08-01";
const LATER_DAY = "2026-08-01";

async function aggregateFor(root: string, id: string): Promise<FileAggregate> {
  const found = cursorProvider.discover(root, { subagents: true });
  const file = found.find((entry) => entry.relative.endsWith(id));
  if (!file) throw new Error(`no conversation ${id} among ${found.length} discovered`);
  return cursorProvider.read(file);
}

describe("the log root", () => {
  it("prefers an explicit override, and guards on the store inside it", () => {
    const root = fixture();
    expect(cursorProvider.root({ env: {}, home: "/nowhere", override: root })).toBe(root);
    // A directory that exists but holds no store is not a Cursor root.
    expect(cursorProvider.root({ env: {}, home: "/nowhere", override: scratch() })).toBeNull();
  });

  it("finds the user-data directory without switching on the platform", () => {
    const home = scratch();
    buildCursorStore(path.join(home, "Library", "Application Support", "Cursor"), CURSOR_FIXTURE);
    expect(cursorProvider.root({ env: {}, home })).toBe(
      path.join(home, "Library", "Application Support", "Cursor"),
    );

    const linux = scratch();
    buildCursorStore(path.join(linux, ".config", "Cursor"), CURSOR_FIXTURE);
    expect(cursorProvider.root({ env: {}, home: linux })).toBe(
      path.join(linux, ".config", "Cursor"),
    );
  });

  it("reports no root when Cursor has left nothing here", () => {
    expect(cursorProvider.root({ env: {}, home: scratch() })).toBeNull();
  });
});

describe("discovery", () => {
  it("yields one entry per conversation out of a single store", () => {
    const found = cursorProvider.discover(fixture(), { subagents: true });
    expect(found).toHaveLength(CURSOR_FIXTURE.length);
    expect(found.map((entry) => entry.relative).sort()).toEqual(
      CURSOR_FIXTURE.map((spec) => `composer/${spec.id}`).sort(),
    );
    // Byte-sorted, so membership never depends on the machine's ICU build.
    expect(found.map((entry) => entry.relative)).toEqual(
      [...found.map((entry) => entry.relative)].sort(),
    );
  });

  it("finds a conversation that neither index knows about", () => {
    // `composerHeaders` is recent and was never backfilled, and on a real corpus
    // 161 of the 229 token-bearing conversations are in neither index. Deciding
    // existence from an index would drop 61% of all the tokens on the machine.
    const found = cursorProvider.discover(fixture(), { subagents: true });
    expect(found.map((entry) => entry.relative)).toContain(`composer/${UNINDEXED}`);
  });

  it("prunes subagents from the walk, because the index names them", () => {
    const root = fixture();
    const all = cursorProvider.discover(root, { subagents: true });
    const main = cursorProvider.discover(root, { subagents: false });
    expect(all.filter((entry) => entry.kind === "subagent")).toHaveLength(1);
    expect(main).toHaveLength(all.length - 1);
    expect(main.every((entry) => entry.kind === "main")).toBe(true);
  });

  it("keys freshness per conversation rather than on the store's mtime", async () => {
    const root = fixture();
    const file = path.join(root, "User", "globalStorage", "state.vscdb");
    const found = cursorProvider.discover(root, { subagents: true });
    const stats = fs.statSync(file);

    // One value shared by every conversation would invalidate all of them on any
    // write; these are derived from each conversation's own rows instead.
    expect(found.every((entry) => entry.mtimeMs !== stats.mtimeMs)).toBe(true);
    expect(found.every((entry) => entry.size !== stats.size)).toBe(true);

    const legacy = found.find((entry) => entry.relative.endsWith(LEGACY))!;
    // `size` fingerprints the turn count, which is what changes when a
    // conversation grows without its timestamp moving.
    expect(legacy.size).toBe(6);
    expect(legacy.mtimeMs).toBe(Date.UTC(2025, 7, 1, 12) + 60_000);
  });

  it("drops conversations older than the window before opening anything", () => {
    const root = fixture();
    const recent = cursorProvider.discover(root, {
      subagents: true,
      modifiedSince: Date.UTC(2026, 0, 1),
    });
    expect(recent.map((entry) => entry.relative).sort()).toEqual([
      `composer/${CURRENT}`,
      `composer/${MULTI_ROOT}`,
    ]);
  });
});

describe("token accounting", () => {
  it("counts the turns Cursor wrote counters on", async () => {
    const aggregate = await aggregateFor(fixture(), LEGACY);
    const tokens = aggregate.days[DAY].models["claude-4-sonnet-thinking"];
    expect(tokens.input).toBe(1500);
    expect(tokens.output).toBe(300);
    // Two turns carry counters; the three zeroed ones are not requests.
    expect(tokens.requests).toBe(2);
  });

  it("reports no request for a turn whose counters are zero", async () => {
    // Every turn after 2025 is one of these. Counting them would report a
    // request against no tokens for the whole modern corpus.
    const aggregate = await aggregateFor(fixture(), CURRENT);
    expect(Object.keys(aggregate.days[LATER_DAY].models)).toHaveLength(0);
    expect(aggregate.days[LATER_DAY].prompts).toBe(1);
    expect(aggregate.days[LATER_DAY].tools).toEqual({ edit_file_v2: 1, glob_file_search: 1 });
  });

  it("never records a cache or reasoning figure, because none has ever existed", async () => {
    const aggregate = await aggregateFor(fixture(), LEGACY);
    const tokens = aggregate.days[DAY].models["claude-4-sonnet-thinking"];
    expect(tokens.cacheRead).toBe(0);
    expect(tokens.cacheWrite).toBe(0);
    expect(tokens.thinking).toBe(0);
    expect(cursorProvider.capabilities.cacheTokens).toBe(false);
  });

  it("falls back to the legacy usage map when no model is configured", async () => {
    // `modelConfig` postdates the token era, so every conversation that has
    // tokens tends to lack it.
    const legacy = await aggregateFor(fixture(), LEGACY);
    expect(Object.keys(legacy.days[DAY].models)).toEqual(["claude-4-sonnet-thinking"]);
    const modern = await aggregateFor(fixture(), UNINDEXED);
    expect(Object.keys(modern.days[LATER_DAY].models)).toEqual(["gpt-5"]);
  });
});

describe("identity", () => {
  it("reads the project out of the store rather than off a directory name", async () => {
    const aggregate = await aggregateFor(fixture(), LEGACY);
    expect(aggregate.project).toBe("/work/alpha");
  });

  it("leaves a multi-root window's project unset rather than picking a folder", async () => {
    const aggregate = await aggregateFor(fixture(), MULTI_ROOT);
    expect(aggregate.project).toBe("");
  });

  it("takes a subagent's identity from the legacy index when that is where it is", async () => {
    const aggregate = await aggregateFor(fixture(), SUBAGENT);
    expect(aggregate.kind).toBe("subagent");
    expect(aggregate.parentSessionId).toBe(LEGACY);
    expect(aggregate.agentType).toBe("explore");
    expect(aggregate.agentPath).toBe("spawn-1");
  });

  it("names a spawn by joining the parent's call to the conversation it made", async () => {
    // The parent's `task_v2` call does not name the role; the child does, and
    // `subagentInfo.toolCallId` points back at that exact call.
    const aggregate = await aggregateFor(fixture(), LEGACY);
    expect(aggregate.days[DAY].agents).toEqual({ explore: { count: 1, maxDepth: 0 } });
  });
});

describe("tools", () => {
  it("counts a failed tool call as an error", async () => {
    const aggregate = await aggregateFor(fixture(), LEGACY);
    expect(aggregate.days[DAY].errors).toBe(1);
  });

  it("rewrites an MCP call into the form classifyTool understands", async () => {
    const aggregate = await aggregateFor(fixture(), LEGACY);
    const names = Object.keys(aggregate.days[DAY].tools);
    const mcp = names.find((name) => name.startsWith("mcp__"))!;
    expect(mcp).toBe("mcp__atlassian-plugin-atlassian-getJiraIssue");
    // Told apart from a builtin, which is the whole claim `mcp: true` makes.
    // The server half is the flattened name, because Cursor's separator also
    // occurs inside both halves and the boundary is not recoverable.
    expect(classifyTool(mcp).kind).toBe("mcp");
    expect(names).toContain("read_file_v2");
    expect(classifyTool("read_file_v2").kind).toBe("builtin");
  });
});

describe("day attribution", () => {
  it("anchors a turn on the conversation, since turns carry no time of their own", async () => {
    const aggregate = await aggregateFor(fixture(), LEGACY);
    expect(Object.keys(aggregate.days)).toEqual([DAY]);
  });

  it("prefers a turn's own timestamp on the rare records that have one", async () => {
    // `timingInfo` is present on well under a percent of real turns, but where
    // it is there is no reason to use a coarser anchor.
    const aggregate = await aggregateFor(fixture(), UNINDEXED);
    expect(aggregate.days[LATER_DAY].models["gpt-5"].input).toBe(700);
    expect(aggregate.days[DAY].prompts).toBe(1);
  });
});

describe("resilience", () => {
  it("reports an empty transcript rather than throwing on a store that will not open", async () => {
    const root = scratch();
    const file = path.join(root, "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not a database");
    const parsed = await cursorProvider.parse({
      file,
      relative: `composer/${LEGACY}`,
      shard: "composer",
      kind: "main",
      size: 0,
      mtimeMs: 0,
    });
    expect(parsed.aggregate.days).toEqual({});
    expect(parsed.events).toEqual([]);
    expect(parsed.aggregate.malformedLines).toBe(0);
  });

  it("reports an empty transcript for a conversation that vanished after discovery", async () => {
    const root = fixture();
    const parsed = await cursorProvider.parse({
      file: path.join(root, "User", "globalStorage", "state.vscdb"),
      relative: "composer/gone",
      shard: "composer",
      kind: "main",
      size: 0,
      mtimeMs: 0,
    });
    expect(parsed.aggregate.sessionId).toBe("gone");
    expect(parsed.aggregate.days).toEqual({});
  });
});
