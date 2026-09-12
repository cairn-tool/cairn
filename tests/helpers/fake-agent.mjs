#!/usr/bin/env node
// A stand-in for cursor-agent, claude, and codex, driven by a MODE: line in the inlined plan.
// --agent points at this. The backend-specific argv selects the stream dialect.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? "";
const wsIdx = argv.indexOf("--workspace");
const cdIdx = argv.indexOf("-C");
const workspace =
  wsIdx >= 0
    ? (argv[wsIdx + 1] ?? process.cwd())
    : cdIdx >= 0
      ? (argv[cdIdx + 1] ?? process.cwd())
      : process.cwd();
const claude = argv.includes("--dangerously-skip-permissions");
const codex = argv[0] === "exec";

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

const codexUsage = {
  input_tokens: 6834,
  cached_input_tokens: 5600,
  cache_write_input_tokens: 12,
  output_tokens: 340,
  reasoning_output_tokens: 100,
};

const usage = codex ? codexUsage : claude ? claudeUsage : cursorUsage;

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
  if (codex) {
    emit({ type: "thread.started", thread_id: `sess-${name}` });
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: { id: "item-1", type: "reasoning", text: `Working on ${name} in mode ${mode}` },
    });
    emit({
      type: "item.started",
      item: {
        id: "item-2",
        type: "command_execution",
        command: `cat ${planRel}`,
        status: "in_progress",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-2",
        type: "command_execution",
        command: `cat ${planRel}`,
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: { id: "item-3", type: "agent_message", text: `Handling ${name}.` },
    });
    return;
  }
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

function terminal(error) {
  if (codex) {
    return error
      ? { type: "turn.failed", usage, error: { message: error } }
      : { type: "turn.completed", usage };
  }
  return {
    type: "result",
    usage,
    ...(error ? { is_error: true, result: error } : {}),
  };
}

function emitTerminal(error) {
  emit(terminal(error));
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
      emitTerminal("the agent gave up");
      process.exit(3);
      break;

    case "no-folder":
      emitTerminal();
      break;

    case "no-report":
      writeRecords({ report: false });
      emitTerminal();
      break;

    case "no-results":
      writeRecords({ results: false });
      emitTerminal();
      break;

    case "garbage":
      process.stdout.write("this is not json at all\n");
      process.stdout.write('{"type": "broken"\n');
      writeRecords();
      emitTerminal();
      break;

    case "split-utf8": {
      const line = Buffer.from(
        `${JSON.stringify(
          codex
            ? {
                type: "item.completed",
                item: { id: "item-utf8", type: "agent_message", text: "a✅b — é 📋 done" },
              }
            : { type: "assistant", message: { content: "a✅b — é 📋 done" } },
        )}\n`,
      );
      for (let i = 0; i < line.length; i += 1) process.stdout.write(line.subarray(i, i + 1));
      writeRecords();
      emitTerminal();
      break;
    }

    case "fail-verdict":
      writeRecords({ verdict: "FAIL" });
      emitTerminal();
      break;

    case "slow":
      await sleep(400);
      writeRecords();
      emitTerminal();
      break;

    // A final line with no trailing newline. Real agents do this when they exit without
    // flushing a newline, and the harness must still parse that line rather than only
    // logging it — otherwise the run loses its `result` event and reports usage: null.
    case "no-final-newline":
      writeRecords();
      process.stdout.write(JSON.stringify(terminal()));
      break;

    default:
      writeRecords();
      emitTerminal();
      break;
  }
}

await main();
