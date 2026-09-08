#!/usr/bin/env node
// A stand-in for cursor-agent and claude, driven by a MODE: line in the inlined plan.
// --agent points at this. --workspace → Cursor dialect; --dangerously-skip-permissions → Claude.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? "";
const wsIdx = argv.indexOf("--workspace");
const workspace = wsIdx >= 0 ? (argv[wsIdx + 1] ?? process.cwd()) : process.cwd();
const claude = argv.includes("--dangerously-skip-permissions");

const tempRel = /Write every deliverable to (\S+?),/.exec(prompt)?.[1] ?? "";
const planRel = `${tempRel.replace(/-temp\/$/, "")}`.replace(/([^/]+)$/, "_plans/$1.yaml");
const tempDir = join(workspace, tempRel);
const name = /tc-(\d+)-temp/.exec(tempRel)?.[0]?.replace("-temp", "") ?? "tc-?";

const mode = /^MODE:\s*(\S+)/m.exec(prompt)?.[1] ?? "ok";

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const cursorUsage = {
  inputTokens: 1234,
  outputTokens: 340,
  cacheReadTokens: 5600,
  cacheWriteTokens: 12,
};

const claudeUsage = {
  input_tokens: 1234,
  output_tokens: 340,
  cache_read_input_tokens: 5600,
  cache_creation_input_tokens: 12,
};

const usage = claude ? claudeUsage : cursorUsage;

function writeRecords({ report = true, results = true, verdict = "PASS" } = {}) {
  mkdirSync(tempDir, { recursive: true });
  if (report) {
    let body = "";
    for (const s of [1, 2, 3, 4, 5, 6, 7]) body += `## ${s}. Section ${s}\n\n`;
    writeFileSync(join(tempDir, "_report.md"), body);
  }
  if (results) {
    writeFileSync(
      join(tempDir, "_results.md"),
      [
        "## Outcome",
        "",
        `| **Verdict** | ${verdict} |`,
        "| **Expected results** | 1 of 1 confirmed |",
        "| **Failures** | None |",
        "",
        "## 1. Expected versus observed",
        "",
        "| # | Expected | Observed | Verdict |",
        "| 1 | a | a | ✅ |",
        "",
        "## 2. Deviations",
        "## 3. Evidence",
        "## 4. Verdict",
        "",
        `**${verdict}**`,
        "",
        "## 5. Attestations",
        "",
        "- [x] done",
        "",
      ].join("\n"),
    );
  }
  writeFileSync(join(tempDir, "01-artifact.txt"), "evidence\n");
}

function emitPrelude() {
  emit({ type: "system", subtype: "init", model: "fake-model", session_id: `sess-${name}` });
  if (claude) {
    emit({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: `Working on ${name} in mode ${mode}` },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: planRel } },
          { type: "text", text: `Handling ${name}.` },
        ],
      },
    });
    return;
  }
  emit({ type: "thinking", subtype: "delta", text: `Working on ${name} ` });
  emit({ type: "thinking", subtype: "delta", text: "in mode " + mode });
  emit({ type: "thinking", subtype: "completed" });
  emit({
    type: "tool_call",
    subtype: "started",
    tool_call: { readToolCall: { args: { path: planRel } } },
  });
  emit({
    type: "tool_call",
    subtype: "completed",
    tool_call: { readToolCall: { args: { path: planRel }, result: { ok: true } } },
  });
  emit({ type: "assistant", message: { content: [{ type: "text", text: `Handling ${name}.` }] } });
}

async function main() {
  emitPrelude();

  switch (mode) {
    case "hang":
      await sleep(10 * 60 * 1000);
      break;

    case "grandchild": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      writeFileSync(join(workspace, `grandchild-${name}.pid`), String(child.pid));
      await sleep(10 * 60 * 1000);
      break;
    }

    case "exit-nonzero":
      writeRecords();
      emit({ type: "result", usage, is_error: true, result: "the agent gave up" });
      process.exit(3);
      break;

    case "no-folder":
      emit({ type: "result", usage });
      break;

    case "no-report":
      writeRecords({ report: false });
      emit({ type: "result", usage });
      break;

    case "no-results":
      writeRecords({ results: false });
      emit({ type: "result", usage });
      break;

    case "garbage":
      process.stdout.write("this is not json at all\n");
      process.stdout.write('{"type": "broken"\n');
      writeRecords();
      emit({ type: "result", usage });
      break;

    case "split-utf8": {
      const line = Buffer.from(
        `${JSON.stringify({ type: "assistant", message: { content: "a✅b — é 📋 done" } })}\n`,
      );
      for (let i = 0; i < line.length; i += 1) process.stdout.write(line.subarray(i, i + 1));
      writeRecords();
      emit({ type: "result", usage });
      break;
    }

    case "fail-verdict":
      writeRecords({ verdict: "FAIL" });
      emit({ type: "result", usage });
      break;

    case "slow":
      await sleep(400);
      writeRecords();
      emit({ type: "result", usage });
      break;

    // A final line with no trailing newline. Real agents do this when they exit without
    // flushing a newline, and the harness must still parse that line rather than only
    // logging it — otherwise the run loses its `result` event and reports usage: null.
    case "no-final-newline":
      writeRecords();
      process.stdout.write(JSON.stringify({ type: "result", usage }));
      break;

    default:
      writeRecords();
      emit({ type: "result", usage });
      break;
  }
}

await main();
