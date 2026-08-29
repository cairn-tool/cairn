import os from "node:os";
import { terminate } from "../command-result.js";
import { BASE_FORMATS } from "../formats.js";
import { boundedInteger } from "../option-utils.js";
import { jsonPayload } from "../result.js";
import type { OutputFormat } from "../types.js";
import type { FileAggregate, TokenTotals, ToolKind } from "../usage/events.js";
import { TOOL_KINDS, totalTokens } from "../usage/events.js";
import type { ProjectSelector, Window } from "../usage/filter.js";
import { parseProject, resolveWindow } from "../usage/filter.js";
import { cacheStatus, clearCache, getUsageCacheRoot } from "../usage/index-cache.js";
import { DEFAULT_PROVIDER, PROVIDERS, resolveProvider } from "../usage/providers/index.js";
import type { UsageProvider } from "../usage/providers/types.js";
import type { ScanCounters, ScanFailure, ScanResult } from "../usage/scan.js";
import { scan } from "../usage/scan.js";
import type { RollupRow, SessionSort, TokenDimension, ToolDimension } from "../usage/aggregate.js";
import {
  SESSION_SORTS,
  TOKEN_DIMENSIONS,
  TOOL_DIMENSIONS,
  rollupAgents,
  rollupCommands,
  rollupHooks,
  rollupProjects,
  rollupSessions,
  rollupSkills,
  rollupTokens,
  rollupTools,
  summarize,
} from "../usage/aggregate.js";

export interface UsageOptions {
  format?: string;
  envelope?: boolean;
  provider?: string;
  project?: string[];
  since?: string;
  until?: string;
  last?: string;
  top?: string;
  logs?: string;
  /** Commander sets this false for `--no-subagents`. */
  subagents?: boolean;
  /** Commander sets this false for `--no-index`. */
  index?: boolean;
  strict?: boolean;
  /** `usage tokens` / `usage tools`. */
  by?: string;
  /** `usage tools`. */
  kind?: string;
  /** `usage sessions`. */
  sort?: string;
  /** `usage index`. */
  rebuild?: boolean;
  clear?: boolean;
}

/**
 * Formats are validated here rather than through `commandOptions`, which is
 * keyed on bare `md` subcommand names and whose error text says `md <command>`.
 * The `agent` and `scripts` subcommands validate inline for the same reason.
 *
 * `usage` is also deliberately absent from `COMMAND_OPTIONS`: it reports on logs
 * outside the workspace entirely, so a checked-in configuration file has no
 * business steering what it reads.
 */
function resolveFormat(opts: UsageOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) {
    throw new Error(`Invalid output format: ${String(opts.format)}`);
  }
  if (opts.envelope && format !== "json") {
    throw new Error("--envelope requires --format json");
  }
  return format;
}

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${flag} value: ${value} (expected ${allowed.join(", ")})`);
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface Scope {
  provider: UsageProvider;
  root: string;
  window: Window;
  selectors: ProjectSelector[];
  subagents: boolean;
  last: number | null;
  useIndex: boolean;
}

interface ScopePayload {
  provider: string;
  root: string;
  window: { since: string | null; until: string | null };
  projects: string[];
  subagents: boolean;
  last: number | null;
  index: boolean;
}

function requireRoot(provider: UsageProvider, opts: UsageOptions): string {
  const root = provider.root({
    env: process.env,
    home: os.homedir(),
    ...(opts.logs ? { override: opts.logs } : {}),
  });
  if (!root) {
    throw new Error(
      `No ${provider.title} logs found. ${provider.source}. Pass --logs <dir> to point at them explicitly.`,
    );
  }
  return root;
}

function resolveScope(opts: UsageOptions): Scope {
  const provider = resolveProvider(opts.provider);
  const last = opts.last === undefined ? null : boundedInteger(opts.last, "last");
  return {
    provider,
    root: requireRoot(provider, opts),
    window: resolveWindow(opts.since, opts.until),
    selectors: (opts.project ?? []).map((value) => parseProject(value)),
    subagents: opts.subagents !== false,
    last,
    useIndex: opts.index !== false,
  };
}

function scopePayload(scope: Scope): ScopePayload {
  return {
    provider: scope.provider.name,
    root: scope.root,
    window: { since: scope.window.since, until: scope.window.until },
    projects: scope.selectors.map((selector) => selector.raw),
    subagents: scope.subagents,
    last: scope.last,
    index: scope.useIndex,
  };
}

async function collect(scope: Scope): Promise<ScanResult> {
  return scan({
    provider: scope.provider,
    root: scope.root,
    subagents: scope.subagents,
    window: scope.window,
    projects: scope.selectors,
    ...(scope.last !== null ? { last: scope.last } : {}),
    useIndex: scope.useIndex,
  });
}

/**
 * A report over thousands of transcripts is expected to meet a few it cannot
 * read: a file removed mid-scan, a truncated final line in a session still being
 * written. Those are counted and reported, never fatal, because blocking on them
 * by default would make the command useless in exactly the automated context
 * where it is most wanted. `--strict` is how a caller opts into caring.
 */
function decideExit(counters: ScanCounters, failures: ScanFailure[], strict: boolean): 0 | 2 {
  if (!strict) return 0;
  return counters.skipped > 0 || counters.malformed > 0 || failures.length > 0 ? 2 : 0;
}

function scanPayload(result: ScanResult) {
  return { ...result.counters, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function style(text: string, code: string, human: boolean): string {
  return human ? `${code}${text}${RESET}` : text;
}

/** Human output abbreviates; llm output stays exact so a consumer can do arithmetic. */
function num(value: number, human: boolean): string {
  if (!human) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

interface Column {
  header: string;
  right?: boolean;
}

function table(columns: Column[], rows: string[][], human: boolean): string[] {
  if (rows.length === 0) return [];
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const pad = (text: string, index: number): string =>
    columns[index].right ? text.padStart(widths[index]) : text.padEnd(widths[index]);
  const lines = [
    style(
      columns.map((column, index) => pad(column.header, index)).join("  "),
      BOLD,
      human,
    ).trimEnd(),
  ];
  for (const row of rows) {
    lines.push(
      columns
        .map((_, index) => pad(row[index] ?? "", index))
        .join("  ")
        .trimEnd(),
    );
  }
  return lines;
}

function scanLine(result: ScanResult, human: boolean): string {
  const { discovered, cached, parsed, skipped, malformed } = result.counters;
  const parts = [
    `${discovered} transcript${discovered === 1 ? "" : "s"}`,
    `${cached} cached`,
    `${parsed} parsed`,
  ];
  if (skipped > 0) parts.push(`${skipped} unreadable`);
  if (malformed > 0) parts.push(`${malformed} malformed line${malformed === 1 ? "" : "s"}`);
  return style(parts.join(", "), DIM, human);
}

function windowLine(scope: Scope, human: boolean): string {
  const since = scope.window.since ?? "beginning";
  const until = scope.window.until ?? "now";
  const projects =
    scope.selectors.length > 0 ? `, projects: ${scope.selectors.map((s) => s.raw).join(", ")}` : "";
  const subagents = scope.subagents ? "" : ", subagents excluded";
  return style(`${since} → ${until}${projects}${subagents}`, DIM, human);
}

function write(lines: string[], exitCode: 0 | 2): void {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(lines.join("\n") + "\n");
  if (exitCode !== 0) terminate(exitCode);
}

// ---------------------------------------------------------------------------
// Rollup plumbing shared by every tabular subcommand
// ---------------------------------------------------------------------------

interface RollupPayload {
  provider: string;
  scope: ScopePayload;
  dimension: string;
  rows: RollupRow[];
  /** True when `--top` clipped the listing; `totals` still covers everything. */
  truncated: boolean;
  totals: { rows: number; count: number; tokens: TokenTotals };
  scan: ReturnType<typeof scanPayload>;
}

function totalsOfRows(rows: readonly RollupRow[]): RollupPayload["totals"] {
  const tokens: TokenTotals = {
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
  let count = 0;
  for (const row of rows) {
    count += row.count;
    if (!row.tokens) continue;
    tokens.input += row.tokens.input;
    tokens.output += row.tokens.output;
    tokens.cacheRead += row.tokens.cacheRead;
    tokens.cacheWrite += row.tokens.cacheWrite;
    tokens.cacheWrite5m += row.tokens.cacheWrite5m;
    tokens.cacheWrite1h += row.tokens.cacheWrite1h;
    tokens.thinking += row.tokens.thinking;
    tokens.webSearch += row.tokens.webSearch;
    tokens.webFetch += row.tokens.webFetch;
    tokens.requests += row.tokens.requests;
  }
  return { rows: rows.length, count, tokens };
}

function clip(rows: RollupRow[], opts: UsageOptions): { rows: RollupRow[]; truncated: boolean } {
  const top = opts.top === undefined ? 20 : boundedInteger(opts.top, "top");
  if (top === 0 || rows.length <= top) return { rows, truncated: false };
  return { rows: rows.slice(0, top), truncated: true };
}

/** Every tabular subcommand funnels through here so they share one payload shape. */
async function emitRollup(
  command: string,
  dimension: string,
  build: (files: readonly FileAggregate[]) => RollupRow[],
  render: (rows: readonly RollupRow[], human: boolean) => string[],
  opts: UsageOptions,
): Promise<void> {
  const format = resolveFormat(opts);
  const scope = resolveScope(opts);
  const result = await collect(scope);
  const all = build(result.files);
  const { rows, truncated } = clip(all, opts);
  const exitCode = decideExit(result.counters, result.failures, Boolean(opts.strict));

  const payload: RollupPayload = {
    provider: scope.provider.name,
    scope: scopePayload(scope),
    dimension,
    rows,
    truncated,
    totals: totalsOfRows(all),
    scan: scanPayload(result),
  };

  if (format === "json") {
    const output = jsonPayload(command, payload, opts, {
      exitCode,
      summary: { rows: all.length, transcripts: result.counters.discovered },
    });
    (exitCode === 0 ? process.stdout : process.stderr).write(output);
    if (exitCode !== 0) terminate(exitCode);
    return;
  }

  const human = format === "human";
  const lines = [windowLine(scope, human)];
  if (rows.length === 0) lines.push("No matching activity.");
  else lines.push(...render(rows, human));
  if (truncated) {
    lines.push(style(`… ${all.length - rows.length} more (use --top 0 for all)`, DIM, human));
  }
  lines.push(scanLine(result, human));
  write(lines, exitCode);
}

const TOKEN_COLUMNS: Column[] = [
  { header: "key" },
  { header: "requests", right: true },
  { header: "input", right: true },
  { header: "output", right: true },
  { header: "cache-r", right: true },
  { header: "cache-w", right: true },
  { header: "total", right: true },
];

function tokenRows(rows: readonly RollupRow[], human: boolean): string[][] {
  return rows.map((row) => {
    const tokens = row.tokens;
    return [
      row.key,
      num(row.count, human),
      num(tokens?.input ?? 0, human),
      num(tokens?.output ?? 0, human),
      num(tokens?.cacheRead ?? 0, human),
      num(tokens?.cacheWrite ?? 0, human),
      num(tokens ? totalTokens(tokens) : 0, human),
    ];
  });
}

// ---------------------------------------------------------------------------
// usage summary
// ---------------------------------------------------------------------------

export async function usageSummaryAction(opts: UsageOptions): Promise<void> {
  const format = resolveFormat(opts);
  const scope = resolveScope(opts);
  const result = await collect(scope);
  const summary = summarize(result.files);
  const exitCode = decideExit(result.counters, result.failures, Boolean(opts.strict));

  const payload = {
    provider: scope.provider.name,
    scope: scopePayload(scope),
    summary: {
      ...summary,
      models: summary.models.slice(0, 10),
      tools: summary.tools.slice(0, 10),
    },
    scan: scanPayload(result),
  };

  if (format === "json") {
    const output = jsonPayload("usage summary", payload, opts, {
      exitCode,
      summary: { sessions: summary.sessions, tokens: totalTokens(summary.tokens) },
    });
    (exitCode === 0 ? process.stdout : process.stderr).write(output);
    if (exitCode !== 0) terminate(exitCode);
    return;
  }

  const human = format === "human";
  const lines = [windowLine(scope, human)];
  const span =
    summary.firstDay && summary.lastDay
      ? `${summary.firstDay} → ${summary.lastDay} (${summary.days} active day${summary.days === 1 ? "" : "s"})`
      : "no activity";

  lines.push("");
  lines.push(style("Activity", BOLD, human));
  lines.push(
    ...table(
      [{ header: "metric" }, { header: "value", right: true }],
      [
        ["span", span],
        ["sessions", num(summary.sessions, human)],
        [
          "transcripts",
          `${num(summary.transcripts, human)} (${num(summary.subagentTranscripts, human)} subagent)`,
        ],
        ["projects", num(summary.projects, human)],
        ["prompts", num(summary.prompts, human)],
        ["requests", num(summary.tokens.requests, human)],
        ["compactions", num(summary.compactions, human)],
        ["api errors", num(summary.errors, human)],
      ],
      human,
    ),
  );

  lines.push("");
  lines.push(style("Tokens", BOLD, human));
  lines.push(
    ...table(
      [{ header: "class" }, { header: "tokens", right: true }],
      [
        ["input", num(summary.tokens.input, human)],
        ["output", num(summary.tokens.output, human)],
        ["  of which thinking", num(summary.tokens.thinking, human)],
        ["cache read", num(summary.tokens.cacheRead, human)],
        ["cache write", num(summary.tokens.cacheWrite, human)],
        ["  5m ttl", num(summary.tokens.cacheWrite5m, human)],
        ["  1h ttl", num(summary.tokens.cacheWrite1h, human)],
        ["total", num(totalTokens(summary.tokens), human)],
        ["  main", num(totalTokens(summary.tokensByKind.main), human)],
        ["  subagent", num(totalTokens(summary.tokensByKind.subagent), human)],
      ],
      human,
    ),
  );

  if (summary.models.length > 0) {
    lines.push("");
    lines.push(style("Models", BOLD, human));
    lines.push(...table(TOKEN_COLUMNS, tokenRows(summary.models.slice(0, 10), human), human));
  }

  if (summary.tools.length > 0) {
    lines.push("");
    lines.push(style("Top tools", BOLD, human));
    lines.push(
      ...table(
        [{ header: "tool" }, { header: "kind" }, { header: "calls", right: true }],
        summary.tools.slice(0, 10).map((row) => [row.key, row.kind ?? "", num(row.count, human)]),
        human,
      ),
    );
  }

  lines.push("");
  lines.push(style("Features", BOLD, human));
  lines.push(
    ...table(
      [{ header: "feature" }, { header: "count", right: true }],
      [
        ["skill invocations", num(summary.features.skills, human)],
        ["subagents spawned", num(summary.features.subagents, human)],
        ["hook executions", num(summary.features.hooks, human)],
        ["  failures", num(summary.features.hookFailures, human)],
        ["mcp tool calls", num(summary.features.mcpCalls, human)],
        ["slash commands", num(summary.features.slashCommands, human)],
      ],
      human,
    ),
  );

  lines.push("");
  lines.push(scanLine(result, human));
  write(lines, exitCode);
}

// ---------------------------------------------------------------------------
// Tabular subcommands
// ---------------------------------------------------------------------------

export async function usageTokensAction(opts: UsageOptions): Promise<void> {
  const dimension = choice<TokenDimension>(opts.by, TOKEN_DIMENSIONS, "--by", "model");
  await emitRollup(
    "usage tokens",
    dimension,
    (files) => rollupTokens(files, dimension),
    (rows, human) => table(TOKEN_COLUMNS, tokenRows(rows, human), human),
    opts,
  );
}

export async function usageToolsAction(opts: UsageOptions): Promise<void> {
  const dimension = choice<ToolDimension>(opts.by, TOOL_DIMENSIONS, "--by", "name");
  const kind =
    opts.kind === undefined
      ? undefined
      : choice<ToolKind>(opts.kind, TOOL_KINDS, "--kind", "builtin");
  await emitRollup(
    "usage tools",
    dimension,
    (files) => rollupTools(files, dimension, kind),
    (rows, human) =>
      table(
        dimension === "name"
          ? [
              { header: "tool" },
              { header: "kind" },
              { header: "server" },
              { header: "calls", right: true },
            ]
          : [{ header: dimension }, { header: "calls", right: true }],
        rows.map((row) =>
          dimension === "name"
            ? [row.key, row.kind ?? "", row.server ?? "", num(row.count, human)]
            : [row.key, num(row.count, human)],
        ),
        human,
      ),
    opts,
  );
}

export async function usageSessionsAction(opts: UsageOptions): Promise<void> {
  const sort = choice<SessionSort>(opts.sort, SESSION_SORTS, "--sort", "recent");
  await emitRollup(
    "usage sessions",
    "session",
    (files) => rollupSessions(files, sort),
    (rows, human) =>
      table(
        [
          { header: "session" },
          { header: "last" },
          { header: "project" },
          { header: "tokens", right: true },
          { header: "tools", right: true },
          { header: "sub", right: true },
          { header: "duration", right: true },
          { header: "title" },
        ],
        rows.map((row) => [
          row.key.slice(0, 8),
          (row.lastTs ?? "").slice(0, 16).replace("T", " "),
          row.project ? (row.project.split("/").pop() ?? "") : "",
          num(row.tokens ? totalTokens(row.tokens) : 0, human),
          num(row.toolCalls ?? 0, human),
          num(row.subagents ?? 0, human),
          duration(row.durationMs ?? 0),
          row.title ?? "",
        ]),
        human,
      ),
    opts,
  );
}

export async function usageProjectsAction(opts: UsageOptions): Promise<void> {
  await emitRollup(
    "usage projects",
    "project",
    (files) => rollupProjects(files),
    (rows, human) =>
      table(
        [
          { header: "project" },
          { header: "sessions", right: true },
          { header: "requests", right: true },
          { header: "tools", right: true },
          { header: "tokens", right: true },
        ],
        rows.map((row) => [
          row.key,
          num(row.sessions ?? 0, human),
          num(row.count, human),
          num(row.toolCalls ?? 0, human),
          num(row.tokens ? totalTokens(row.tokens) : 0, human),
        ]),
        human,
      ),
    opts,
  );
}

export async function usageSkillsAction(opts: UsageOptions): Promise<void> {
  await emitRollup(
    "usage skills",
    "skill",
    (files) => rollupSkills(files),
    (rows, human) =>
      table(
        [
          { header: "skill" },
          { header: "invocations", right: true },
          { header: "sessions", right: true },
        ],
        rows.map((row) => [row.key, num(row.count, human), num(row.sessions ?? 0, human)]),
        human,
      ),
    opts,
  );
}

export async function usageAgentsAction(opts: UsageOptions): Promise<void> {
  await emitRollup(
    "usage agents",
    "agent",
    (files) => rollupAgents(files),
    (rows, human) =>
      table(
        [
          { header: "agent" },
          { header: "spawns", right: true },
          { header: "transcripts", right: true },
          { header: "depth", right: true },
          { header: "tools", right: true },
          { header: "tokens", right: true },
        ],
        rows.map((row) => [
          row.key,
          num(row.count, human),
          num(row.sessions ?? 0, human),
          num(row.maxDepth ?? 0, human),
          num(row.toolCalls ?? 0, human),
          num(row.tokens ? totalTokens(row.tokens) : 0, human),
        ]),
        human,
      ),
    opts,
  );
}

export async function usageHooksAction(opts: UsageOptions): Promise<void> {
  await emitRollup(
    "usage hooks",
    "hook",
    (files) => rollupHooks(files),
    (rows, human) =>
      table(
        [
          { header: "hook" },
          { header: "runs", right: true },
          { header: "failures", right: true },
          { header: "cancelled", right: true },
          { header: "mean", right: true },
          { header: "max", right: true },
        ],
        rows.map((row) => [
          row.key,
          num(row.count, human),
          style(num(row.failures ?? 0, human), (row.failures ?? 0) > 0 ? RED : RESET, human),
          num(row.cancelled ?? 0, human),
          duration(row.meanMs ?? 0),
          duration(row.maxMs ?? 0),
        ]),
        human,
      ),
    opts,
  );
}

export async function usageCommandsAction(opts: UsageOptions): Promise<void> {
  await emitRollup(
    "usage commands",
    "command",
    (files) => rollupCommands(files),
    (rows, human) =>
      table(
        [
          { header: "command" },
          { header: "uses", right: true },
          { header: "sessions", right: true },
        ],
        rows.map((row) => [row.key, num(row.count, human), num(row.sessions ?? 0, human)]),
        human,
      ),
    opts,
  );
}

// ---------------------------------------------------------------------------
// usage providers
// ---------------------------------------------------------------------------

export async function usageProvidersAction(opts: UsageOptions): Promise<void> {
  const format = resolveFormat(opts);
  const providers = PROVIDERS.map((provider) => {
    const root = provider.root({
      env: process.env,
      home: os.homedir(),
      ...(opts.logs ? { override: opts.logs } : {}),
    });
    return {
      name: provider.name,
      title: provider.title,
      source: provider.source,
      default: provider.name === DEFAULT_PROVIDER,
      available: root !== null,
      root,
      capabilities: provider.capabilities,
    };
  });

  const payload = { providers };

  if (format === "json") {
    process.stdout.write(
      jsonPayload("usage providers", payload, opts, {
        summary: { providers: providers.length },
      }),
    );
    return;
  }

  const human = format === "human";
  const lines = table(
    [
      { header: "provider" },
      { header: "available" },
      { header: "root" },
      { header: "capabilities" },
    ],
    providers.map((provider) => [
      provider.default ? `${provider.name} (default)` : provider.name,
      provider.available ? "yes" : "no",
      provider.root ?? "—",
      Object.entries(provider.capabilities)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .join(","),
    ]),
    human,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// usage index
// ---------------------------------------------------------------------------

export async function usageIndexAction(opts: UsageOptions): Promise<void> {
  const format = resolveFormat(opts);
  const provider = resolveProvider(opts.provider);
  const root = getUsageCacheRoot(provider.name);

  if (opts.clear && opts.rebuild) {
    throw new Error("--clear and --rebuild are mutually exclusive");
  }

  let action: "status" | "rebuild" | "clear" = "status";
  let removed = 0;
  let scanned: ScanResult | null = null;

  if (opts.clear) {
    action = "clear";
    removed = clearCache(root);
  } else if (opts.rebuild) {
    action = "rebuild";
    const scope = resolveScope({ ...opts, index: true });
    scanned = await scan({
      provider: scope.provider,
      root: scope.root,
      subagents: scope.subagents,
      window: scope.window,
      projects: scope.selectors,
      useIndex: true,
      rebuild: true,
    });
  }

  const cache = cacheStatus(root);
  const payload = {
    provider: provider.name,
    action,
    cache,
    ...(action === "clear" ? { removed } : {}),
    ...(scanned ? { scan: scanPayload(scanned) } : {}),
  };

  if (format === "json") {
    process.stdout.write(
      jsonPayload("usage index", payload, opts, {
        summary: { entries: cache.entries, shards: cache.shards },
      }),
    );
    return;
  }

  const human = format === "human";
  const lines = [
    `${style("cache", BOLD, human)}  ${style(root, CYAN, human)}`,
    `  present:    ${cache.present ? "yes" : "no"}`,
    `  shards:     ${cache.shards}`,
    `  transcripts:${String(cache.entries).padStart(2)}`,
    `  size:       ${num(cache.bytes, human)} bytes`,
    `  updated:    ${cache.updatedAt ?? "never"}`,
  ];
  if (action === "clear") lines.push(`  removed:    ${removed} shard${removed === 1 ? "" : "s"}`);
  if (scanned) lines.push(`  rebuilt:    ${scanLine(scanned, human)}`);
  process.stdout.write(lines.join("\n") + "\n");
}
