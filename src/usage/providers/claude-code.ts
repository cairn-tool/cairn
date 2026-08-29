import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { DayBucket, FileAggregate, TokenTotals } from "../events.js";
import { addTokens, emptyBucket, emptyTokens, utcDay } from "../events.js";
import type {
  DiscoverOptions,
  ProviderEnvironment,
  TranscriptFile,
  UsageProvider,
} from "./types.js";

/**
 * Claude Code transcripts.
 *
 * Layout, all under the log root:
 *
 * ```
 * projects/<slug>/<session-uuid>.jsonl                       main transcript
 * projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl  subagent transcript
 * projects/<slug>/<session-uuid>/subagents/agent-<id>.meta.json
 * ```
 *
 * The slug is the session's working directory with separators replaced, and the
 * replacement is lossy in both directions, so project identity is read from the
 * `cwd` field inside the records instead of from the directory name.
 */

const PROJECTS = "projects";
const SUBAGENTS = "subagents";

/** Locally generated records: null `requestId`, non-`msg_` id, all-zero counters. */
const SYNTHETIC_MODEL = "<synthetic>";

/** Slash commands are not a field; they are a block inside the user's message text. */
const SLASH_COMMAND = /<command-name>([^<]+)<\/command-name>/g;

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  output_tokens_details?: { thinking_tokens?: number };
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
}

interface RawBlock {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface RawRecord {
  type?: string;
  subtype?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isMeta?: boolean;
  promptSource?: string;
  aiTitle?: string;
  customTitle?: string;
  message?: {
    id?: string;
    model?: string;
    content?: RawBlock[] | string;
    usage?: RawUsage;
  };
  attachment?: {
    type?: string;
    hookName?: string;
    hookEvent?: string;
    exitCode?: number;
    durationMs?: number;
    skills?: Array<{ name?: string; path?: string }>;
    skill?: { name?: string };
  };
  hookInfos?: Array<{ command?: string; durationMs?: number }>;
  hookErrors?: unknown[];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Reads one API response's counters.
 *
 * `usage.iterations[]` mirrors these fields rather than adding to them, so it is
 * deliberately not read: summing it on top would double every request that has
 * it while leaving older records alone.
 */
function readUsage(usage: RawUsage): TokenTotals {
  const creation = usage.cache_creation ?? {};
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite5m: count(creation.ephemeral_5m_input_tokens),
    cacheWrite1h: count(creation.ephemeral_1h_input_tokens),
    thinking: count(usage.output_tokens_details?.thinking_tokens),
    webSearch: count(usage.server_tool_use?.web_search_requests),
    webFetch: count(usage.server_tool_use?.web_fetch_requests),
    requests: 1,
  };
}

function hookTotals(bucket: DayBucket, name: string) {
  return (bucket.hooks[name] ??= { count: 0, failures: 0, cancelled: 0, totalMs: 0, maxMs: 0 });
}

interface ParseState {
  aggregate: FileAggregate;
  /**
   * `message.id`s already counted.
   *
   * Claude Code writes one JSONL line per content block, each carrying an
   * identical full copy of `message.usage`. Summing lines over-counts output
   * tokens by roughly 2.5x, so usage is taken once per response id. Tool-use
   * blocks are still counted per line, because there really is one per line.
   */
  seenMessages: Set<string>;
}

function bucketFor(state: ParseState, timestamp: string | undefined): DayBucket | null {
  const day = timestamp ? utcDay(timestamp) : null;
  if (!day) return null;
  if (!state.aggregate.firstTs || timestamp! < state.aggregate.firstTs) {
    state.aggregate.firstTs = timestamp!;
  }
  if (!state.aggregate.lastTs || timestamp! > state.aggregate.lastTs) {
    state.aggregate.lastTs = timestamp!;
  }
  return (state.aggregate.days[day] ??= emptyBucket());
}

function applyAssistant(state: ParseState, record: RawRecord, bucket: DayBucket): void {
  const message = record.message;
  if (!message) return;
  const model = message.model;

  if (model && model !== SYNTHETIC_MODEL && message.usage && message.id) {
    if (!state.seenMessages.has(message.id)) {
      state.seenMessages.add(message.id);
      addTokens((bucket.models[model] ??= emptyTokens()), readUsage(message.usage));
    }
  }

  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const name = block.name;
    bucket.tools[name] = (bucket.tools[name] ?? 0) + 1;
    // The subagent-spawning tool is `Agent`; `Task` is accepted for older logs.
    if (name === "Agent" || name === "Task") {
      const type = block.input?.subagent_type;
      const key = typeof type === "string" && type ? type : "general-purpose";
      const totals = (bucket.agents[key] ??= { count: 0, maxDepth: 0 });
      totals.count += 1;
    } else if (name === "Skill") {
      const skill = block.input?.skill;
      if (typeof skill === "string" && skill) {
        bucket.skills[skill] = (bucket.skills[skill] ?? 0) + 1;
      }
    }
  }
}

function applyUser(record: RawRecord, bucket: DayBucket): void {
  const content = record.message?.content;
  if (typeof content !== "string") return;

  // A real typed turn, as opposed to a tool result or an injected system turn.
  if (record.promptSource === "typed" && record.isMeta !== true) bucket.prompts += 1;

  SLASH_COMMAND.lastIndex = 0;
  for (const match of content.matchAll(SLASH_COMMAND)) {
    const name = match[1].trim();
    if (name) bucket.commands[name] = (bucket.commands[name] ?? 0) + 1;
  }
}

function applyAttachment(record: RawRecord, bucket: DayBucket): void {
  const attachment = record.attachment;
  if (!attachment?.type) return;
  switch (attachment.type) {
    case "hook_success": {
      const name = attachment.hookName ?? attachment.hookEvent ?? "unknown";
      const totals = hookTotals(bucket, name);
      totals.count += 1;
      if (count(attachment.exitCode) !== 0) totals.failures += 1;
      const duration = count(attachment.durationMs);
      totals.totalMs += duration;
      totals.maxMs = Math.max(totals.maxMs, duration);
      break;
    }
    case "hook_cancelled": {
      const totals = hookTotals(bucket, attachment.hookName ?? attachment.hookEvent ?? "unknown");
      totals.count += 1;
      totals.cancelled += 1;
      break;
    }
    case "invoked_skills": {
      for (const skill of attachment.skills ?? []) {
        const name = skill?.name;
        if (typeof name === "string" && name) {
          bucket.skills[name] = (bucket.skills[name] ?? 0) + 1;
        }
      }
      break;
    }
    case "dynamic_skill": {
      const name = attachment.skill?.name;
      if (typeof name === "string" && name) {
        bucket.skills[name] = (bucket.skills[name] ?? 0) + 1;
      }
      break;
    }
    default:
      break;
  }
}

function applySystem(record: RawRecord, bucket: DayBucket): void {
  switch (record.subtype) {
    case "api_error":
      bucket.errors += 1;
      break;
    case "compact_boundary":
      bucket.compactions += 1;
      break;
    case "stop_hook_summary": {
      // Stop hooks report here rather than as a `hook_success` attachment, so
      // counting both surfaces cannot double-count a single execution.
      for (const info of record.hookInfos ?? []) {
        const totals = hookTotals(bucket, "Stop");
        totals.count += 1;
        const duration = count(info?.durationMs);
        totals.totalMs += duration;
        totals.maxMs = Math.max(totals.maxMs, duration);
      }
      if (Array.isArray(record.hookErrors) && record.hookErrors.length > 0) {
        hookTotals(bucket, "Stop").failures += record.hookErrors.length;
      }
      break;
    }
    default:
      break;
  }
}

function applyRecord(state: ParseState, record: RawRecord): void {
  const aggregate = state.aggregate;

  // Title records repeat throughout a file and carry no timestamp; the last one
  // in file order wins.
  if (record.type === "custom-title" && record.customTitle) {
    aggregate.title = record.customTitle;
    return;
  }
  if (record.type === "ai-title" && record.aiTitle) {
    aggregate.title = record.aiTitle;
    return;
  }

  // `session_id` (snake case) also appears on these records with a different,
  // stale value. `sessionId` is the one that matches the filename.
  if (!aggregate.project && typeof record.cwd === "string") aggregate.project = record.cwd;
  if (!aggregate.gitBranch && typeof record.gitBranch === "string") {
    aggregate.gitBranch = record.gitBranch;
  }
  if (typeof record.version === "string") aggregate.toolVersion = record.version;

  const bucket = bucketFor(state, record.timestamp);
  if (!bucket) return;

  switch (record.type) {
    case "assistant":
      applyAssistant(state, record, bucket);
      break;
    case "user":
      applyUser(record, bucket);
      break;
    case "attachment":
      applyAttachment(record, bucket);
      break;
    case "system":
      applySystem(record, bucket);
      break;
    default:
      break;
  }
}

interface SubagentMeta {
  agentType?: string;
  spawnDepth?: number;
}

function readMeta(file: string): SubagentMeta {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf-8"),
    ) as SubagentMeta;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function listDirectory(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statOf(file: string): fs.Stats | null {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

export const claudeCodeProvider: UsageProvider = {
  name: "claude-code",
  title: "Claude Code",
  source: "Session transcripts under $CLAUDE_CONFIG_DIR/projects (default ~/.claude/projects)",
  capabilities: {
    tokens: true,
    cacheTokens: true,
    tools: true,
    skills: true,
    subagents: true,
    hooks: true,
    mcp: true,
    slashCommands: true,
    projects: true,
  },

  root(context: ProviderEnvironment): string | null {
    const candidate =
      context.override?.trim() ||
      context.env.CLAUDE_CONFIG_DIR?.trim() ||
      path.join(context.home, ".claude");
    try {
      return fs.statSync(path.join(candidate, PROJECTS)).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  },

  discover(root: string, options: DiscoverOptions): TranscriptFile[] {
    const projects = path.join(root, PROJECTS);
    const found: TranscriptFile[] = [];

    const accept = (
      file: string,
      shard: string,
      kind: TranscriptFile["kind"],
      stats: fs.Stats,
    ): void => {
      if (options.modifiedSince !== undefined && stats.mtimeMs < options.modifiedSince) return;
      found.push({
        file,
        relative: path.relative(projects, file),
        shard,
        kind,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    };

    for (const slug of listDirectory(projects)) {
      if (!slug.isDirectory()) continue;
      const slugDirectory = path.join(projects, slug.name);
      for (const entry of listDirectory(slugDirectory)) {
        const full = path.join(slugDirectory, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const stats = statOf(full);
          if (stats) accept(full, slug.name, "main", stats);
          continue;
        }
        if (!entry.isDirectory() || !options.subagents) continue;
        const subagents = path.join(full, SUBAGENTS);
        for (const agent of listDirectory(subagents)) {
          if (!agent.isFile() || !agent.name.endsWith(".jsonl")) continue;
          const agentFile = path.join(subagents, agent.name);
          const stats = statOf(agentFile);
          if (stats) accept(agentFile, slug.name, "subagent", stats);
        }
      }
    }

    // Byte comparison, never localeCompare: the order must not depend on the
    // ICU build of the machine that ran the scan.
    found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return found;
  },

  async read(file: TranscriptFile): Promise<FileAggregate> {
    const name = path.basename(file.file, ".jsonl");
    const subagent = file.kind === "subagent";
    // A subagent transcript's own records carry the parent's `sessionId`, and
    // the parent session id is also its containing directory, so neither needs
    // reading out of the file.
    const sessionId = subagent ? path.basename(path.dirname(path.dirname(file.file))) : name;
    const meta = subagent ? readMeta(file.file) : {};

    const aggregate: FileAggregate = {
      file: file.file,
      size: file.size,
      mtimeMs: file.mtimeMs,
      provider: claudeCodeProvider.name,
      sessionId,
      kind: file.kind,
      ...(subagent ? { parentSessionId: sessionId } : {}),
      ...(subagent ? { agentId: name.replace(/^agent-/, "") } : {}),
      ...(subagent && meta.agentType ? { agentType: meta.agentType } : {}),
      ...(subagent && typeof meta.spawnDepth === "number" ? { spawnDepth: meta.spawnDepth } : {}),
      project: "",
      firstTs: "",
      lastTs: "",
      days: {},
      malformedLines: 0,
    };

    const state: ParseState = { aggregate, seenMessages: new Set() };
    const lines = readline.createInterface({
      input: createReadStream(file.file, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line) continue;
      let record: RawRecord;
      try {
        record = JSON.parse(line) as RawRecord;
      } catch {
        // Reported in the payload, never thrown: a truncated final line is
        // routine in a transcript that is still being appended to.
        aggregate.malformedLines += 1;
        continue;
      }
      if (record && typeof record === "object") applyRecord(state, record);
    }

    return aggregate;
  },
};
