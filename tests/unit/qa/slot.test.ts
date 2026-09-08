import assert from "node:assert/strict";
import { it } from "vitest";
import { toolFailed, toolLabel } from "../../../src/qa/agents/cursor.js";
import { TRANSCRIPT_CAP } from "../../../src/qa/config.js";
import { Slot } from "../../../src/qa/slot.js";
import type { QaEvent } from "../../../src/qa/agents/types.js";

const fresh = (): Slot => {
  const s = new Slot(0);
  s.reset(null);
  return s;
};

it("thinking deltas accumulate and flush on completed", () => {
  const s = fresh();
  s.applyEvent({ kind: "thinking", phase: "delta", text: "one  " });
  s.applyEvent({ kind: "thinking", phase: "delta", text: "two\nthree" });
  assert.deepEqual(s.transcript, [], "nothing emitted until completed");
  s.applyEvent({ kind: "thinking", phase: "completed" });
  assert.equal(s.transcript.length, 1);
  assert.match(s.transcript[0]!, /one two three$/, "flattened");
  assert.equal(s.thinking, "", "buffer cleared");
});

it("a blank thinking buffer emits nothing", () => {
  const s = fresh();
  s.applyEvent({ kind: "thinking", phase: "delta", text: "  \n " });
  s.applyEvent({ kind: "thinking", phase: "completed" });
  assert.deepEqual(s.transcript, []);
});

it("text events flatten and prefix", () => {
  const s = fresh();
  s.applyEvent({ kind: "text", text: "a  bare\nstring" });
  s.applyEvent({ kind: "text", text: "part one" });
  s.applyEvent({ kind: "text", text: "part  two" });
  assert.deepEqual(s.transcript, ["» a bare string", "» part one", "» part two"]);
});

it("tool calls count, label, and report failures", () => {
  const s = fresh();
  s.applyEvent({ kind: "tool", phase: "started", name: "Read", summary: "src/a.ts" });
  assert.equal(s.tools, 1);
  assert.match(s.currentTool, /^Read {2}src\/a\.ts$/);
  s.applyEvent({
    kind: "tool",
    phase: "completed",
    name: "Read",
    summary: "src/a.ts",
    failed: true,
  });
  assert.equal(s.currentTool, "", "cleared on completion");
  assert.equal(s.tools, 1, "completion does not re-count");
  assert.ok(
    s.transcript.some((l) => l.includes("x ")),
    "failure marked",
  );
});

it("toolLabel honours the exact arg-field precedence", () => {
  assert.deepEqual(toolLabel({ shellToolCall: { args: { command: "ls -la", path: "p" } } }), [
    "Shell",
    "ls -la",
  ]);
  assert.deepEqual(toolLabel({ grepToolCall: { args: { pattern: "x", query: "y" } } }), [
    "Grep",
    "x",
  ]);
  assert.deepEqual(toolLabel({ fetchToolCall: { args: { url: "https://x" } } }), [
    "Fetch",
    "https://x",
  ]);
  assert.deepEqual(toolLabel({ xToolCall: { args: { path: "" } } }), ["X", ""], "falsy is skipped");
  assert.deepEqual(toolLabel({ xToolCall: { args: "not-a-dict" } }), ["X", ""]);
  assert.deepEqual(toolLabel({ notatool: { args: { path: "p" } } }), ["tool", ""]);
  assert.deepEqual(toolLabel({}), ["tool", ""]);
});

it("toolFailed only fires on a dict result carrying an error key", () => {
  assert.equal(toolFailed({ aToolCall: { result: { error: "x" } } }), true);
  assert.equal(toolFailed({ aToolCall: { result: { ok: 1 } } }), false);
  assert.equal(toolFailed({ aToolCall: { result: "not-a-dict" } }), false);
  assert.equal(toolFailed({ aToolCall: {} }), false);
});

it("usage events set counters and truncate an error note at 160 chars", () => {
  const s = fresh();
  s.applyEvent({ kind: "usage", usage: { inputTokens: 5 } });
  assert.deepEqual(s.usage, { inputTokens: 5 });
  s.applyEvent({ kind: "usage", usage: { outputTokens: 2 }, error: "x".repeat(300) });
  assert.equal(s.note.length, 160);
});

it("session_id is captured once, first write wins", () => {
  const s = fresh();
  s.applyEvent({ kind: "init", sessionId: "first" });
  s.applyEvent({ kind: "usage", usage: {}, sessionId: "second" });
  assert.equal(s.sessionId, "first");
});

it("system/init announces the model only when there is one", () => {
  const s = fresh();
  s.applyEvent({ kind: "init", model: "m-1" });
  s.applyEvent({ kind: "init", model: "" });
  assert.equal(s.transcript.length, 1);
  assert.match(s.transcript[0]!, /model m-1/);
});

it("the transcript is a ring buffer capped at TRANSCRIPT_CAP", () => {
  const s = fresh();
  for (let i = 0; i < TRANSCRIPT_CAP + 250; i += 1) s.add(`line ${i}`);
  assert.equal(s.transcript.length, TRANSCRIPT_CAP);
  assert.equal(s.transcript[0], `line ${250}`, "oldest entries dropped");
});

it("add ignores empty lines but keeps whitespace-only ones", () => {
  const s = fresh();
  s.add("");
  s.add("\n");
  assert.deepEqual(s.transcript, []);
  s.add("   ");
  assert.deepEqual(s.transcript, ["   "], "Python only skips the empty string");
});

it("elapsedSeconds uses ended when set, otherwise now", () => {
  const s = new Slot(0);
  assert.equal(s.elapsedSeconds(1000), 0, "never started");
  s.startedMs = 1000;
  assert.equal(s.elapsedSeconds(3000), 2);
  s.endedMs = 2000;
  assert.equal(s.elapsedSeconds(9999), 1, "frozen once ended");
});

it("QaEvent kinds Slot does not handle leave the transcript untouched", () => {
  const s = fresh();
  const ignored: QaEvent = { kind: "init" };
  s.applyEvent(ignored);
  assert.deepEqual(s.transcript, []);
});
