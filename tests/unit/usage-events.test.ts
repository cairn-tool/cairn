import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeProvider } from "../../src/usage/providers/claude-code.js";
import { codexProvider } from "../../src/usage/providers/codex.js";
import { antigravityProvider } from "../../src/usage/providers/antigravity.js";
import { geminiCliProvider } from "../../src/usage/providers/gemini-cli.js";
import type { TranscriptFile, UsageProvider } from "../../src/usage/providers/types.js";
import { foldDays } from "../../src/usage/events.js";
import { ANTIGRAVITY_FIXTURE, buildAntigravityLogs } from "../helpers/antigravity-fixture.js";
import { GEMINI_FIXTURE, buildGeminiLogs } from "../helpers/gemini-cli-fixture.js";

/**
 * The contract that makes the event stream trustworthy.
 *
 * A provider emits events *alongside* the day buckets it already builds, so no
 * published number depends on the stream being complete — but the usage store
 * writes both, and a consumer querying `event` would silently get less than the
 * rollups report if a provider ever forgot to emit at one of its counter sites.
 *
 * Folding the stream back and comparing it to what the provider built is what
 * catches that. Every counter a provider increments must appear here, so adding
 * a new one to a provider without emitting its event fails this suite rather
 * than shipping a quietly incomplete table.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  return root;
}

/** Reduces one transcript both ways and asserts the fold reproduces the buckets. */
async function expectFoldMatches(provider: UsageProvider, file: TranscriptFile): Promise<void> {
  const parsed = await provider.parse(file);
  const folded = foldDays(parsed.events, Object.keys(parsed.aggregate.days));
  expect(folded).toEqual(parsed.aggregate.days);
}

function transcript(file: string, overrides: Partial<TranscriptFile> = {}): TranscriptFile {
  const stats = fs.statSync(file);
  return {
    file,
    relative: path.basename(file),
    shard: "shard",
    kind: "main",
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ...overrides,
  };
}

function writeLines(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
  );
}

describe("the event stream folds back into the day buckets", () => {
  it("reproduces every counter Claude Code writes", async () => {
    const root = scratch("usage-events-cc-");
    const file = path.join(root, "sess-1.jsonl");
    const ts = "2026-08-20T10:00:00.000Z";
    const next = "2026-08-21T10:00:00.000Z";
    writeLines(file, [
      // A response fanned across two lines carrying identical usage.
      {
        type: "assistant",
        timestamp: ts,
        sessionId: "sess-1",
        cwd: "/tmp/p",
        message: {
          id: "msg-1",
          model: "claude-opus-5",
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 300,
            cache_creation: {
              ephemeral_5m_input_tokens: 100,
              ephemeral_1h_input_tokens: 200,
            },
            output_tokens_details: { thinking_tokens: 40 },
            server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
          },
          content: [
            { type: "tool_use", name: "Read" },
            { type: "tool_use", name: "Agent", input: { subagent_type: "Explore" } },
            { type: "tool_use", name: "Skill", input: { skill: "markdown:analyze" } },
            { type: "tool_use", name: "mcp__github__list_prs" },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: ts,
        message: { id: "msg-1", model: "claude-opus-5", usage: { input_tokens: 10 } },
      },
      {
        type: "user",
        timestamp: ts,
        promptSource: "typed",
        message: { content: "hello <command-name>/commit</command-name>" },
      },
      {
        type: "attachment",
        timestamp: ts,
        attachment: { type: "hook_success", hookName: "PreToolUse", exitCode: 0, durationMs: 12 },
      },
      {
        type: "attachment",
        timestamp: ts,
        attachment: { type: "hook_success", hookName: "PreToolUse", exitCode: 3, durationMs: 30 },
      },
      {
        type: "attachment",
        timestamp: ts,
        attachment: { type: "hook_cancelled", hookName: "PostToolUse" },
      },
      {
        type: "attachment",
        timestamp: ts,
        attachment: { type: "invoked_skills", skills: [{ name: "git:commit-message" }] },
      },
      {
        type: "attachment",
        timestamp: ts,
        attachment: { type: "dynamic_skill", skill: { name: "dataviz" } },
      },
      { type: "system", timestamp: ts, subtype: "api_error" },
      { type: "system", timestamp: ts, subtype: "compact_boundary" },
      // Executions and failures deliberately diverge: two ran, three failed.
      {
        type: "system",
        timestamp: next,
        subtype: "stop_hook_summary",
        hookInfos: [{ durationMs: 5 }, { durationMs: 9 }],
        hookErrors: ["a", "b", "c"],
      },
    ]);
    await expectFoldMatches(claudeCodeProvider, transcript(file));
  });

  it("keeps a day a session touched but spent nothing on", async () => {
    // `bucketFor` opens a bucket for every timestamped record, including ones
    // that increment nothing. Deriving days from events alone would drop them,
    // and `usage tokens --by day` really does report such a row.
    const root = scratch("usage-events-empty-");
    const file = path.join(root, "sess-2.jsonl");
    writeLines(file, [
      { type: "user", timestamp: "2026-08-20T10:00:00.000Z", message: { content: "no counters" } },
    ]);
    const parsed = await claudeCodeProvider.parse(transcript(file));
    expect(Object.keys(parsed.aggregate.days)).toEqual(["2026-08-20"]);
    expect(parsed.events).toEqual([]);
    expect(foldDays(parsed.events, Object.keys(parsed.aggregate.days))).toEqual(
      parsed.aggregate.days,
    );
  });

  it("reproduces every counter Codex writes", async () => {
    const root = scratch("usage-events-codex-");
    const file = path.join(root, "rollout-2026-08-20T10-00-00-sess.jsonl");
    const ts = "2026-08-20T10:00:00.000Z";
    writeLines(file, [
      {
        timestamp: ts,
        type: "session_meta",
        payload: { id: "thread-1", session_id: "thread-1", cwd: "/tmp/p", cli_version: "0.1.0" },
      },
      { timestamp: ts, type: "turn_context", payload: { model: "gpt-5-codex" } },
      {
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 400,
              output_tokens: 50,
              reasoning_output_tokens: 10,
            },
          },
        },
      },
      // A duplicate re-emission: same cumulative figure, so a zero delta.
      {
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 400,
              output_tokens: 50,
              reasoning_output_tokens: 10,
            },
          },
        },
      },
      {
        timestamp: ts,
        type: "response_item",
        payload: { type: "custom_tool_call", name: "shell" },
      },
      {
        timestamp: ts,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ agent_type: "reviewer" }),
        },
      },
      {
        timestamp: ts,
        type: "event_msg",
        payload: { type: "mcp_tool_call_end", invocation: { server: "gh", tool: "prs" } },
      },
      { timestamp: ts, type: "event_msg", payload: { type: "web_search_end" } },
      { timestamp: ts, type: "event_msg", payload: { type: "user_message" } },
      { timestamp: ts, type: "event_msg", payload: { type: "context_compacted" } },
      {
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            content: [
              { type: "skill", name: "review" },
              { type: "text", text_elements: [{ placeholder: "$plan" }] },
            ],
          },
        },
      },
    ]);
    await expectFoldMatches(codexProvider, transcript(file));
  });

  describe("antigravity", () => {
    let root = "";
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-events-anti-"));
      buildAntigravityLogs(root, ANTIGRAVITY_FIXTURE);
    });
    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("reproduces every counter it writes, across all three of its stores", async () => {
      const found = antigravityProvider.discover(root, { subagents: true });
      expect(found.length).toBeGreaterThan(0);
      for (const file of found) await expectFoldMatches(antigravityProvider, file);
    });
  });

  describe("gemini-cli", () => {
    let root = "";
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-events-gemini-"));
      buildGeminiLogs(root, GEMINI_FIXTURE);
    });
    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("reproduces every counter it writes, including the deferred tool flush", async () => {
      // Two things in this provider make the fold worth pinning. Tool calls are
      // buffered and replayed at end of file, so an event stamped with the
      // flush time rather than the record's would land on the wrong day; and
      // slash commands arrive from `logs.json` on days the transcript never
      // touched, so their bucket has to be opened on the aggregate side too.
      const found = geminiCliProvider.discover(root, { subagents: true });
      expect(found.length).toBeGreaterThan(0);
      for (const file of found) await expectFoldMatches(geminiCliProvider, file);
    });
  });
});
