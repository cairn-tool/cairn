import fs from "node:fs";
import path from "node:path";
import type { DayBucket, FileAggregate, ParsedFile, TokenTotals, UsageEvent } from "../events.js";
import { addTokens, emptyBucket, emptyTokens, utcDay } from "../events.js";
import { loadSqlite } from "../../sqlite.js";
import type { SqliteDatabase, SqliteRow } from "../../sqlite.js";
import type {
  DiscoverOptions,
  ProviderEnvironment,
  TranscriptFile,
  UsageProvider,
} from "./types.js";

/**
 * OpenCode's session store.
 *
 * Everything lives in one SQLite database, `opencode.db`, alongside the CLI
 * logs and per-session diffs:
 *
 * ```
 * session(id, project_id, parent_id, directory, title, version, agent, model,
 *         cost, tokens_*, time_created, time_updated)
 * message(id, session_id, time_created, time_updated, data)          -- JSON
 * part(id, message_id, session_id, time_created, time_updated, data) -- JSON
 * ```
 *
 * **The same usage is recorded three times**: on the assistant `message`, again
 * on that message's `step-finish` `part`, and rolled up on the `session` row.
 * Measured against a real store, all three agree exactly and match OpenCode's
 * own `opencode stats`. Only the **message** grain is read. Summing message
 * tokens and step-finish tokens double-counts every figure precisely; the
 * session rollup is a cross-check rather than a source, and `part` rows are read
 * only for tool calls.
 *
 * The message grain is the right one twice over: a message that produced no
 * step-finish part still carries usage, and `message.id` is a primary key --
 * the same reason `claude-code.ts` deduplicates on `message.id` rather than on
 * anything anonymous.
 *
 * This is the second provider reading somebody else's live database, so it
 * follows the antigravity rules: open read-only through the **shared**
 * `loadSqlite()`, never a second loader, and treat every failure -- a missing
 * column, a renamed table, a runtime with no `node:sqlite` -- as an empty store
 * rather than an exception.
 */

const DATABASE = "opencode.db";

/** The synthetic shard every session is filed under; there is only one store. */
const SHARD = "session";

interface SessionRow {
  id: string;
  parentId: string | null;
  directory: string;
  title: string;
  version: string;
  /** Row-derived freshness key; see {@link readSessions}. */
  mtimeMs: number;
  /** Row-derived content fingerprint; see {@link readSessions}. */
  size: number;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/** An epoch-millisecond column as the ISO string every event carries. */
function isoAt(value: unknown): string | null {
  const ms = count(value);
  if (!ms) return null;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function parseJson(value: unknown): Record<string, unknown> | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function openDatabase(file: string): SqliteDatabase | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  try {
    // The URI form, because the store has live `-wal`/`-shm` sidecars and this
    // is somebody else's database: it is never opened for writing.
    return new sqlite.DatabaseSync(`file:${file}?mode=ro`, { readOnly: true });
  } catch {
    return null;
  }
}

function closeQuietly(db: SqliteDatabase): void {
  try {
    db.close();
  } catch {
    // Closing a read-only handle cannot lose anything.
  }
}

function query(db: SqliteDatabase, sql: string): SqliteRow[] {
  try {
    return db.prepare(sql).all();
  } catch {
    // A renamed column, or a table this version of OpenCode does not have,
    // costs exactly what it names rather than the whole provider.
    return [];
  }
}

/**
 * Every session, with a freshness key derived from its own rows.
 *
 * The store's file mtime is a single value shared by every session, so using it
 * would invalidate all of them on any write and force a full re-parse on every
 * scan. `session.time_updated` alone is not enough either -- it is measurably
 * stale against the messages beneath it -- so the key is the latest timestamp
 * anywhere in the session. `size` fingerprints the row counts, because
 * `isFresh` compares exactly the pair `(size, mtimeMs)` and neither half alone
 * catches every edit.
 */
function readSessions(db: SqliteDatabase): SessionRow[] {
  const updates = new Map<string, { ms: number; messages: number; parts: number }>();
  const bump = (id: string, ms: number, kind: "messages" | "parts"): void => {
    const entry = updates.get(id) ?? { ms: 0, messages: 0, parts: 0 };
    entry.ms = Math.max(entry.ms, ms);
    entry[kind] += 1;
    updates.set(id, entry);
  };
  for (const row of query(db, "SELECT session_id, time_updated FROM message"))
    bump(String(row.session_id), count(row.time_updated), "messages");
  for (const row of query(db, "SELECT session_id, time_updated FROM part"))
    bump(String(row.session_id), count(row.time_updated), "parts");

  const sessions: SessionRow[] = [];
  for (const row of query(db, "SELECT * FROM session")) {
    const id = text(row.id);
    if (!id) continue;
    const counts = updates.get(id) ?? { ms: 0, messages: 0, parts: 0 };
    sessions.push({
      id,
      parentId: text(row.parent_id),
      directory: text(row.directory) ?? "",
      title: text(row.title) ?? "",
      version: text(row.version) ?? "",
      mtimeMs: Math.max(count(row.time_updated), counts.ms),
      size: counts.messages * 1_000_000 + counts.parts,
    });
  }
  // Byte comparison, never localeCompare: the order must not depend on the ICU
  // build of the machine that ran the scan.
  sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sessions;
}

interface Store {
  /** The database's own `(mtime, size)`, so a stale memo is impossible. */
  key: string;
  parsed: Map<string, ParsedFile>;
}

/**
 * The whole store, parsed once and memoized.
 *
 * `scan.ts` calls `parse` through a worker pool, and SQLite declares no index
 * for these foreign keys, so a per-session `WHERE session_id = ?` would be a
 * full scan of `message` and `part` for every session. One pass builds every
 * aggregate instead. The memo holds a single entry, so a `--provider all` run
 * does not pin two stores in memory.
 */
let store: Store | null = null;

function storeKey(file: string): string {
  try {
    const stats = fs.statSync(file);
    // The path is part of the key, not just the stat: two stores can share a
    // size and an mtime, and the memo holds only one entry.
    return `${file}\u0000${stats.mtimeMs}\u0000${stats.size}`;
  } catch {
    return "";
  }
}

interface Building {
  aggregate: FileAggregate;
  events: UsageEvent[];
}

function bucketFor(building: Building, timestamp: string | null): DayBucket | null {
  if (!timestamp) return null;
  const day = utcDay(timestamp);
  if (!day) return null;
  const aggregate = building.aggregate;
  if (!aggregate.firstTs || timestamp < aggregate.firstTs) aggregate.firstTs = timestamp;
  if (!aggregate.lastTs || timestamp > aggregate.lastTs) aggregate.lastTs = timestamp;
  return (aggregate.days[day] ??= emptyBucket());
}

/**
 * One assistant message's usage.
 *
 * Unlike Codex and Gemini CLI, `cache.read` is a field of its own rather than
 * part of `input`, so nothing is subtracted here. `cost` is dropped: neither
 * `TokenTotals` nor `FileAggregate` has a place for it, and adding one is a
 * usage-store migration plus a contract change.
 */
function readUsage(tokens: Record<string, unknown>): TokenTotals {
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  return {
    input: count(tokens.input),
    output: count(tokens.output),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    thinking: count(tokens.reasoning),
    webSearch: 0,
    webFetch: 0,
    requests: 1,
  };
}

function applyMessages(db: SqliteDatabase, building: Map<string, Building>): void {
  for (const row of query(db, "SELECT session_id, data FROM message ORDER BY id")) {
    const target = building.get(String(row.session_id));
    const data = parseJson(row.data);
    if (!target || !data) continue;
    const time = data.time as Record<string, unknown> | undefined;
    const ts = isoAt(time?.created);
    const bucket = bucketFor(target, ts);
    if (!bucket || !ts) continue;

    if (data.role === "user") {
      bucket.prompts += 1;
      target.events.push({ ts, kind: "prompt" });
      continue;
    }
    if (data.role !== "assistant") continue;

    // A subagent session names its role on its own messages, which agrees with
    // the parent's `task` call and needs no cross-session join.
    const agent = text(data.agent);
    if (agent && target.aggregate.kind === "subagent" && !target.aggregate.agentType)
      target.aggregate.agentType = agent;

    const tokens = data.tokens as Record<string, unknown> | undefined;
    if (!tokens) continue;
    const provider = text(data.providerID);
    const model = text(data.modelID);
    // Two-part, because a bare model id collides across providers and the
    // rollup keys on this string.
    const name = provider && model ? `${provider}/${model}` : (model ?? "(unknown)");
    const totals = readUsage(tokens);
    addTokens((bucket.models[name] ??= emptyTokens()), totals);
    target.events.push({ ts, kind: "response", model: name, tokens: totals });
  }
}

function applyParts(db: SqliteDatabase, building: Map<string, Building>): void {
  for (const row of query(db, "SELECT session_id, time_created, data FROM part ORDER BY id")) {
    const target = building.get(String(row.session_id));
    const data = parseJson(row.data);
    // `step-finish` carries a copy of the message's usage and is deliberately
    // not read; see the note at the top of this module.
    if (!target || !data || data.type !== "tool") continue;
    const tool = text(data.tool);
    if (!tool) continue;
    const ts = isoAt(row.time_created) ?? target.aggregate.firstTs;
    const bucket = bucketFor(target, ts || null);
    if (!bucket) continue;

    bucket.tools[tool] = (bucket.tools[tool] ?? 0) + 1;
    target.events.push({ ts, kind: "tool_use", tool });

    const state = (data.state ?? {}) as Record<string, unknown>;
    if (tool === "task") {
      const input = (state.input ?? {}) as Record<string, unknown>;
      const role = text(input.subagent_type) ?? "(unrecorded)";
      const totals = (bucket.agents[role] ??= { count: 0, maxDepth: 0 });
      totals.count += 1;
      target.events.push({ ts, kind: "agent", name: role });
    }
    if (text(state.status) === "error") {
      bucket.errors += 1;
      target.events.push({ ts, kind: "error" });
    }
  }
}

function buildStore(file: string): Store {
  const parsed = new Map<string, ParsedFile>();
  const key = storeKey(file);
  const db = openDatabase(file);
  if (!db) return { key, parsed };

  try {
    const building = new Map<string, Building>();
    for (const session of readSessions(db)) {
      const aggregate: FileAggregate = {
        file,
        size: session.size,
        mtimeMs: session.mtimeMs,
        provider: opencodeProvider.name,
        sessionId: session.id,
        kind: session.parentId ? "subagent" : "main",
        project: session.directory,
        firstTs: "",
        lastTs: "",
        days: {},
        malformedLines: 0,
      };
      if (session.parentId) aggregate.parentSessionId = session.parentId;
      if (session.title) aggregate.title = session.title;
      if (session.version) aggregate.toolVersion = session.version;
      building.set(session.id, { aggregate, events: [] });
    }
    applyMessages(db, building);
    applyParts(db, building);
    for (const [id, target] of building)
      parsed.set(id, { aggregate: target.aggregate, events: target.events });
  } finally {
    closeQuietly(db);
  }
  return { key, parsed };
}

function loadStore(file: string): Store {
  const key = storeKey(file);
  if (store && store.key === key) return store;
  store = buildStore(file);
  return store;
}

export const opencodeProvider: UsageProvider = {
  name: "opencode",
  title: "OpenCode",
  source: "The session store at $XDG_DATA_HOME/opencode/opencode.db (default ~/.local/share)",
  capabilities: {
    tokens: true,
    // `tokens.cache.{read,write}` are named fields on every assistant message,
    // disjoint from `input` rather than contained in it.
    cacheTokens: true,
    tools: true,
    // OpenCode records no skill in the store: the part types are text,
    // reasoning, step-start, step-finish and tool, and none names one.
    skills: false,
    subagents: true,
    // Plugins can hook the session lifecycle, but no execution of one is
    // written to any table.
    hooks: false,
    // A tool part records a bare name with no server, so an MCP call cannot be
    // told from a builtin.
    mcp: false,
    // A command reaches the store only as the prompt text it expanded to.
    slashCommands: false,
    projects: true,
  },

  root(context: ProviderEnvironment): string | null {
    const xdg = context.env.XDG_DATA_HOME?.trim();
    const candidate =
      context.override?.trim() ||
      (xdg ? path.join(xdg, "opencode") : path.join(context.home, ".local", "share", "opencode"));
    try {
      return fs.statSync(path.join(candidate, DATABASE)).isFile() ? candidate : null;
    } catch {
      return null;
    }
  },

  /**
   * One entry per session, out of a store with no filesystem unit below itself.
   *
   * `FileAggregate` carries exactly one session id, kind, project and time
   * span, so collapsing the store into a single entry would destroy
   * `usage sessions`, `--last`, `--project`, and the main/subagent split. The
   * unit therefore has to be synthesized, and once it is, so does its freshness
   * key -- see {@link readSessions}.
   */
  discover(root: string, options: DiscoverOptions): TranscriptFile[] {
    const file = path.join(root, DATABASE);
    const db = openDatabase(file);
    if (!db) return [];
    let sessions: SessionRow[];
    try {
      sessions = readSessions(db);
    } finally {
      closeQuietly(db);
    }

    const found: TranscriptFile[] = [];
    for (const session of sessions) {
      // `parent_id` is on the row, so subagents are pruned before anything is
      // parsed -- the third provider that can, after claude-code and gemini-cli.
      if (!options.subagents && session.parentId) continue;
      if (options.modifiedSince !== undefined && session.mtimeMs < options.modifiedSince) continue;
      found.push({
        file,
        relative: `${SHARD}/${session.id}`,
        shard: SHARD,
        kind: session.parentId ? "subagent" : "main",
        size: session.size,
        mtimeMs: session.mtimeMs,
      });
    }
    found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return found;
  },

  async read(file: TranscriptFile): Promise<FileAggregate> {
    return (await opencodeProvider.parse(file)).aggregate;
  },

  async parse(file: TranscriptFile): Promise<ParsedFile> {
    const sessionId = file.relative.slice(`${SHARD}/`.length);
    const found = loadStore(file.file).parsed.get(sessionId);
    if (found) return found;
    // A session that vanished between discovery and parsing, or a store that
    // would not open. Neither is fatal: it reports as an empty transcript.
    return {
      aggregate: {
        file: file.file,
        size: file.size,
        mtimeMs: file.mtimeMs,
        provider: opencodeProvider.name,
        sessionId,
        kind: file.kind,
        project: "",
        firstTs: "",
        lastTs: "",
        days: {},
        malformedLines: 0,
      },
      events: [],
    };
  },
};
