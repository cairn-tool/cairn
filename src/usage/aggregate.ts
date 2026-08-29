import type { DayBucket, FileAggregate, TokenTotals, ToolKind } from "./events.js";
import {
  addBucket,
  addTokens,
  bucketToolCalls,
  bucketTokens,
  classifyTool,
  emptyBucket,
  emptyTokens,
  sessionKey,
  totalTokens,
} from "./events.js";

/**
 * Rollups over scanned aggregates.
 *
 * Pure: every function here takes `FileAggregate[]` and returns rows. Nothing
 * reads the filesystem, nothing knows which provider produced the input, and
 * nothing formats anything — that is `src/commands/usage.ts`.
 */

export const TOKEN_DIMENSIONS = [
  "model",
  "day",
  "week",
  "month",
  "project",
  "session",
  "provider",
] as const;
export type TokenDimension = (typeof TOKEN_DIMENSIONS)[number];

export const TOOL_DIMENSIONS = ["name", "kind", "server", "day", "session", "provider"] as const;
export type ToolDimension = (typeof TOOL_DIMENSIONS)[number];

export const SESSION_SORTS = ["recent", "tokens", "tools", "duration"] as const;

/**
 * How `usage agents` groups.
 *
 * `role` is the reusable agent type, which is what `agentType` means for every
 * provider. `path` is the task-specific identifier, which only some record.
 */
export const AGENT_DIMENSIONS = ["role", "path"] as const;
export type AgentDimension = (typeof AGENT_DIMENSIONS)[number];
export type SessionSort = (typeof SESSION_SORTS)[number];

/**
 * One row of any rollup.
 *
 * A single row type across every subcommand is what lets them share the
 * `usage-rollup` schema. Only `key` and `count` are always present; each
 * dimension fills in the fields that mean something for it and leaves the rest
 * off, so a consumer reads a row by the `dimension` the payload declares.
 */
export interface RollupRow {
  key: string;
  /** Which provider a row came from, where a row belongs to exactly one. */
  provider?: string;
  count: number;
  tokens?: TokenTotals;
  sessions?: number;
  toolCalls?: number;
  prompts?: number;
  /** Tools. */
  kind?: ToolKind;
  server?: string;
  /** Hooks. */
  failures?: number;
  cancelled?: number;
  meanMs?: number;
  maxMs?: number;
  /** Subagents. */
  maxDepth?: number;
  /** Sessions. */
  project?: string;
  title?: string;
  gitBranch?: string;
  firstTs?: string;
  lastTs?: string;
  durationMs?: number;
  subagents?: number;
  models?: string[];
}

/** Byte comparison, never `localeCompare`: generated order must not vary by ICU build. */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rankByTokens(rows: RollupRow[]): RollupRow[] {
  return rows.sort((a, b) => {
    const left = a.tokens ? totalTokens(a.tokens) : 0;
    const right = b.tokens ? totalTokens(b.tokens) : 0;
    if (left !== right) return right - left;
    if (a.count !== b.count) return b.count - a.count;
    return byKey(a.key, b.key);
  });
}

function rankByCount(rows: RollupRow[]): RollupRow[] {
  return rows.sort((a, b) => (b.count !== a.count ? b.count - a.count : byKey(a.key, b.key)));
}

class Rows {
  private readonly rows = new Map<string, RollupRow>();

  get(key: string): RollupRow {
    let row = this.rows.get(key);
    if (!row) {
      row = { key, count: 0 };
      this.rows.set(key, row);
    }
    return row;
  }

  tokensOf(key: string): TokenTotals {
    const row = this.get(key);
    return (row.tokens ??= emptyTokens());
  }

  values(): RollupRow[] {
    return [...this.rows.values()];
  }
}

/** The Monday that starts the ISO week a UTC day falls in. */
export function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

export function totalsOf(files: readonly FileAggregate[]): TokenTotals {
  const totals = emptyTokens();
  for (const file of files) {
    for (const bucket of Object.values(file.days)) addTokens(totals, bucketTokens(bucket));
  }
  return totals;
}

/** Every day bucket in the selection, merged. */
export function mergedBucket(files: readonly FileAggregate[]): DayBucket {
  const merged = emptyBucket();
  for (const file of files) {
    for (const bucket of Object.values(file.days)) addBucket(merged, bucket);
  }
  return merged;
}

export interface UsageSummary {
  sessions: number;
  transcripts: number;
  subagentTranscripts: number;
  projects: number;
  prompts: number;
  errors: number;
  compactions: number;
  firstDay: string | null;
  lastDay: string | null;
  days: number;
  tokens: TokenTotals;
  tokensByKind: { main: TokenTotals; subagent: TokenTotals };
  models: RollupRow[];
  tools: RollupRow[];
  features: {
    skills: number;
    subagents: number;
    hooks: number;
    hookFailures: number;
    slashCommands: number;
    mcpCalls: number;
  };
}

export function summarize(files: readonly FileAggregate[]): UsageSummary {
  const sessions = new Set<string>();
  const projects = new Set<string>();
  const kinds = { main: emptyTokens(), subagent: emptyTokens() };
  const days = new Set<string>();
  let subagentTranscripts = 0;

  for (const file of files) {
    sessions.add(sessionKey(file));
    if (file.project) projects.add(file.project);
    if (file.kind === "subagent") subagentTranscripts += 1;
    for (const [day, bucket] of Object.entries(file.days)) {
      days.add(day);
      addTokens(kinds[file.kind], bucketTokens(bucket));
    }
  }

  const merged = mergedBucket(files);
  const ordered = [...days].sort(byKey);
  const tokens = emptyTokens();
  addTokens(tokens, kinds.main);
  addTokens(tokens, kinds.subagent);

  let skills = 0;
  for (const value of Object.values(merged.skills)) skills += value;
  let subagents = 0;
  for (const value of Object.values(merged.agents)) subagents += value.count;
  let hooks = 0;
  let hookFailures = 0;
  for (const value of Object.values(merged.hooks)) {
    hooks += value.count;
    hookFailures += value.failures;
  }
  let slashCommands = 0;
  for (const value of Object.values(merged.commands)) slashCommands += value;
  let mcpCalls = 0;
  for (const [name, calls] of Object.entries(merged.tools)) {
    if (classifyTool(name).kind === "mcp") mcpCalls += calls;
  }

  const models = new Rows();
  for (const [model, totals] of Object.entries(merged.models)) {
    const row = models.get(model);
    row.count = totals.requests;
    addTokens(models.tokensOf(model), totals);
  }
  const tools = new Rows();
  for (const [name, calls] of Object.entries(merged.tools)) {
    const row = tools.get(name);
    row.count = calls;
    row.kind = classifyTool(name).kind;
  }

  return {
    sessions: sessions.size,
    transcripts: files.length,
    subagentTranscripts,
    projects: projects.size,
    prompts: merged.prompts,
    errors: merged.errors,
    compactions: merged.compactions,
    firstDay: ordered[0] ?? null,
    lastDay: ordered[ordered.length - 1] ?? null,
    days: ordered.length,
    tokens,
    tokensByKind: kinds,
    models: rankByTokens(models.values()),
    tools: rankByCount(tools.values()),
    features: { skills, subagents, hooks, hookFailures, slashCommands, mcpCalls },
  };
}

export function rollupTokens(
  files: readonly FileAggregate[],
  dimension: TokenDimension,
): RollupRow[] {
  const rows = new Rows();
  const seen = new Map<string, Set<string>>();

  const keyFor = (file: FileAggregate, day: string, model: string): string => {
    switch (dimension) {
      case "model":
        return model;
      case "day":
        return day;
      case "week":
        return weekOf(day);
      case "month":
        return day.slice(0, 7);
      case "project":
        return file.project || "(unknown)";
      case "session":
        return sessionKey(file);
      case "provider":
        return file.provider;
    }
  };

  for (const file of files) {
    for (const [day, bucket] of Object.entries(file.days)) {
      for (const [model, totals] of Object.entries(bucket.models)) {
        const key = keyFor(file, day, model);
        const row = rows.get(key);
        row.count += totals.requests;
        addTokens(rows.tokensOf(key), totals);
        const sessions = seen.get(key) ?? new Set<string>();
        sessions.add(sessionKey(file));
        seen.set(key, sessions);
      }
    }
  }

  for (const row of rows.values()) row.sessions = seen.get(row.key)?.size ?? 0;

  const values = rows.values();
  // Time dimensions read chronologically; everything else ranks by spend.
  return dimension === "day" || dimension === "week" || dimension === "month"
    ? values.sort((a, b) => byKey(a.key, b.key))
    : rankByTokens(values);
}

export function rollupTools(
  files: readonly FileAggregate[],
  dimension: ToolDimension,
  kind?: ToolKind,
): RollupRow[] {
  const rows = new Rows();

  for (const file of files) {
    for (const [day, bucket] of Object.entries(file.days)) {
      for (const [name, calls] of Object.entries(bucket.tools)) {
        const classified = classifyTool(name);
        if (kind && classified.kind !== kind) continue;
        let key: string;
        switch (dimension) {
          case "name":
            key = name;
            break;
          case "kind":
            key = classified.kind;
            break;
          case "server":
            key = classified.server ?? "(builtin)";
            break;
          case "day":
            key = day;
            break;
          case "session":
            key = sessionKey(file);
            break;
          case "provider":
            key = file.provider;
            break;
        }
        const row = rows.get(key);
        row.count += calls;
        if (dimension === "name") {
          row.kind = classified.kind;
          if (classified.server) row.server = classified.server;
        }
      }
    }
  }

  const values = rows.values();
  return dimension === "day" ? values.sort((a, b) => byKey(a.key, b.key)) : rankByCount(values);
}

export function rollupSessions(
  files: readonly FileAggregate[],
  sort: SessionSort = "recent",
): RollupRow[] {
  const rows = new Map<string, RollupRow>();
  const models = new Map<string, Set<string>>();

  for (const file of files) {
    // Grouped by the provider-qualified id, but shown by the bare one: the
    // qualifier exists to stop two providers' sessions merging, not to be read.
    const key = sessionKey(file);
    let row = rows.get(key);
    if (!row) {
      row = {
        key: file.sessionId,
        provider: file.provider,
        count: 0,
        tokens: emptyTokens(),
        toolCalls: 0,
        subagents: 0,
      };
      rows.set(key, row);
    }
    // Identity comes from the main transcript; a subagent file inherits the
    // parent's cwd but carries no title of its own.
    if (file.kind === "main") {
      if (file.project) row.project = file.project;
      if (file.title) row.title = file.title;
      if (file.gitBranch) row.gitBranch = file.gitBranch;
    } else {
      row.subagents = (row.subagents ?? 0) + 1;
      if (!row.project && file.project) row.project = file.project;
    }
    if (file.firstTs && (!row.firstTs || file.firstTs < row.firstTs)) row.firstTs = file.firstTs;
    if (file.lastTs && (!row.lastTs || file.lastTs > row.lastTs)) row.lastTs = file.lastTs;

    const names = models.get(key) ?? new Set<string>();
    for (const bucket of Object.values(file.days)) {
      const tokens = bucketTokens(bucket);
      addTokens(row.tokens!, tokens);
      row.count += tokens.requests;
      row.toolCalls = (row.toolCalls ?? 0) + bucketToolCalls(bucket);
      row.prompts = (row.prompts ?? 0) + bucket.prompts;
      for (const model of Object.keys(bucket.models)) names.add(model);
    }
    models.set(key, names);
  }

  const values = [...rows.values()];
  for (const row of values) {
    row.models = [
      ...(models.get(sessionKey({ provider: row.provider!, sessionId: row.key })) ?? []),
    ].sort(byKey);
    if (row.firstTs && row.lastTs) {
      row.durationMs = Math.max(0, Date.parse(row.lastTs) - Date.parse(row.firstTs));
    }
  }

  switch (sort) {
    case "tokens":
      return rankByTokens(values);
    case "tools":
      return values.sort((a, b) =>
        (b.toolCalls ?? 0) !== (a.toolCalls ?? 0)
          ? (b.toolCalls ?? 0) - (a.toolCalls ?? 0)
          : byKey(a.key, b.key),
      );
    case "duration":
      return values.sort((a, b) =>
        (b.durationMs ?? 0) !== (a.durationMs ?? 0)
          ? (b.durationMs ?? 0) - (a.durationMs ?? 0)
          : byKey(a.key, b.key),
      );
    case "recent":
    default:
      return values.sort((a, b) => byKey(b.lastTs ?? "", a.lastTs ?? ""));
  }
}

export function rollupProjects(files: readonly FileAggregate[]): RollupRow[] {
  const rows = new Rows();
  const sessions = new Map<string, Set<string>>();

  for (const file of files) {
    const key = file.project || "(unknown)";
    const row = rows.get(key);
    const seen = sessions.get(key) ?? new Set<string>();
    seen.add(file.sessionId);
    sessions.set(key, seen);
    for (const bucket of Object.values(file.days)) {
      const tokens = bucketTokens(bucket);
      addTokens(rows.tokensOf(key), tokens);
      row.count += tokens.requests;
      row.toolCalls = (row.toolCalls ?? 0) + bucketToolCalls(bucket);
      row.prompts = (row.prompts ?? 0) + bucket.prompts;
    }
  }

  for (const row of rows.values()) row.sessions = sessions.get(row.key)?.size ?? 0;
  return rankByTokens(rows.values());
}

export function rollupSkills(files: readonly FileAggregate[]): RollupRow[] {
  const rows = new Rows();
  const sessions = new Map<string, Set<string>>();
  for (const file of files) {
    for (const bucket of Object.values(file.days)) {
      for (const [name, calls] of Object.entries(bucket.skills)) {
        rows.get(name).count += calls;
        const seen = sessions.get(name) ?? new Set<string>();
        seen.add(sessionKey(file));
        sessions.set(name, seen);
      }
    }
  }
  for (const row of rows.values()) row.sessions = sessions.get(row.key)?.size ?? 0;
  return rankByCount(rows.values());
}

/**
 * Subagent activity.
 *
 * Spawn counts come from the parent's `Agent` tool calls; tokens come from the
 * subagent transcripts themselves, because the parent's `toolUseResult` records
 * only the subagent's final message and understates real spend several-fold.
 */
export function rollupAgents(
  files: readonly FileAggregate[],
  dimension: AgentDimension = "role",
): RollupRow[] {
  const rows = new Rows();
  const transcripts = new Map<string, number>();

  for (const file of files) {
    // Spawn counts come from the parent's tool calls, which name the agent by
    // its type. There is no per-path spawn record, so under `--by path` the
    // transcript count is the spawn count.
    if (dimension === "role") {
      for (const bucket of Object.values(file.days)) {
        for (const [type, totals] of Object.entries(bucket.agents)) {
          rows.get(type).count += totals.count;
        }
      }
    }
    if (file.kind !== "subagent") continue;

    const named = dimension === "path" ? (file.agentPath ?? file.agentType) : file.agentType;
    const key = named ?? "(unrecorded)";
    const row = rows.get(key);
    transcripts.set(key, (transcripts.get(key) ?? 0) + 1);
    if (dimension === "path") row.count += 1;
    if (typeof file.spawnDepth === "number") {
      row.maxDepth = Math.max(row.maxDepth ?? 0, file.spawnDepth);
    }
    for (const bucket of Object.values(file.days)) {
      addTokens(rows.tokensOf(key), bucketTokens(bucket));
      row.toolCalls = (row.toolCalls ?? 0) + bucketToolCalls(bucket);
    }
  }

  for (const row of rows.values()) row.sessions = transcripts.get(row.key) ?? 0;
  return rankByCount(rows.values());
}

export function rollupHooks(files: readonly FileAggregate[]): RollupRow[] {
  const rows = new Rows();
  const durations = new Map<string, number>();

  for (const file of files) {
    for (const bucket of Object.values(file.days)) {
      for (const [name, totals] of Object.entries(bucket.hooks)) {
        const row = rows.get(name);
        row.count += totals.count;
        row.failures = (row.failures ?? 0) + totals.failures;
        row.cancelled = (row.cancelled ?? 0) + totals.cancelled;
        row.maxMs = Math.max(row.maxMs ?? 0, totals.maxMs);
        durations.set(name, (durations.get(name) ?? 0) + totals.totalMs);
      }
    }
  }

  for (const row of rows.values()) {
    const total = durations.get(row.key) ?? 0;
    row.meanMs = row.count > 0 ? Math.round(total / row.count) : 0;
  }
  return rankByCount(rows.values());
}

export function rollupCommands(files: readonly FileAggregate[]): RollupRow[] {
  const rows = new Rows();
  const sessions = new Map<string, Set<string>>();
  for (const file of files) {
    for (const bucket of Object.values(file.days)) {
      for (const [name, calls] of Object.entries(bucket.commands)) {
        rows.get(name).count += calls;
        const seen = sessions.get(name) ?? new Set<string>();
        seen.add(sessionKey(file));
        sessions.set(name, seen);
      }
    }
  }
  for (const row of rows.values()) row.sessions = sessions.get(row.key)?.size ?? 0;
  return rankByCount(rows.values());
}
