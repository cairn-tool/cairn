import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexProvider } from "../../src/usage/providers/codex.js";
import type { TranscriptFile } from "../../src/usage/providers/types.js";
import type { FileAggregate } from "../../src/usage/events.js";
import { bucketTokens } from "../../src/usage/events.js";

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Cumulative {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

function total(u: Cumulative): Record<string, number> {
  return {
    input_tokens: u.input,
    cached_input_tokens: u.cached,
    cache_write_input_tokens: 0,
    output_tokens: u.output,
    reasoning_output_tokens: u.reasoning,
    total_tokens: u.input + u.output,
  };
}

function tokenCount(at: string, cumulative: Cumulative | null): string {
  return JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: cumulative ? { total_token_usage: total(cumulative) } : null,
    },
  });
}

function header(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "session_meta",
    payload: {
      session_id: "root-id",
      id: "thread-id",
      cwd: "/tmp/proj",
      cli_version: "0.149.1",
      thread_source: "user",
      source: "cli",
      git: { branch: "main" },
      ...overrides,
    },
  });
}

async function parse(lines: string[]): Promise<FileAggregate> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-unit-"));
  temporary.push(root);
  const file = path.join(root, "rollout-2026-08-01T05-00-00-thread-id.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const stats = fs.statSync(file);
  const transcript: TranscriptFile = {
    file,
    relative: path.basename(file),
    shard: "2026-08-01",
    kind: "main",
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
  return codexProvider.read(transcript);
}

function tokensOf(aggregate: FileAggregate) {
  const day = Object.values(aggregate.days)[0];
  return bucketTokens(day);
}

describe("codex token accounting", () => {
  it("differences the running total rather than summing the per-request field", async () => {
    // `total_token_usage` is cumulative for the thread. Its delta is exact by
    // construction; `last_token_usage` is re-emitted unchanged on duplicates.
    const aggregate = await parse([
      header(),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
      tokenCount("2026-08-01T10:00:02.000Z", {
        input: 1000,
        cached: 800,
        output: 100,
        reasoning: 40,
      }),
      tokenCount("2026-08-01T10:00:03.000Z", {
        input: 1500,
        cached: 1100,
        output: 150,
        reasoning: 60,
      }),
    ]);
    const tokens = tokensOf(aggregate);
    expect(tokens.requests).toBe(2);
    expect(tokens.output).toBe(150);
    // Cumulative input 1500, of which 1100 cached.
    expect(tokens.input).toBe(400);
    expect(tokens.cacheRead).toBe(1100);
    expect(tokens.thinking).toBe(60);
  });

  it("ignores a duplicate re-emission, which carries the same running total", async () => {
    const reading = { input: 1000, cached: 800, output: 100, reasoning: 40 };
    const aggregate = await parse([
      header(),
      tokenCount("2026-08-01T10:00:02.000Z", reading),
      tokenCount("2026-08-01T10:00:03.000Z", reading),
      tokenCount("2026-08-01T10:00:04.000Z", reading),
    ]);
    expect(tokensOf(aggregate).requests).toBe(1);
  });

  it("subtracts the cached part out of input, which Codex reports inside it", async () => {
    // Without this Codex input reads several times higher than Claude Code's for
    // the same work, because theirs excludes cache reads and Codex's does not.
    const aggregate = await parse([
      header(),
      tokenCount("2026-08-01T10:00:02.000Z", {
        input: 5000,
        cached: 4900,
        output: 10,
        reasoning: 0,
      }),
    ]);
    const tokens = tokensOf(aggregate);
    expect(tokens.input).toBe(100);
    expect(tokens.cacheRead).toBe(4900);
  });

  it("tolerates a null info and a lower reading without going negative", async () => {
    const aggregate = await parse([
      header(),
      tokenCount("2026-08-01T10:00:02.000Z", { input: 1000, cached: 0, output: 100, reasoning: 0 }),
      tokenCount("2026-08-01T10:00:03.000Z", null),
      // A resumed or forked thread can replay a lower reading.
      tokenCount("2026-08-01T10:00:04.000Z", { input: 400, cached: 0, output: 40, reasoning: 0 }),
    ]);
    const tokens = tokensOf(aggregate);
    expect(tokens.input).toBeGreaterThanOrEqual(1000);
    expect(tokens.output).toBeGreaterThanOrEqual(100);
  });

  it("attributes a delta to the model in force when it was recorded", async () => {
    const aggregate = await parse([
      header(),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
      tokenCount("2026-08-01T10:00:02.000Z", { input: 100, cached: 0, output: 10, reasoning: 0 }),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:03.000Z",
        type: "event_msg",
        payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-terra" } },
      }),
      tokenCount("2026-08-01T10:00:04.000Z", { input: 300, cached: 0, output: 30, reasoning: 0 }),
    ]);
    const models = Object.values(aggregate.days)[0].models;
    expect(models["gpt-5.6-sol"].output).toBe(10);
    expect(models["gpt-5.6-terra"].output).toBe(20);
  });
});

describe("codex session identity", () => {
  it("keys on the thread's own id, not the root it descends from", async () => {
    // `session_id` and `id` differ on a subagent or forked thread.
    const aggregate = await parse([header()]);
    expect(aggregate.sessionId).toBe("thread-id");
    expect(aggregate.project).toBe("/tmp/proj");
    expect(aggregate.gitBranch).toBe("main");
    expect(aggregate.toolVersion).toBe("0.149.1");
  });

  it("reads a subagent thread, including the legacy string-valued source", async () => {
    const aggregate = await parse([
      header({
        thread_source: "subagent",
        agent_role: "worker",
        agent_path: "/root/explore",
        agent_nickname: "Turing",
        source: {
          subagent: { thread_spawn: { parent_thread_id: "root-id", depth: 2 } },
        },
      }),
    ]);
    expect(aggregate.kind).toBe("subagent");
    expect(aggregate.parentSessionId).toBe("root-id");
    expect(aggregate.agentType).toBe("worker");
    expect(aggregate.agentPath).toBe("/root/explore");
    expect(aggregate.spawnDepth).toBe(2);

    const legacy = await parse([header({ thread_source: "subagent", source: "cli" })]);
    expect(legacy.kind).toBe("subagent");
    expect(legacy.spawnDepth).toBeUndefined();
  });

  it("trusts only the first header, since a resumed thread writes a second", async () => {
    const aggregate = await parse([header(), header({ id: "ancestor-id", cwd: "/tmp/other" })]);
    expect(aggregate.sessionId).toBe("thread-id");
    expect(aggregate.project).toBe("/tmp/proj");
  });
});

describe("codex tools and features", () => {
  it("counts tools from the raw view only, and normalizes MCP names", async () => {
    const aggregate = await parse([
      header(),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:02.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", input: "x" },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:03.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "run", namespace: "web", arguments: "{}" },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:04.000Z",
        type: "event_msg",
        payload: { type: "mcp_tool_call_end", invocation: { server: "node_repl", tool: "js" } },
      }),
      // The UI view of the same activity, which must not be counted again.
      JSON.stringify({
        timestamp: "2026-08-01T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-1" } },
      }),
    ]);
    expect(Object.values(aggregate.days)[0].tools).toEqual({
      exec: 1,
      "web.run": 1,
      mcp__node_repl__js: 1,
    });
  });

  it("names a spawned subagent by the type in the call arguments", async () => {
    const aggregate = await parse([
      header(),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          namespace: "collaboration",
          arguments: JSON.stringify({ agent_type: "explorer" }),
        },
      }),
      // A spawn whose arguments will not parse still happened.
      JSON.stringify({
        timestamp: "2026-08-01T10:00:03.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", arguments: "{not json" },
      }),
    ]);
    const agents = Object.values(aggregate.days)[0].agents;
    expect(agents.explorer.count).toBe(1);
    expect(agents["(unrecorded)"].count).toBe(1);
  });

  it("reads skills and the $name slash-command analogue out of a user item", async () => {
    const aggregate = await parse([
      header(),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            content: [
              {
                type: "text",
                text: "$implement-task",
                text_elements: [{ placeholder: "$implement-task" }],
              },
              { type: "skill", name: "implement-task" },
            ],
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:03.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "hi" },
      }),
    ]);
    const bucket = Object.values(aggregate.days)[0];
    expect(bucket.skills).toEqual({ "implement-task": 1 });
    expect(bucket.commands).toEqual({ "$implement-task": 1 });
    expect(bucket.prompts).toBe(1);
  });

  it("counts a torn line rather than failing the file", async () => {
    const aggregate = await parse([header(), "{ torn"]);
    expect(aggregate.malformedLines).toBe(1);
  });
});
