import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeProfile } from "../../../src/qa/agents/claude-code.js";
import { codexProfile } from "../../../src/qa/agents/codex.js";
import { cursorProfile } from "../../../src/qa/agents/cursor.js";
import { asEventList, type QaAgentProfile, type QaEvent } from "../../../src/qa/agents/types.js";
import { AGENTS, agentCaps, displayBinary } from "../../../src/qa/agents/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/qa");

function replay(profile: QaAgentProfile, file: string): QaEvent[] {
  const events: QaEvent[] = [];
  const body = readFileSync(join(fixtures, file), "utf8");
  for (const line of body.split("\n").filter(Boolean)) {
    events.push(...asEventList(profile.normalize(JSON.parse(line) as Record<string, unknown>)));
  }
  return events;
}

function toolsAndTokens(events: QaEvent[]): { tools: number; tokens: number } {
  let tools = 0;
  let tokens = 0;
  for (const event of events) {
    if (event.kind === "tool" && event.phase === "started") tools += 1;
    if (event.kind === "usage") {
      tokens +=
        (event.usage.inputTokens ?? 0) +
        (event.usage.outputTokens ?? 0) +
        (event.usage.cacheReadTokens ?? 0) +
        (event.usage.cacheWriteTokens ?? 0);
    }
  }
  return { tools, tokens };
}

describe("qa agent profiles", () => {
  it("replays a Cursor stream with nonzero tools and tokens", () => {
    const events = replay(cursorProfile, "cursor.stream.jsonl");
    const { tools, tokens } = toolsAndTokens(events);
    expect(tools).toBeGreaterThan(0);
    expect(tokens).toBeGreaterThan(0);
  });

  it("replays a Claude Code stream with nonzero tools and tokens", () => {
    const events = replay(claudeCodeProfile, "claude-code.stream.jsonl");
    const { tools, tokens } = toolsAndTokens(events);
    expect(tools).toBeGreaterThan(0);
    expect(tokens).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "tool" && event.name === "Read")).toBe(true);
  });

  it("does not treat assistant-line usage as a session total", () => {
    const events = replay(claudeCodeProfile, "claude-code.stream.jsonl");
    const usages = events.filter((event) => event.kind === "usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]?.kind === "usage" && usages[0].usage.outputTokens).toBeGreaterThan(0);
  });

  it("replays a Codex stream without double-counting cached input", () => {
    const events = replay(codexProfile, "codex.stream.jsonl");
    const { tools, tokens } = toolsAndTokens(events);
    expect(tools).toBe(4);
    expect(tokens).toBe(7186);
    expect(events.filter((event) => event.kind === "usage")).toEqual([
      {
        kind: "usage",
        usage: {
          inputTokens: 1234,
          outputTokens: 340,
          cacheReadTokens: 5600,
          cacheWriteTokens: 12,
        },
      },
    ]);
    expect(events.find((event) => event.kind === "init")?.sessionId).toBe(
      "019d0e36-0b5f-7d31-b982-4f8c21074372",
    );
    expect(
      events.some((event) => event.kind === "tool" && event.name === "cairn.read_document"),
    ).toBe(true);
  });

  it("keeps Codex terminal errors separate from absent usage", () => {
    expect(
      asEventList(codexProfile.normalize({ type: "error", message: "stream failed" })),
    ).toEqual([{ kind: "error", error: "stream failed" }]);
    expect(
      asEventList(
        codexProfile.normalize({
          type: "turn.failed",
          error: { message: "turn failed" },
        }),
      ),
    ).toEqual([{ kind: "error", error: "turn failed" }]);
  });
});

describe("qa agent registry", () => {
  it("registers Codex last without changing the default backend", () => {
    expect(AGENTS.map((profile) => profile.name)).toEqual(["cursor", "claude-code", "codex"]);
    expect(codexProfile.defaultModel).toBe("gpt-5.6-luna");
  });

  it("lets --parallel above a profile default decide on its own", () => {
    // Profiles once carried maxParallel: DEFAULT_PARALLEL — the *default value* of the
    // flag, not a real backend limit — so `--parallel 20` silently ran 8.
    for (const parallel of [4, 8, 20, 32]) {
      for (const cap of agentCaps(parallel).values()) {
        expect(cap).toBe(parallel);
      }
    }
  });

  it("declares no cap that is merely the default of --parallel", () => {
    // A profile may carry a real vendor limit; it may not carry 8 by coincidence.
    for (const profile of AGENTS) {
      if (profile.maxParallel !== undefined) {
        expect(profile.maxParallel, profile.name).toBeGreaterThanOrEqual(1);
        expect(profile.maxParallel, profile.name).not.toBe(8);
      }
    }
  });

  it("names a backend for --dry-run even when it is not installed", () => {
    // Previewing a queue launches nothing, so it must not require the backends present —
    // and the e2e suite must not depend on any real agent being present on the CI runner.
    for (const profile of AGENTS) {
      expect(displayBinary(profile.name, null)).toBeTruthy();
    }
  });
});
