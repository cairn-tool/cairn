import { flatten } from "../format.js";
import type { Usage } from "../outcome.js";
import type { AgentArgvInput, NormalizedEvents, QaAgentProfile, QaEvent } from "./types.js";
import { isRecord, num } from "./types.js";

const shown = (value: string): string => flatten(value).slice(0, 200);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function codexUsage(raw: unknown): Usage | null {
  if (!isRecord(raw)) return null;
  const input = num(raw["input_tokens"]);
  const cached = num(raw["cached_input_tokens"]);
  const cacheWrite = num(raw["cache_write_input_tokens"]);
  const output = num(raw["output_tokens"]);
  if (
    input === undefined &&
    cached === undefined &&
    cacheWrite === undefined &&
    output === undefined
  ) {
    return null;
  }

  // Codex includes cached_input_tokens inside input_tokens. The other QA backends report
  // uncached input and cache reads separately, so subtract once at this boundary rather than
  // inflating both the input column and the session total.
  return {
    inputTokens: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
  };
}

function fileChangeSummary(item: Record<string, unknown>): string {
  const paths: string[] = [];
  const changes = item["changes"];
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!isRecord(change)) continue;
      for (const field of ["path", "move_path"] as const) {
        const path = optionalString(change[field]);
        if (path && !paths.includes(path)) paths.push(path);
      }
    }
  }
  const direct = optionalString(item["path"]);
  if (direct && !paths.includes(direct)) paths.push(direct);
  if (paths.length === 0) return "";
  const suffix = paths.length > 2 ? ` (+${paths.length - 2} more)` : "";
  return shown(`${paths.slice(0, 2).join(", ")}${suffix}`);
}

function mcpSummary(item: Record<string, unknown>): string {
  const args = item["arguments"] ?? item["args"];
  if (typeof args === "string") return shown(args);
  if (isRecord(args) || Array.isArray(args)) return shown(JSON.stringify(args));
  return "";
}

function webSearchSummary(item: Record<string, unknown>): string {
  const query = optionalString(item["query"]);
  if (query) return shown(query);
  const queries = item["queries"];
  if (Array.isArray(queries)) {
    const strings = queries.filter((value): value is string => typeof value === "string");
    if (strings.length > 0) return shown(strings.join(", "));
  }
  const action = isRecord(item["action"]) ? item["action"] : null;
  if (!action) return "";
  for (const field of ["query", "url", "pattern"] as const) {
    const value = optionalString(action[field]);
    if (value) return shown(value);
  }
  return "";
}

function toolLabel(item: Record<string, unknown>): [string, string] | null {
  switch (item["type"]) {
    case "command_execution":
      return ["Shell", shown(optionalString(item["command"]) ?? "")];
    case "file_change":
      return ["Patch", fileChangeSummary(item)];
    case "mcp_tool_call": {
      const server = optionalString(item["server"]);
      const tool = optionalString(item["tool"]);
      const name = server && tool ? `${server}.${tool}` : (tool ?? server ?? "MCP");
      return [name, mcpSummary(item)];
    }
    case "web_search":
      return ["WebSearch", webSearchSummary(item)];
    default:
      return null;
  }
}

function toolFailed(item: Record<string, unknown>): boolean {
  const exitCode = num(item["exit_code"]);
  return (
    item["status"] === "failed" ||
    (exitCode !== undefined && exitCode !== 0) ||
    ("error" in item && item["error"] !== undefined && item["error"] !== null)
  );
}

function errorMessage(raw: Record<string, unknown>): string | null {
  const direct = optionalString(raw["message"]);
  if (direct) return direct;
  const error = raw["error"];
  if (typeof error === "string" && error) return error;
  if (isRecord(error)) {
    const message = optionalString(error["message"]);
    if (message) return message;
  }
  return null;
}

/**
 * Codex's `exec --json` JSONL dialect.
 *
 * `turn.completed` is the one authoritative usage total. Item events provide the transcript
 * and tool count; `thread.started` is the only event guaranteed to carry the thread id.
 */
export const codexProfile: QaAgentProfile = {
  name: "codex",
  binaries: ["codex"],
  defaultModel: "gpt-5.6-luna",
  buildArgv(input: AgentArgvInput, binary: string): string[] {
    return [
      binary,
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      input.repo,
      "--model",
      input.model,
      input.prompt,
    ];
  },
  normalize(raw: Record<string, unknown>): NormalizedEvents {
    const kind = raw["type"];

    if (kind === "thread.started") {
      return { kind: "init", sessionId: optionalString(raw["thread_id"]) };
    }

    if (kind === "item.started" || kind === "item.completed") {
      const item = isRecord(raw["item"]) ? raw["item"] : {};
      const itemType = item["type"];

      if (kind === "item.completed" && itemType === "agent_message") {
        const text = optionalString(item["text"]);
        return text ? { kind: "text", text } : null;
      }
      if (kind === "item.completed" && itemType === "reasoning") {
        const text = optionalString(item["text"]);
        return text ? { kind: "thinking", phase: "completed", text } : null;
      }

      const tool = toolLabel(item);
      if (!tool) return null;
      const [name, summary] = tool;
      if (kind === "item.started") return { kind: "tool", phase: "started", name, summary };
      return {
        kind: "tool",
        phase: "completed",
        name,
        summary,
        failed: toolFailed(item),
      };
    }

    if (kind === "turn.completed") {
      const usage = codexUsage(raw["usage"]);
      return usage ? { kind: "usage", usage } : null;
    }

    if (kind === "turn.failed") {
      const events: QaEvent[] = [];
      const usage = codexUsage(raw["usage"]);
      if (usage) events.push({ kind: "usage", usage });
      const error = errorMessage(raw);
      if (error) events.push({ kind: "error", error });
      return events.length === 0 ? null : events;
    }

    if (kind === "error") {
      const error = errorMessage(raw);
      return error ? { kind: "error", error } : null;
    }

    return null;
  },
};
