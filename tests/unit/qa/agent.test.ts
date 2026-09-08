import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "vitest";
import { effectiveExitCode, runAgent } from "../../../src/qa/agent.js";
import { FAKE_AGENT } from "./helpers.js";

interface Captured {
  events: Record<string, unknown>[];
  raw: string[];
  bytes: number;
  logDir: string;
  cwd: string;
}

async function run(
  mode: string,
  { timeoutMs = 30_000, agent = FAKE_AGENT } = {},
): Promise<{ result: Awaited<ReturnType<typeof runAgent>>; cap: Captured }> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tca-")));
  const logDir = join(cwd, "logs");
  const cap: Captured = { events: [], raw: [], bytes: 0, logDir, cwd };

  // The plan travels inside the prompt, so the fake agent reads MODE straight out of it.
  const prompt =
    "Perform the test-case plan below. Write every deliverable to runs/tc-1-temp/, " +
    "creating that folder yourself. Do not write to runs/tc-1/ — the harness " +
    `renames the temp folder there only after this run succeeds.\n\n---\n\n# plan\n\nMODE: ${mode}\n`;

  const result = await runAgent({
    argv: [agent, "-p", "--output-format", "stream-json", "--workspace", cwd, prompt],
    cwd,
    logDir,
    timeoutMs,
    onBytes: (n) => {
      cap.bytes += n;
    },
    onEvent: (e) => cap.events.push(e),
    onRawLine: (l) => cap.raw.push(l),
    onSpawn: () => {},
  });
  return { result, cap };
}

it("a clean run yields parsed events, exit 0, and the log files", async () => {
  const { result, cap } = await run("ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.ok(cap.events.length >= 5, "events were parsed");
  assert.equal(cap.events[0]?.["type"], "system");
  assert.ok(cap.bytes > 0, "byte counter advanced");

  const command = readFileSync(join(cap.logDir, "command.txt"), "utf8");
  assert.ok(command.endsWith("\n"));
  assert.ok(command.includes("'Perform the test-case plan below."), "prompt is shell-quoted");

  const stream = readFileSync(join(cap.logDir, "stream.jsonl"), "utf8");
  for (const line of stream.split("\n").filter(Boolean)) JSON.parse(line);
});

it("a non-zero exit is reported as-is", async () => {
  const { result } = await run("exit-nonzero");
  assert.equal(result.exitCode, 3);
});

it("a hung agent is killed at the deadline and reported as timed out", async () => {
  const { result } = await run("hang", { timeoutMs: 1500 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.exitCode, -9, "normalised to the Python convention");
});

it("a non-JSON line is routed to onRawLine, not onEvent", async () => {
  const { cap } = await run("garbage");
  assert.ok(cap.raw.some((l) => l.includes("not json at all")));
  assert.ok(cap.raw.some((l) => l.includes('"type": "broken"')));
  assert.ok(cap.events.every((e) => e["type"] !== "broken"));
});

it("a multi-byte character split across chunk boundaries decodes intact", async () => {
  const { cap } = await run("split-utf8");
  // The fake agent writes this line one byte at a time; per-chunk decoding would mangle it.
  const text = cap.events
    .filter((e) => e["type"] === "assistant")
    .map((e) => (e["message"] as { content: unknown }).content)
    .find((c) => typeof c === "string");
  assert.equal(text, "a✅b — é 📋 done");
});

it("byte counting matches the real stdout size", async () => {
  const { cap } = await run("ok");
  const stream = readFileSync(join(cap.logDir, "stream.jsonl"));
  // stream.jsonl holds every non-blank line, so it is a lower bound on what was read.
  assert.ok(cap.bytes >= stream.length, `${cap.bytes} >= ${stream.length}`);
});

it("a missing agent binary rejects rather than becoming an unhandled rejection", async () => {
  await assert.rejects(
    () => run("ok", { agent: "/definitely/not/here/agent-xyz" }),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
  );
});

it("effectiveExitCode maps signals to Python-style negatives", () => {
  assert.equal(effectiveExitCode(0, null), 0);
  assert.equal(effectiveExitCode(3, null), 3);
  assert.equal(effectiveExitCode(null, "SIGKILL"), -9);
  assert.equal(effectiveExitCode(null, "SIGINT"), -2);
  assert.equal(effectiveExitCode(null, null), null);
});

it("parses a final line that has no trailing newline", async () => {
  // The tail used to be written to stream.jsonl but never dispatched, so an agent whose
  // last line lacked a newline silently lost its `result` event: the case recorded
  // usage: null while the log on disk showed the tokens plainly.
  const { result, cap } = await run("no-final-newline");
  assert.equal(result.exitCode, 0);
  const results = cap.events.filter((event) => event["type"] === "result");
  assert.equal(results.length, 1, "the unterminated result line must reach onEvent");
  assert.ok(results[0]?.["usage"], "usage must survive the tail path");
  const logged = readFileSync(join(cap.logDir, "stream.jsonl"), "utf8");
  assert.match(logged, /"type":"result"/);
});
