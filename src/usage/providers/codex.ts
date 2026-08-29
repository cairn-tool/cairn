import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { DayBucket, FileAggregate, ParsedFile, TokenTotals, UsageEvent } from "../events.js";
import { addTokens, emptyBucket, emptyTokens, utcDay } from "../events.js";
import type {
  DiscoverOptions,
  ProviderEnvironment,
  TranscriptFile,
  UsageProvider,
} from "./types.js";

/**
 * OpenAI Codex CLI rollout transcripts.
 *
 * ```
 * sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl
 * ```
 *
 * **The directory and filename stamps are local time; every in-record timestamp
 * is UTC.** Days are therefore always taken from the records. The path is used
 * only for the cache shard, where it is a naming convention rather than a fact.
 *
 * Every line is `{timestamp, ordinal?, type, payload}`. Line 1 is a
 * `session_meta` header; the rest are a discriminated union on `payload.type`.
 */

const SESSIONS = "sessions";

/** Bounds the shard-directory walk to `YYYY/MM/DD`. */
const DATE_DEPTH = 3;

interface Cumulative {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

interface RawRecord {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    // session_meta
    id?: string;
    session_id?: string;
    parent_thread_id?: string;
    thread_source?: string;
    cwd?: string;
    cli_version?: string;
    agent_role?: string;
    agent_path?: string;
    agent_nickname?: string;
    git?: { branch?: string };
    source?: unknown;
    // turn_context
    model?: string;
    // thread_settings_applied
    thread_settings?: { model?: string };
    // token_count
    info?: {
      total_token_usage?: Record<string, number>;
    } | null;
    // response_item tool calls
    name?: string;
    namespace?: string;
    arguments?: string;
    // mcp_tool_call_end
    invocation?: { server?: string; tool?: string };
    // item_completed
    item?: { type?: string; content?: RawContent[] };
  };
}

interface RawContent {
  type?: string;
  name?: string;
  text_elements?: Array<{ placeholder?: string }>;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readCumulative(usage: Record<string, number>): Cumulative {
  return {
    input: count(usage.input_tokens),
    cached: count(usage.cached_input_tokens),
    cacheWrite: count(usage.cache_write_input_tokens),
    output: count(usage.output_tokens),
    reasoning: count(usage.reasoning_output_tokens),
  };
}

/**
 * Turns a pair of cumulative readings into one request's usage.
 *
 * `info.total_token_usage` is a running total for the thread and
 * `info.last_token_usage` is the most recent request — but `last` is re-emitted
 * unchanged on duplicate events, so summing it inflates the total (measured ~4%
 * over one session). The delta of the cumulative figure is exact by
 * construction, and it is what makes per-day attribution possible at all.
 *
 * `input_tokens` *includes* `cached_input_tokens`, unlike Claude Code's, so the
 * cached part is subtracted out and reported as a cache read. Skipping that step
 * overstates Codex input roughly eight-fold.
 */
function delta(current: Cumulative, previous: Cumulative | null): TokenTotals {
  const before = previous ?? { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  // Clamped: a resumed or forked thread can replay a lower reading, and a
  // negative token count is never the right answer.
  const at = (now: number, then: number): number => Math.max(0, now - then);
  const input = at(current.input, before.input);
  const cached = at(current.cached, before.cached);
  return {
    input: Math.max(0, input - cached),
    output: at(current.output, before.output),
    cacheRead: cached,
    cacheWrite: at(current.cacheWrite, before.cacheWrite),
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    thinking: at(current.reasoning, before.reasoning),
    webSearch: 0,
    webFetch: 0,
    requests: 1,
  };
}

function isEmpty(totals: TokenTotals): boolean {
  return (
    totals.input === 0 &&
    totals.output === 0 &&
    totals.cacheRead === 0 &&
    totals.cacheWrite === 0 &&
    totals.thinking === 0
  );
}

interface ParseState {
  aggregate: FileAggregate;
  previous: Cumulative | null;
  /** Model in force, updated by every turn_context and settings change. */
  model: string;
  /** Per-occurrence decomposition; see the note on `ParseState` in claude-code.ts. */
  events: UsageEvent[];
  /** Timestamp of the record being applied, which every event is stamped with. */
  ts: string;
}

function emit(state: ParseState, event: Omit<UsageEvent, "ts">): void {
  state.events.push({ ts: state.ts, ...event });
}

function bucketFor(state: ParseState, timestamp: string | undefined): DayBucket | null {
  const day = timestamp ? utcDay(timestamp) : null;
  if (!day) return null;
  const aggregate = state.aggregate;
  if (!aggregate.firstTs || timestamp! < aggregate.firstTs) aggregate.firstTs = timestamp!;
  if (!aggregate.lastTs || timestamp! > aggregate.lastTs) aggregate.lastTs = timestamp!;
  return (aggregate.days[day] ??= emptyBucket());
}

function tool(state: ParseState, bucket: DayBucket, name: string): void {
  bucket.tools[name] = (bucket.tools[name] ?? 0) + 1;
  emit(state, { kind: "tool_use", tool: name });
}

function applySpawn(state: ParseState, bucket: DayBucket, args: string | undefined): void {
  let type = "(unrecorded)";
  try {
    const parsed = JSON.parse(args ?? "{}") as { agent_type?: unknown };
    if (typeof parsed.agent_type === "string" && parsed.agent_type) type = parsed.agent_type;
  } catch {
    // A spawn whose arguments will not parse still happened; count it unnamed.
  }
  const totals = (bucket.agents[type] ??= { count: 0, maxDepth: 0 });
  totals.count += 1;
  emit(state, { kind: "agent", name: type });
}

function applyUserItem(
  state: ParseState,
  bucket: DayBucket,
  content: RawContent[] | undefined,
): void {
  for (const part of content ?? []) {
    // Codex records an invoked skill as its own content part.
    if (part?.type === "skill" && typeof part.name === "string" && part.name) {
      bucket.skills[part.name] = (bucket.skills[part.name] ?? 0) + 1;
      emit(state, { kind: "skill", name: part.name });
    }
    // `$name` is Codex's slash-command analogue, and the only place it is named.
    for (const element of part?.text_elements ?? []) {
      const placeholder = element?.placeholder;
      if (typeof placeholder === "string" && placeholder.startsWith("$")) {
        bucket.commands[placeholder] = (bucket.commands[placeholder] ?? 0) + 1;
        emit(state, { kind: "command", name: placeholder });
      }
    }
  }
}

function applyRecord(state: ParseState, record: RawRecord): void {
  const payload = record.payload;
  if (!payload) return;

  // Model can change mid-session, so it is tracked as a running value and the
  // token deltas below are attributed to whatever was in force at the time.
  if (record.type === "turn_context" && typeof payload.model === "string") {
    state.model = payload.model;
    return;
  }
  if (payload.type === "thread_settings_applied") {
    const model = payload.thread_settings?.model;
    if (typeof model === "string" && model) state.model = model;
    return;
  }

  const bucket = bucketFor(state, record.timestamp);
  if (!bucket) return;
  state.ts = record.timestamp!;

  switch (payload.type) {
    case "token_count": {
      // `info` is null on a handful of records corpus-wide.
      const usage = payload.info?.total_token_usage;
      if (!usage) return;
      const current = readCumulative(usage);
      const totals = delta(current, state.previous);
      state.previous = current;
      // A duplicate re-emission carries the same cumulative figure and so a zero
      // delta. Counting it would inflate the request count for no tokens.
      if (!isEmpty(totals)) {
        addTokens((bucket.models[state.model] ??= emptyTokens()), totals);
        emit(state, { kind: "response", model: state.model, tokens: totals });
      }
      return;
    }
    // `response_item` is the raw API view and `event_msg` the UI view of the
    // same activity. Tools are counted from the former only; counting both
    // doubles every call.
    case "custom_tool_call":
      if (typeof payload.name === "string") tool(state, bucket, payload.name);
      return;
    case "function_call": {
      if (typeof payload.name !== "string") return;
      const name = payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name;
      tool(state, bucket, name);
      if (payload.name === "spawn_agent") applySpawn(state, bucket, payload.arguments);
      return;
    }
    // MCP and web search have no `response_item` counterpart, so they are taken
    // from `event_msg` without any risk of double-counting.
    case "mcp_tool_call_end": {
      const server = payload.invocation?.server ?? "unknown";
      const name = payload.invocation?.tool ?? "unknown";
      tool(state, bucket, `mcp__${server}__${name}`);
      return;
    }
    case "web_search_end":
      tool(state, bucket, "web.search");
      return;
    case "user_message":
      bucket.prompts += 1;
      emit(state, { kind: "prompt" });
      return;
    case "context_compacted":
      bucket.compactions += 1;
      emit(state, { kind: "compaction" });
      return;
    case "item_completed":
      if (payload.item?.type === "UserMessage") applyUserItem(state, bucket, payload.item.content);
      return;
    default:
      return;
  }
}

/**
 * Applies the first-line header.
 *
 * `payload.id` is the thread's own id and `payload.session_id` the root it
 * descends from; they differ on subagent and forked threads, and a few files
 * carry a second `session_meta` for the ancestor, so only line 1 is trusted.
 */
function applyHeader(aggregate: FileAggregate, record: RawRecord): void {
  const payload = record.payload;
  if (!payload) return;
  if (typeof payload.id === "string" && payload.id) aggregate.sessionId = payload.id;
  if (payload.thread_source === "subagent") {
    aggregate.kind = "subagent";
    if (typeof payload.session_id === "string") aggregate.parentSessionId = payload.session_id;
    else if (typeof payload.parent_thread_id === "string") {
      aggregate.parentSessionId = payload.parent_thread_id;
    }
    if (typeof payload.agent_role === "string" && payload.agent_role) {
      aggregate.agentType = payload.agent_role;
    }
    if (typeof payload.agent_path === "string" && payload.agent_path) {
      aggregate.agentPath = payload.agent_path;
    }
    // `source` is a bare string on legacy files and an object on current ones.
    const source = payload.source as { subagent?: { thread_spawn?: { depth?: unknown } } } | string;
    const depth =
      typeof source === "object" && source ? source.subagent?.thread_spawn?.depth : undefined;
    if (typeof depth === "number") aggregate.spawnDepth = depth;
  }
  if (typeof payload.cwd === "string") aggregate.project = payload.cwd;
  if (typeof payload.git?.branch === "string") aggregate.gitBranch = payload.git.branch;
  if (typeof payload.cli_version === "string") aggregate.toolVersion = payload.cli_version;
  if (typeof payload.agent_nickname === "string" && payload.agent_nickname) {
    aggregate.title = payload.agent_nickname;
  }
}

function listDirectory(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Walks the fixed `YYYY/MM/DD` nesting, collecting rollout files. */
function walk(directory: string, depth: number, into: string[]): void {
  for (const entry of listDirectory(directory)) {
    const full = path.join(directory, entry.name);
    if (depth < DATE_DEPTH) {
      if (entry.isDirectory()) walk(full, depth + 1, into);
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      into.push(full);
    }
  }
}

export const codexProvider: UsageProvider = {
  name: "codex",
  title: "Codex CLI",
  source: "Rollout transcripts under $CODEX_HOME/sessions (default ~/.codex/sessions)",
  capabilities: {
    tokens: true,
    cacheTokens: true,
    tools: true,
    skills: true,
    subagents: true,
    // Hooks are configured in ~/.codex/hooks.json but no execution is recorded
    // in the rollout files, so there is nothing to report.
    hooks: false,
    mcp: true,
    slashCommands: true,
    projects: true,
  },

  root(context: ProviderEnvironment): string | null {
    const candidate =
      context.override?.trim() ||
      context.env.CODEX_HOME?.trim() ||
      path.join(context.home, ".codex");
    try {
      return fs.statSync(path.join(candidate, SESSIONS)).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  },

  discover(root: string, options: DiscoverOptions): TranscriptFile[] {
    const sessions = path.join(root, SESSIONS);
    const files: string[] = [];
    // Depth 0 is `sessions/` itself; rollout files sit three directories below.
    walk(sessions, 0, files);

    const found: TranscriptFile[] = [];
    for (const file of files) {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(file);
        if (!stats.isFile()) continue;
      } catch {
        continue;
      }
      if (options.modifiedSince !== undefined && stats.mtimeMs < options.modifiedSince) continue;
      const relative = path.relative(sessions, file);
      found.push({
        file,
        relative,
        // The date directories are local time, which makes them a poor day key
        // but a perfectly good cache bucket.
        shard: path.dirname(relative).split(path.sep).join("-"),
        // Whether a thread is a subagent is recorded inside the file, not in its
        // path, so it cannot be known without reading it. `read` sets the real
        // value and the scan filters on that.
        kind: "main",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }

    found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return found;
  },

  async read(file: TranscriptFile): Promise<FileAggregate> {
    return (await codexProvider.parse(file)).aggregate;
  },

  async parse(file: TranscriptFile): Promise<ParsedFile> {
    const aggregate: FileAggregate = {
      file: file.file,
      size: file.size,
      mtimeMs: file.mtimeMs,
      provider: codexProvider.name,
      sessionId: path.basename(file.file, ".jsonl"),
      kind: "main",
      project: "",
      firstTs: "",
      lastTs: "",
      days: {},
      malformedLines: 0,
    };

    const state: ParseState = {
      aggregate,
      previous: null,
      model: "(unknown)",
      events: [],
      ts: "",
    };
    const lines = readline.createInterface({
      input: createReadStream(file.file, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let first = true;
    for await (const line of lines) {
      if (!line) continue;
      let record: RawRecord;
      try {
        record = JSON.parse(line) as RawRecord;
      } catch {
        aggregate.malformedLines += 1;
        continue;
      }
      if (!record || typeof record !== "object") continue;
      if (first) {
        first = false;
        if (record.type === "session_meta") {
          applyHeader(aggregate, record);
          bucketFor(state, record.timestamp);
          continue;
        }
      }
      applyRecord(state, record);
    }

    return { aggregate, events: state.events };
  },
};
