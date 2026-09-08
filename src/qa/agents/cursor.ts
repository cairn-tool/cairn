import { flatten } from "../format.js";
import type { Usage } from "../outcome.js";
import type { AgentArgvInput, NormalizedEvents, QaAgentProfile, QaEvent } from "./types.js";
import { isRecord, num, sessionIdOf } from "./types.js";

const TOOL_ARG_FIELDS = [
  "command",
  "path",
  "globPattern",
  "pattern",
  "query",
  "target_notebook",
  "url",
] as const;

/** Return [display name, short args] from a Cursor `tool_call` object. */
export function toolLabel(toolCall: Record<string, unknown>): [string, string] {
  for (const [key, payload] of Object.entries(toolCall)) {
    if (!(key.endsWith("ToolCall") && isRecord(payload))) continue;
    const raw = key.slice(0, -"ToolCall".length);
    const name = raw ? raw[0]!.toUpperCase() + raw.slice(1) : key;
    const args = isRecord(payload["args"]) ? payload["args"] : {};
    let summary = "";
    for (const fieldName of TOOL_ARG_FIELDS) {
      const value = args[fieldName];
      if (value !== undefined && value !== null && value !== "" && value !== 0 && value !== false) {
        summary = flatten(String(value));
        break;
      }
    }
    return [name, summary];
  }
  return ["tool", ""];
}

export function toolFailed(toolCall: Record<string, unknown>): boolean {
  for (const [key, payload] of Object.entries(toolCall)) {
    if (key.endsWith("ToolCall") && isRecord(payload)) {
      const result = payload["result"];
      return isRecord(result) && "error" in result;
    }
  }
  return false;
}

function cursorUsage(raw: unknown): Usage | null {
  if (!isRecord(raw)) return null;
  return {
    inputTokens: num(raw["inputTokens"]),
    outputTokens: num(raw["outputTokens"]),
    cacheReadTokens: num(raw["cacheReadTokens"]),
    cacheWriteTokens: num(raw["cacheWriteTokens"]),
  };
}

export const cursorProfile: QaAgentProfile = {
  name: "cursor",
  binaries: ["cursor-agent", "agent"],
  defaultModel: "cursor-grok-4.6-high",
  buildArgv(input: AgentArgvInput, binary: string): string[] {
    return [
      binary,
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--trust",
      "--workspace",
      input.repo,
      "--model",
      input.model,
      input.prompt,
    ];
  },
  normalize(raw: Record<string, unknown>): NormalizedEvents {
    const kind = raw["type"];
    const subtype = raw["subtype"];
    const sessionId = sessionIdOf(raw);

    if (kind === "thinking") {
      if (subtype === "delta") {
        const text = raw["text"];
        return {
          kind: "thinking",
          phase: "delta",
          text: typeof text === "string" ? text : "",
          sessionId,
        };
      }
      if (subtype === "completed") return { kind: "thinking", phase: "completed", sessionId };
      return null;
    }

    if (kind === "assistant") {
      const message = isRecord(raw["message"]) ? raw["message"] : {};
      const rawContent = message["content"];
      const content: unknown[] =
        typeof rawContent === "string"
          ? [{ type: "text", text: rawContent }]
          : Array.isArray(rawContent)
            ? rawContent
            : [];
      const events: QaEvent[] = [];
      for (const part of content) {
        if (isRecord(part) && part["type"] === "text" && part["text"]) {
          events.push({ kind: "text", text: String(part["text"]), sessionId });
        }
      }
      return events.length === 0 ? null : events;
    }

    if (kind === "tool_call") {
      const tool = isRecord(raw["tool_call"]) ? raw["tool_call"] : {};
      const [name, summary] = toolLabel(tool);
      if (subtype === "started") {
        return { kind: "tool", phase: "started", name, summary, sessionId };
      }
      if (subtype === "completed") {
        return {
          kind: "tool",
          phase: "completed",
          name,
          summary,
          failed: toolFailed(tool),
          sessionId,
        };
      }
      return null;
    }

    if (kind === "result") {
      const usage = cursorUsage(raw["usage"]);
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

    if (kind === "system" && subtype === "init") {
      const model = raw["model"];
      return { kind: "init", model: model ? String(model) : undefined, sessionId };
    }

    return null;
  },
};
