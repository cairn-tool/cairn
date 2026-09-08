import type { Usage } from "../outcome.js";
import type { AgentArgvInput, NormalizedEvents, QaAgentProfile, QaEvent } from "./types.js";
import { isRecord, num, sessionIdOf } from "./types.js";

const TOOL_ARG_FIELDS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "glob",
  "query",
  "url",
] as const;

/**
 * Claude Code's print+stream-json dialect, captured from claude 2.1.263:
 *
 * - `-p --output-format stream-json` refuses without `--verbose`.
 * - Tools are `tool_use` content blocks inside `assistant` messages, not `tool_call` events.
 * - Thinking is a `thinking` content block on `assistant`, not a `thinking` event.
 * - The terminal `result` event carries one authoritative `usage` total (snake_case).
 *   Assistant lines also carry per-request usage and must not be summed — they fan out
 *   the way the transcript does, and the result is the session figure.
 * - `session_id` appears on every event; `system`/`init` carries `model`.
 */
function claudeUsage(raw: unknown): Usage | null {
  if (!isRecord(raw)) return null;
  return {
    inputTokens: num(raw["input_tokens"]),
    outputTokens: num(raw["output_tokens"]),
    cacheReadTokens: num(raw["cache_read_input_tokens"]),
    cacheWriteTokens: num(raw["cache_creation_input_tokens"]),
  };
}

function toolSummary(input: Record<string, unknown>): string {
  for (const field of TOOL_ARG_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== null && value !== "" && value !== 0 && value !== false) {
      return String(value);
    }
  }
  return "";
}

export const claudeCodeProfile: QaAgentProfile = {
  name: "claude-code",
  binaries: ["claude"],
  defaultModel: "sonnet",
  buildArgv(input: AgentArgvInput, binary: string): string[] {
    return [
      binary,
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--model",
      input.model,
      input.prompt,
    ];
  },
  normalize(raw: Record<string, unknown>): NormalizedEvents {
    const kind = raw["type"];
    const subtype = raw["subtype"];
    const sessionId = sessionIdOf(raw);

    if (kind === "system" && subtype === "init") {
      const model = raw["model"];
      return { kind: "init", model: model ? String(model) : undefined, sessionId };
    }

    if (kind === "assistant") {
      const message = isRecord(raw["message"]) ? raw["message"] : {};
      const rawContent = message["content"];
      const content: unknown[] = Array.isArray(rawContent)
        ? rawContent
        : typeof rawContent === "string"
          ? [{ type: "text", text: rawContent }]
          : [];
      const events: QaEvent[] = [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        const partType = part["type"];
        if (partType === "text" && part["text"]) {
          events.push({ kind: "text", text: String(part["text"]), sessionId });
        } else if (partType === "thinking" && part["thinking"]) {
          events.push({
            kind: "thinking",
            phase: "completed",
            text: String(part["thinking"]),
            sessionId,
          });
        } else if (partType === "tool_use") {
          const name = typeof part["name"] === "string" ? part["name"] : "tool";
          const input = isRecord(part["input"]) ? part["input"] : {};
          events.push({
            kind: "tool",
            phase: "started",
            name,
            summary: toolSummary(input),
            sessionId,
          });
        }
      }
      return events.length === 0 ? null : events;
    }

    if (kind === "result") {
      const usage = claudeUsage(raw["usage"]);
      const error = raw["is_error"]
        ? String(raw["result"] ? raw["result"] : "agent reported an error")
        : undefined;
      if (!usage && !error) return null;
      return {
        kind: "usage",
        usage: usage ?? {},
        ...(error ? { error } : {}),
        sessionId,
      };
    }

    return null;
  },
};
