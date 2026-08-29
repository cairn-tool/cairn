/**
 * The normalized usage model.
 *
 * Nothing here touches the filesystem or knows which provider produced it: a
 * provider's job is to turn its own on-disk format into these shapes, and every
 * rollup in `aggregate.ts` reads only these. That split is what lets a second
 * LLM's logs join the same reports without a single change to the commands.
 *
 * The unit of storage is a **day-bucketed per-file aggregate**. Keeping raw
 * events would make the index unusable at corpus scale, and keeping flat
 * per-file totals would make `usage tokens --by day` impossible; bucketing by
 * UTC date costs almost nothing (a session rarely spans two days) and preserves
 * every cross-tab the subcommands need.
 */

/**
 * Token counters for one bucket.
 *
 * `cacheWrite` is the authoritative total; `cacheWrite5m` and `cacheWrite1h`
 * are a best-effort TTL split, which the oldest records do not carry. They can
 * therefore sum to less than `cacheWrite`, and never to more — reporting the
 * total separately is what keeps a legacy record from being silently filed
 * under the wrong TTL.
 *
 * `requests` counts deduplicated API responses, not JSONL lines — see
 * `providers/claude-code.ts` for why those differ by a factor of two.
 */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  thinking: number;
  webSearch: number;
  webFetch: number;
  requests: number;
}

export interface HookTotals {
  count: number;
  failures: number;
  cancelled: number;
  totalMs: number;
  maxMs: number;
}

export interface AgentTotals {
  count: number;
  maxDepth: number;
}

/** Everything observed on one UTC calendar day within one transcript. */
export interface DayBucket {
  models: Record<string, TokenTotals>;
  tools: Record<string, number>;
  skills: Record<string, number>;
  agents: Record<string, AgentTotals>;
  hooks: Record<string, HookTotals>;
  commands: Record<string, number>;
  prompts: number;
  errors: number;
  compactions: number;
}

/**
 * One transcript file, reduced.
 *
 * `size` and `mtimeMs` are the cache key: transcripts are append-only, so a file
 * whose size and mtime are unchanged cannot have new records in it.
 */
export interface FileAggregate {
  file: string;
  size: number;
  mtimeMs: number;
  provider: string;
  sessionId: string;
  kind: TranscriptKind;
  parentSessionId?: string;
  agentId?: string;
  agentType?: string;
  spawnDepth?: number;
  /** Absolute working directory, read from the records rather than the directory name. */
  project: string;
  title?: string;
  gitBranch?: string;
  toolVersion?: string;
  firstTs: string;
  lastTs: string;
  days: Record<string, DayBucket>;
  /** Lines that were not valid JSON. Reported, never thrown. */
  malformedLines: number;
}

export type TranscriptKind = "main" | "subagent";

/** How a tool call is classified for `usage tools --by kind`. */
export type ToolKind = "builtin" | "mcp" | "agent" | "skill";

export const TOOL_KINDS: readonly ToolKind[] = ["builtin", "mcp", "agent", "skill"];

export function emptyTokens(): TokenTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
    requests: 0,
  };
}

export function addTokens(into: TokenTotals, from: TokenTotals): TokenTotals {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cacheWrite5m += from.cacheWrite5m;
  into.cacheWrite1h += from.cacheWrite1h;
  into.thinking += from.thinking;
  into.webSearch += from.webSearch;
  into.webFetch += from.webFetch;
  into.requests += from.requests;
  return into;
}

/**
 * Every token that passed through the model, billable or not.
 *
 * Cache reads are included: they are what the request actually cost in context,
 * and omitting them understates real usage by an order of magnitude.
 */
export function totalTokens(tokens: TokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

export function emptyBucket(): DayBucket {
  return {
    models: {},
    tools: {},
    skills: {},
    agents: {},
    hooks: {},
    commands: {},
    prompts: 0,
    errors: 0,
    compactions: 0,
  };
}

function addCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
}

export function addBucket(into: DayBucket, from: DayBucket): DayBucket {
  for (const [model, tokens] of Object.entries(from.models)) {
    addTokens((into.models[model] ??= emptyTokens()), tokens);
  }
  addCounts(into.tools, from.tools);
  addCounts(into.skills, from.skills);
  addCounts(into.commands, from.commands);
  for (const [name, totals] of Object.entries(from.agents)) {
    const target = (into.agents[name] ??= { count: 0, maxDepth: 0 });
    target.count += totals.count;
    target.maxDepth = Math.max(target.maxDepth, totals.maxDepth);
  }
  for (const [name, totals] of Object.entries(from.hooks)) {
    const target = (into.hooks[name] ??= {
      count: 0,
      failures: 0,
      cancelled: 0,
      totalMs: 0,
      maxMs: 0,
    });
    target.count += totals.count;
    target.failures += totals.failures;
    target.cancelled += totals.cancelled;
    target.totalMs += totals.totalMs;
    target.maxMs = Math.max(target.maxMs, totals.maxMs);
  }
  into.prompts += from.prompts;
  into.errors += from.errors;
  into.compactions += from.compactions;
  return into;
}

/** Token totals across every model in a bucket. */
export function bucketTokens(bucket: DayBucket): TokenTotals {
  const totals = emptyTokens();
  for (const tokens of Object.values(bucket.models)) addTokens(totals, tokens);
  return totals;
}

/** Tool calls across every name in a bucket. */
export function bucketToolCalls(bucket: DayBucket): number {
  let total = 0;
  for (const count of Object.values(bucket.tools)) total += count;
  return total;
}

/**
 * Splits an MCP tool name into its server and tool halves.
 *
 * Claude Code names an MCP tool `mcp__<server>__<tool>`, and a server name may
 * itself contain underscores, so the split is on the *first* `__` after the
 * prefix and the remainder is the tool. Anything that does not match is a
 * builtin.
 */
export function classifyTool(name: string): { kind: ToolKind; server?: string; tool: string } {
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const boundary = rest.indexOf("__");
    if (boundary > 0) {
      return { kind: "mcp", server: rest.slice(0, boundary), tool: rest.slice(boundary + 2) };
    }
    return { kind: "mcp", server: rest, tool: rest };
  }
  if (name === "Agent" || name === "Task") return { kind: "agent", tool: name };
  if (name === "Skill") return { kind: "skill", tool: name };
  return { kind: "builtin", tool: name };
}

/** The UTC calendar day an ISO timestamp falls on, or null when unparseable. */
export function utcDay(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}
