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
 * Cursor's editor store.
 *
 * Everything is one SQLite database inside the Electron user-data directory:
 *
 * ```
 * User/globalStorage/state.vscdb
 *   ItemTable(key, value)        -- settings, and the legacy conversation index
 *   cursorDiskKV(key, value)     -- the corpus, keyed by prefix
 *   composerHeaders(composerId, workspaceId, createdAt, lastUpdatedAt,
 *                   isArchived, isSubagent, recency, checkpointAt, value)
 * ```
 *
 * A conversation is a *composer*, and `composerId` joins every prefix:
 * `composerData:<id>` is the conversation, `bubbleId:<id>:<bubbleId>` its turns.
 *
 * **Cursor stopped writing token counters.** `bubbleId` records carry
 * `tokenCount.{inputTokens,outputTokens}`, and those are genuine per-request
 * figures -- but on a real corpus every nonzero one falls between 2025-06-17 and
 * 2025-12-23. Newer conversations carry the field with zeroes in it and settle
 * usage server-side, behind each bubble's `usageUuid`. So this provider reports
 * real tokens for the window Cursor wrote them and zero afterwards, which is a
 * fact about the host rather than a gap in the parser. See
 * `docs/providers/cursor/usage-logs.md`.
 *
 * The schema has only ever had `inputTokens` and `outputTokens`: there is no
 * cache, reasoning, or web-tool breakdown to read, hence `cacheTokens: false`.
 *
 * `contextTokensUsed` is deliberately **not** read. It is the size of the most
 * recent turn's context, overwritten every turn and excluding output, so it can
 * be neither summed (like Antigravity's) nor differenced (like Codex's). It is
 * the one figure here that would have no defensible interpretation.
 *
 * This is the third provider reading somebody else's live database, so it
 * follows the rules the other two set: open read-only through the **shared**
 * `loadSqlite()`, never a second loader, and treat every failure -- a missing
 * table, a renamed column, a runtime with no `node:sqlite` -- as an empty store
 * rather than an exception.
 */

const STORE = path.join("User", "globalStorage", "state.vscdb");

/** The synthetic shard every conversation is filed under; there is one store. */
const SHARD = "composer";

/** `ItemTable` key holding the pre-`composerHeaders` conversation index. */
const LEGACY_INDEX = "composer.composerHeaders";

/**
 * Prefix bounds for a `cursorDiskKV` key range.
 *
 * `;` is `:` plus one, so `[<prefix>:, <prefix>;)` is exactly the keys under a
 * prefix. A range comparison uses the UNIQUE index on `key` unambiguously; the
 * table holds roughly 450k rows and 5 GB of values, and an unconstrained scan of
 * it is minutes rather than milliseconds.
 */
function prefixRange(prefix: string): [string, string] {
  return [`${prefix}:`, `${prefix};`];
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function query(db: SqliteDatabase, sql: string, ...parameters: unknown[]): SqliteRow[] {
  try {
    return db.prepare(sql).all(...parameters);
  } catch {
    // A renamed column, or a table this version of Cursor does not have, costs
    // exactly what it names rather than the whole provider. `composerHeaders`
    // is itself recent, and older stores keep that index in `ItemTable`.
    return [];
  }
}

/** One conversation, as the cheap index describes it before any turn is read. */
interface Conversation {
  id: string;
  /** Epoch ms. Every day bucket in the conversation is anchored here. */
  createdAt: number;
  lastUpdatedAt: number;
  /** Turn count; the content half of the freshness key. See {@link readIndex}. */
  bubbles: number;
  kind: "main" | "subagent";
  parentId: string | null;
  agentType: string | null;
  agentPath: string | null;
  project: string;
  title: string | null;
  model: string | null;
}

function blank(id: string): Conversation {
  return {
    id,
    createdAt: 0,
    lastUpdatedAt: 0,
    bubbles: 0,
    kind: "main",
    parentId: null,
    agentType: null,
    agentPath: null,
    project: "",
    title: null,
    model: null,
  };
}

/**
 * The absolute working directory a conversation ran in.
 *
 * `workspaceIdentifier.uri.fsPath` is carried inside the store itself, so
 * project identity never depends on reading `User/workspaceStorage/<id>/`, and
 * never on the `~/.cursor/projects/<slug>` directory names -- those replace both
 * separators and dots and are lossy in both directions, the same trap
 * `claude-code.ts` documents for its own slugs.
 *
 * A multi-root window carries `configPath` instead, naming a `.code-workspace`
 * document rather than a directory. That is several folders, and a
 * `FileAggregate` has exactly one `project`, so it is left unset rather than
 * having one of them picked arbitrarily.
 */
function projectOf(identifier: Record<string, unknown> | null): string {
  const uri = record(identifier?.uri);
  return text(uri?.fsPath) ?? text(uri?.path) ?? "";
}

/** Fills in whatever a conversation-index entry knows. */
function applyIdentity(into: Conversation, entry: Record<string, unknown>): void {
  const identifier = record(entry.workspaceIdentifier);
  if (identifier && !into.project) into.project = projectOf(identifier);
  if (!into.title) into.title = text(entry.name);
  into.createdAt ||= count(entry.createdAt);
  into.lastUpdatedAt = Math.max(into.lastUpdatedAt, count(entry.lastUpdatedAt));

  const subagent = record(entry.subagentInfo);
  if (!subagent) return;
  into.kind = "subagent";
  into.parentId ??= text(subagent.parentComposerId) ?? text(subagent.rootParentConversationId);
  // The reusable role, and the task-specific id for this one run -- the same
  // split Codex records as `agent_role` and `agent_path`.
  into.agentType ??= text(subagent.subagentTypeName);
  into.agentPath ??= text(subagent.toolCallId);
}

/**
 * Every conversation in the store, with a freshness key derived from its rows.
 *
 * **Discovery is over `composerData:` keys, not the `composerHeaders` table.**
 * That table is recent and holds only the conversations Cursor has migrated into
 * it: on a real corpus it names 1,023 of 1,616 conversations, and 161 of the 229
 * that carry token counters are absent from it *and* from the legacy
 * `ItemTable` index beside it -- 61% of all the tokens on this machine. Both
 * indexes are therefore read only to *enrich* a conversation with the identity
 * they alone carry (workspace, subagent role), never to decide it exists.
 *
 * The freshness key has to be synthesized for the same reason OpenCode's does:
 * the file's mtime is one value shared by every conversation, so any write would
 * invalidate all of them and force a full re-parse on every scan. `mtimeMs` is
 * the latest timestamp the conversation carries and `bubbles` fingerprints its
 * turn count, because `isFresh` compares exactly the pair `(size, mtimeMs)` and
 * neither half alone catches every edit.
 */
function readIndex(db: SqliteDatabase): Map<string, Conversation> {
  const conversations = new Map<string, Conversation>();
  const at = (id: string): Conversation => {
    let found = conversations.get(id);
    if (!found) conversations.set(id, (found = blank(id)));
    return found;
  };

  const [dataLow, dataHigh] = prefixRange("composerData");
  for (const row of query(
    db,
    `SELECT substr(key, ?) AS id,
            json_extract(value, '$.createdAt')            AS created,
            json_extract(value, '$.lastUpdatedAt')        AS updated,
            json_extract(value, '$.modelConfig.modelName') AS model,
            json_extract(value, '$.usageData')            AS usage,
            json_extract(value, '$.name')                 AS name,
            json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS project
       FROM cursorDiskKV WHERE key >= ? AND key < ?`,
    dataLow.length + 1,
    dataLow,
    dataHigh,
  )) {
    const id = text(row.id);
    if (!id) continue;
    const conversation = at(id);
    conversation.createdAt = count(row.created);
    conversation.lastUpdatedAt = count(row.updated);
    conversation.title = text(row.name);
    // The conversation carries its own workspace on about a fifth of rows, and
    // is the only source of one for a conversation neither index knows about.
    conversation.project = text(row.project) ?? "";
    // `modelConfig` postdates the token era, so the legacy `usageData` map is
    // the fallback -- but only when it names exactly one model, since a
    // conversation that used several cannot attribute a bubble to one of them.
    conversation.model = text(row.model) ?? soleModel(row.usage);
  }

  // Turn counts, index-only: nothing but `key` is touched, so this reads the
  // UNIQUE index rather than 1.3 GB of turn bodies.
  const [bubbleLow, bubbleHigh] = prefixRange("bubbleId");
  for (const row of query(
    db,
    `SELECT substr(key, ?, instr(substr(key, ?), ':') - 1) AS id, count(*) AS turns
       FROM cursorDiskKV WHERE key >= ? AND key < ? GROUP BY id`,
    bubbleLow.length + 1,
    bubbleLow.length + 1,
    bubbleLow,
    bubbleHigh,
  )) {
    const id = text(row.id);
    if (!id) continue;
    at(id).bubbles = count(row.turns);
  }

  for (const row of query(
    db,
    "SELECT composerId, isSubagent, createdAt, lastUpdatedAt, value FROM composerHeaders",
  )) {
    const id = text(row.composerId);
    if (!id) continue;
    const conversation = at(id);
    if (count(row.isSubagent) === 1) conversation.kind = "subagent";
    conversation.createdAt ||= count(row.createdAt);
    conversation.lastUpdatedAt = Math.max(conversation.lastUpdatedAt, count(row.lastUpdatedAt));
    const entry = parseJson(row.value);
    if (entry) applyIdentity(conversation, entry);
  }

  for (const entry of legacyIndex(db)) {
    const id = text(entry.composerId);
    if (!id) continue;
    applyIdentity(at(id), entry);
  }

  return conversations;
}

/**
 * The pre-`composerHeaders` conversation index, a JSON blob in `ItemTable`.
 *
 * Cursor gates the table by a separate `composer.composerHeaders.tableGateEnabled`
 * flag and did not backfill it, so both live side by side and both are read.
 */
function legacyIndex(db: SqliteDatabase): Array<Record<string, unknown>> {
  const rows = query(db, "SELECT value FROM ItemTable WHERE key = ?", LEGACY_INDEX);
  const blob = parseJson(rows[0]?.value);
  const all = blob?.allComposers;
  if (!Array.isArray(all)) return [];
  return all.filter((entry): entry is Record<string, unknown> => record(entry) !== null);
}

/** The single model a legacy `usageData` map names, or null when it names 0 or 2+. */
function soleModel(value: unknown): string | null {
  const usage = parseJson(value);
  if (!usage) return null;
  const names = Object.keys(usage);
  return names.length === 1 ? names[0] : null;
}

/** Cursor's own subagent-spawning builtin, the counterpart of OpenCode's `task`. */
const SPAWN_TOOL = "task_v2";

/**
 * Cursor's flattened MCP tool name, in the form `classifyTool` understands.
 *
 * A call is recorded as `mcp-<server>-<tool>`, and on a real corpus the server
 * half is sometimes repeated (`mcp-cursor-ide-browser-cursor-ide-browser-browser_lock`)
 * while the separator also occurs inside both halves. So an MCP call can be told
 * apart from a builtin, which is why `mcp` is a declared capability here and not
 * for OpenCode or Gemini CLI, whose tool records name no server at all. But the
 * boundary within the remainder is not recoverable. Rewriting to `mcp__<rest>`
 * with no second separator makes `classifyTool` report `kind: "mcp"` with the
 * whole flattened name as the server, which is exactly as much as is known.
 */
function normalizeTool(name: string): string {
  if (!name.startsWith("mcp-")) return name;
  const rest = name.slice("mcp-".length);
  return rest ? `mcp__${rest}` : name;
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
 * One turn's token counters.
 *
 * Only `input` and `output` are ever populated: no other counter has existed in
 * this schema. A caller only reaches here for a turn whose counters are nonzero.
 */
function readUsage(input: number, output: number): TokenTotals {
  const totals = emptyTokens();
  totals.input = input;
  totals.output = output;
  totals.requests = 1;
  return totals;
}

/**
 * One conversation's turns.
 *
 * The projection is done in SQL rather than in JavaScript on purpose: a turn
 * body averages 9 KB and the corpus holds 1.3 GB of them, so selecting `value`
 * and picking fields off it here would move a whole conversation across the
 * boundary in order to read seven scalars.
 */
function applyBubbles(
  db: SqliteDatabase,
  conversation: Conversation,
  roles: ReadonlyMap<string, string>,
  building: Building,
): void {
  const [low, high] = prefixRange(`bubbleId:${conversation.id}`);
  const fallback = isoAt(conversation.createdAt);
  const model = conversation.model ?? "(unknown)";

  for (const row of query(
    db,
    `SELECT json_extract(value, '$.type')                         AS kind,
            json_extract(value, '$.tokenCount.inputTokens')       AS input,
            json_extract(value, '$.tokenCount.outputTokens')      AS output,
            json_extract(value, '$.timingInfo.clientRpcSendTime') AS ts,
            json_extract(value, '$.toolFormerData.name')          AS tool,
            json_extract(value, '$.toolFormerData.status')        AS status,
            json_extract(value, '$.toolFormerData.toolCallId')    AS call
       FROM cursorDiskKV WHERE key >= ? AND key < ?`,
    low,
    high,
  )) {
    // All but a fraction of a percent of turns carry no timestamp of their own,
    // so the conversation's creation instant is the anchor. Day rollups are
    // therefore per conversation rather than per turn: coarser than every other
    // provider, and documented as such.
    const ts = isoAt(row.ts) ?? fallback;
    const bucket = bucketFor(building, ts);
    if (!bucket || !ts) continue;

    if (count(row.kind) === 1) {
      bucket.prompts += 1;
      building.events.push({ ts, kind: "prompt" });
    }

    const input = count(row.input);
    const output = count(row.output);
    // A turn whose counters are absent or all zero emits no response at all.
    // Every turn after 2025 is one of those, and counting them would report a
    // request against no tokens, the same suppression `codex.ts` applies to a
    // zero delta.
    if (input > 0 || output > 0) {
      const totals = readUsage(input, output);
      addTokens((bucket.models[model] ??= emptyTokens()), totals);
      building.events.push({ ts, kind: "response", model, tokens: totals });
    }

    const tool = text(row.tool);
    if (!tool) continue;
    const name = normalizeTool(tool);
    bucket.tools[name] = (bucket.tools[name] ?? 0) + 1;
    building.events.push({ ts, kind: "tool_use", tool: name });

    if (tool === SPAWN_TOOL) {
      // The parent's call does not name the role, but the conversation it
      // spawned does, and that conversation's `subagentInfo.toolCallId` points
      // back at this exact call, so the join is by identifier not by guess.
      const role = roles.get(text(row.call) ?? "") ?? "(unrecorded)";
      (bucket.agents[role] ??= { count: 0, maxDepth: 0 }).count += 1;
      building.events.push({ ts, kind: "agent", name: role });
    }
    if (text(row.status) === "error") {
      bucket.errors += 1;
      building.events.push({ ts, kind: "error" });
    }
  }
}

interface Store {
  /** The database's own path, mtime and size, so a stale memo is impossible. */
  key: string;
  db: SqliteDatabase | null;
  index: Map<string, Conversation>;
  /** `subagentInfo.toolCallId` to the role it spawned; see {@link applyBubbles}. */
  roles: Map<string, string>;
}

let store: Store | null = null;

function storeKey(file: string): string {
  try {
    const stats = fs.statSync(file);
    // The path is part of the key, not just the stat: two stores can share a
    // size and an mtime, and the memo holds only one entry.
    return `${file} ${stats.mtimeMs} ${stats.size}`;
  } catch {
    return "";
  }
}

/**
 * The index, built once and memoized, with the handle it was built from.
 *
 * Unlike OpenCode this does **not** reduce the whole store up front. That one is
 * a few megabytes; this one is 5.65 GB, of which 1.3 GB is turn bodies and 3 GB
 * is opaque blobs. Only the cheap index is built eagerly, and `parse` then reads
 * one conversation's turns through the key range that serves it. The handle is
 * memoized alongside it because `scan.ts` drives `parse` through a worker pool,
 * and reopening the store per conversation would be the only expensive part
 * left. The memo holds a single entry, so a `--provider all` run does not pin
 * two stores in memory.
 */
function loadStore(file: string): Store {
  const key = storeKey(file);
  if (store && store.key === key) return store;
  if (store?.db) closeQuietly(store.db);

  const db = openDatabase(file);
  const index = db ? readIndex(db) : new Map<string, Conversation>();
  const roles = new Map<string, string>();
  for (const conversation of index.values()) {
    if (conversation.agentPath && conversation.agentType) {
      roles.set(conversation.agentPath, conversation.agentType);
    }
  }
  store = { key, db, index, roles };
  return store;
}

function emptyAggregate(file: TranscriptFile, sessionId: string): FileAggregate {
  return {
    file: file.file,
    size: file.size,
    mtimeMs: file.mtimeMs,
    provider: cursorProvider.name,
    sessionId,
    kind: file.kind,
    project: "",
    firstTs: "",
    lastTs: "",
    days: {},
    malformedLines: 0,
  };
}

export const cursorProvider: UsageProvider = {
  name: "cursor",
  title: "Cursor",
  source: "The editor store at <user data>/User/globalStorage/state.vscdb",
  capabilities: {
    // Real per-request figures, but only for conversations from before Cursor
    // stopped writing them in December 2025. See the note at the top.
    tokens: true,
    // `tokenCount` has only ever had `inputTokens` and `outputTokens`: no cache
    // read, cache write, or reasoning counter has ever been recorded.
    cacheTokens: false,
    tools: true,
    // No tool, capability, or turn field names a skill, and no record of one
    // being invoked reaches the store.
    skills: false,
    subagents: true,
    // Cursor runs five hook events out of `~/.cursor/hooks.json`, but no
    // execution of one is written anywhere, the same as Codex.
    hooks: false,
    // A call is recorded as `mcp-<server>-<tool>`, so an MCP call can be told
    // apart from a builtin even though the server boundary cannot be recovered.
    mcp: true,
    // A slash command reaches the store only as the prompt text it expanded to.
    // `~/.cursor/prompt_history.json` is a most-recently-used list, not a log.
    slashCommands: false,
    projects: true,
  },

  /**
   * The Electron user-data directory, guarded on the store inside it.
   *
   * Candidates are tried in order rather than switched on `process.platform`,
   * which keeps the provider hermetic under `--logs` and under a suite that
   * swaps `HOME`, and costs one `statSync` per miss.
   */
  root(context: ProviderEnvironment): string | null {
    const override = context.override?.trim();
    const appData = context.env.APPDATA?.trim();
    const candidates = override
      ? [override]
      : [
          ...(appData ? [path.join(appData, "Cursor")] : []),
          path.join(context.home, "Library", "Application Support", "Cursor"),
          path.join(context.home, ".config", "Cursor"),
        ];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(path.join(candidate, STORE)).isFile()) return candidate;
      } catch {
        // Not this one. An absent candidate is the normal case on every
        // platform but the one Cursor is installed on.
      }
    }
    return null;
  },

  /**
   * One entry per conversation, out of a store with no filesystem unit below
   * itself: the same synthesis OpenCode performs, and for the same reason. A
   * `FileAggregate` carries exactly one session id, kind, project and time span,
   * so collapsing the store into one entry would destroy `usage sessions`,
   * `--last`, `--project`, and the main/subagent split.
   */
  discover(root: string, options: DiscoverOptions): TranscriptFile[] {
    const file = path.join(root, STORE);
    const found: TranscriptFile[] = [];
    for (const conversation of loadStore(file).index.values()) {
      // Whether a conversation is a subagent is known from the index, so they
      // are pruned before any turn is read: the fourth provider that can, after
      // claude-code, gemini-cli and opencode.
      if (!options.subagents && conversation.kind === "subagent") continue;
      const mtimeMs = Math.max(conversation.lastUpdatedAt, conversation.createdAt);
      if (options.modifiedSince !== undefined && mtimeMs < options.modifiedSince) continue;
      found.push({
        file,
        relative: `${SHARD}/${conversation.id}`,
        shard: SHARD,
        kind: conversation.kind,
        size: conversation.bubbles,
        mtimeMs,
      });
    }
    // Byte comparison, never localeCompare: the order must not depend on the
    // ICU build of the machine that ran the scan.
    found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return found;
  },

  async read(file: TranscriptFile): Promise<FileAggregate> {
    return (await cursorProvider.parse(file)).aggregate;
  },

  async parse(file: TranscriptFile): Promise<ParsedFile> {
    const sessionId = file.relative.slice(`${SHARD}/`.length);
    const loaded = loadStore(file.file);
    const conversation = loaded.index.get(sessionId);
    // A conversation that vanished between discovery and parsing, or a store
    // that would not open. Neither is fatal: it reports as an empty transcript.
    if (!conversation || !loaded.db) {
      return { aggregate: emptyAggregate(file, sessionId), events: [] };
    }

    const aggregate = emptyAggregate(file, sessionId);
    aggregate.kind = conversation.kind;
    aggregate.project = conversation.project;
    if (conversation.parentId) aggregate.parentSessionId = conversation.parentId;
    if (conversation.agentType) aggregate.agentType = conversation.agentType;
    if (conversation.agentPath) aggregate.agentPath = conversation.agentPath;
    if (conversation.title) aggregate.title = conversation.title;

    const building: Building = { aggregate, events: [] };
    // Seed the span from the index, so a conversation whose turns are all
    // untimed still reports the day it was created on.
    bucketFor(building, isoAt(conversation.createdAt));
    bucketFor(building, isoAt(conversation.lastUpdatedAt));
    applyBubbles(loaded.db, conversation, loaded.roles, building);
    return { aggregate, events: building.events };
  },
};
