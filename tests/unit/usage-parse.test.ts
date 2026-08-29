import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeProvider } from "../../src/usage/providers/claude-code.js";
import type { TranscriptFile } from "../../src/usage/providers/types.js";
import type { DayBucket, FileAggregate } from "../../src/usage/events.js";
import { bucketTokens, classifyTool } from "../../src/usage/events.js";

/**
 * Every case here pins one property of the source transcript format that the
 * parser has to get right. They are the constraints that made the parser what it
 * is, so a regression in any of them is a wrong number in a report rather than a
 * crash.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const BASE = {
  sessionId: "sess-1",
  cwd: "/tmp/proj",
  gitBranch: "main",
  version: "2.1.220",
};

function usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_tokens: 10,
    output_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    ...overrides,
  };
}

/** Writes the lines as a main transcript and reduces it. */
async function parse(lines: unknown[], name = "sess-1"): Promise<FileAggregate> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-parse-"));
  temporary.push(root);
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
  );
  const stats = fs.statSync(file);
  const transcript: TranscriptFile = {
    file,
    relative: `${name}.jsonl`,
    shard: "proj",
    kind: "main",
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
  return claudeCodeProvider.read(transcript);
}

function onlyBucket(aggregate: FileAggregate): DayBucket {
  const days = Object.values(aggregate.days);
  expect(days).toHaveLength(1);
  return days[0];
}

describe("usage transcript parsing", () => {
  it("counts one API response once, however many lines it was written across", async () => {
    // Claude Code writes one JSONL line per content block, each carrying an
    // identical full copy of the response's usage. Summing lines over-counts
    // output tokens roughly two and a half fold.
    const blocks = [
      { type: "thinking", thinking: "..." },
      { type: "text", text: "hi" },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } },
    ];
    const aggregate = await parse(
      blocks.map((block) => ({
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-5",
          content: [block],
          usage: usage(),
        },
      })),
    );

    const bucket = onlyBucket(aggregate);
    const tokens = bucketTokens(bucket);
    expect(tokens.requests).toBe(1);
    expect(tokens.output).toBe(100);
    expect(tokens.cacheRead).toBe(1000);
    // Tool-use blocks really are one per line, so those are counted per line.
    expect(bucket.tools).toEqual({ Bash: 1, Read: 1 });
  });

  it("keys the session on sessionId, not the stale snake-case session_id", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        session_id: "a-different-and-stale-id",
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { id: "msg_1", model: "claude-opus-5", content: [], usage: usage() },
      },
    ]);
    expect(aggregate.sessionId).toBe("sess-1");
  });

  it("ignores locally generated synthetic records", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        requestId: null,
        message: {
          id: "not-a-msg-id",
          model: "<synthetic>",
          content: [{ type: "text", text: "n/a" }],
          usage: usage({ input_tokens: 0, output_tokens: 0 }),
        },
      },
    ]);
    expect(bucketTokens(onlyBucket(aggregate)).requests).toBe(0);
  });

  it("reads all three usage key-set variants and never sums iterations twice", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: {
          id: "msg_new",
          model: "m",
          content: [],
          // Newest: a TTL split, thinking detail, server tool use, and an
          // iterations array that mirrors the top level rather than adding to it.
          usage: usage({
            output_tokens_details: { thinking_tokens: 25 },
            server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
            iterations: [{ input_tokens: 10, output_tokens: 100, type: "message" }],
          }),
        },
      },
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:01.000Z",
        message: {
          id: "msg_mid",
          model: "m",
          content: [],
          // A cache-write total with no TTL split.
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 40,
          },
        },
      },
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:02.000Z",
        // Oldest: no cache_creation, no server_tool_use, no details.
        message: {
          id: "msg_old",
          model: "m",
          content: [],
          usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 6 },
        },
      },
    ]);

    const tokens = bucketTokens(onlyBucket(aggregate));
    expect(tokens.requests).toBe(3);
    expect(tokens.input).toBe(15);
    expect(tokens.output).toBe(107);
    expect(tokens.thinking).toBe(25);
    expect(tokens.webSearch).toBe(1);
    expect(tokens.webFetch).toBe(2);
    // The authoritative total covers every record; the split covers only the
    // one that carried it, so the two do not agree and must not be conflated.
    expect(tokens.cacheWrite).toBe(340);
    expect(tokens.cacheWrite5m + tokens.cacheWrite1h).toBe(300);
  });

  it("counts a typed prompt but not an injected or meta turn", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "user",
        timestamp: "2026-08-01T10:00:00.000Z",
        promptSource: "typed",
        isMeta: false,
        message: { role: "user", content: "do it" },
      },
      {
        ...BASE,
        type: "user",
        timestamp: "2026-08-01T10:00:01.000Z",
        promptSource: "system",
        isMeta: true,
        message: { role: "user", content: "injected" },
      },
      {
        ...BASE,
        type: "user",
        timestamp: "2026-08-01T10:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
      },
    ]);
    expect(onlyBucket(aggregate).prompts).toBe(1);
  });

  it("extracts slash commands from the message text, there being no field for them", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "user",
        timestamp: "2026-08-01T10:00:00.000Z",
        promptSource: "typed",
        message: {
          role: "user",
          content: "<command-name>/commit</command-name>\n<command-args>-a</command-args>",
        },
      },
    ]);
    expect(onlyBucket(aggregate).commands).toEqual({ "/commit": 1 });
  });

  it("counts hook executions with their exit status and latency", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "attachment",
        timestamp: "2026-08-01T10:00:00.000Z",
        attachment: {
          type: "hook_success",
          hookName: "PostToolUse:Write",
          exitCode: 0,
          durationMs: 10,
        },
      },
      {
        ...BASE,
        type: "attachment",
        timestamp: "2026-08-01T10:00:01.000Z",
        attachment: {
          type: "hook_success",
          hookName: "PostToolUse:Write",
          exitCode: 3,
          durationMs: 90,
        },
      },
      {
        ...BASE,
        type: "attachment",
        timestamp: "2026-08-01T10:00:02.000Z",
        attachment: { type: "hook_cancelled", hookName: "PreToolUse:Bash" },
      },
      // Stop hooks report only here, so counting both surfaces cannot
      // double-count one execution.
      {
        ...BASE,
        type: "system",
        subtype: "stop_hook_summary",
        timestamp: "2026-08-01T10:00:03.000Z",
        hookInfos: [{ command: "./stop.sh", durationMs: 5 }],
        hookErrors: [],
      },
    ]);

    const hooks = onlyBucket(aggregate).hooks;
    expect(hooks["PostToolUse:Write"]).toEqual({
      count: 2,
      failures: 1,
      cancelled: 0,
      totalMs: 100,
      maxMs: 90,
    });
    expect(hooks["PreToolUse:Bash"].cancelled).toBe(1);
    expect(hooks.Stop.count).toBe(1);
  });

  it("counts a skill from every surface that records one", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: {
          id: "msg_1",
          model: "m",
          usage: usage(),
          content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "commit" } }],
        },
      },
      {
        ...BASE,
        type: "attachment",
        timestamp: "2026-08-01T10:00:01.000Z",
        attachment: { type: "invoked_skills", skills: [{ name: "docs-check" }] },
      },
      {
        ...BASE,
        type: "attachment",
        timestamp: "2026-08-01T10:00:02.000Z",
        attachment: { type: "dynamic_skill", skill: { name: "docs-check" } },
      },
    ]);
    expect(onlyBucket(aggregate).skills).toEqual({ commit: 1, "docs-check": 2 });
  });

  it("attributes a subagent spawn to its declared type", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: {
          id: "msg_1",
          model: "m",
          usage: usage(),
          // The spawning tool is `Agent`; `Task` is accepted for older logs.
          content: [
            { type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "Explore" } },
          ],
        },
      },
    ]);
    const bucket = onlyBucket(aggregate);
    expect(bucket.agents).toEqual({ Explore: { count: 1, maxDepth: 0 } });
    expect(bucket.tools).toEqual({ Agent: 1 });
  });

  it("takes the last title record, there being no timestamp to order them by", async () => {
    const aggregate = await parse([
      { type: "ai-title", aiTitle: "first", sessionId: "sess-1" },
      { type: "ai-title", aiTitle: "second", sessionId: "sess-1" },
      { type: "custom-title", customTitle: "chosen", sessionId: "sess-1" },
    ]);
    expect(aggregate.title).toBe("chosen");
  });

  it("counts a malformed line rather than throwing on it", async () => {
    // A truncated final line is routine in a session still being appended to.
    const aggregate = await parse([
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { id: "msg_1", model: "m", content: [], usage: usage() },
      },
      "{ not json at all",
    ]);
    expect(aggregate.malformedLines).toBe(1);
    expect(bucketTokens(onlyBucket(aggregate)).requests).toBe(1);
  });

  it("buckets records by the UTC day they happened on", async () => {
    const aggregate = await parse([
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T23:59:59.000Z",
        message: { id: "msg_1", model: "m", content: [], usage: usage() },
      },
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-02T00:00:01.000Z",
        message: { id: "msg_2", model: "m", content: [], usage: usage() },
      },
    ]);
    expect(Object.keys(aggregate.days).sort()).toEqual(["2026-08-01", "2026-08-02"]);
    expect(aggregate.firstTs).toBe("2026-08-01T23:59:59.000Z");
    expect(aggregate.lastTs).toBe("2026-08-02T00:00:01.000Z");
  });

  it("takes project identity from the recorded cwd", async () => {
    // The log directory name substitutes both separators and underscores, so it
    // is not reliably invertible back to a path.
    const aggregate = await parse([
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { id: "msg_1", model: "m", content: [], usage: usage() },
      },
    ]);
    expect(aggregate.project).toBe("/tmp/proj");
    expect(aggregate.gitBranch).toBe("main");
    expect(aggregate.toolVersion).toBe("2.1.220");
  });
});

describe("classifyTool", () => {
  it("splits an MCP name on the first boundary after the prefix", () => {
    expect(classifyTool("mcp__acme_srv__do_thing")).toEqual({
      kind: "mcp",
      server: "acme_srv",
      tool: "do_thing",
    });
  });

  it("classifies the spawning and skill tools apart from ordinary builtins", () => {
    expect(classifyTool("Agent").kind).toBe("agent");
    expect(classifyTool("Task").kind).toBe("agent");
    expect(classifyTool("Skill").kind).toBe("skill");
    expect(classifyTool("Bash")).toEqual({ kind: "builtin", tool: "Bash" });
  });
});
