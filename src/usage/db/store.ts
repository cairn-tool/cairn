import type { SqliteDatabase, SqliteStatement } from "../../sqlite.js";
import type { DayBucket, FileAggregate, ParsedFile, TranscriptKind } from "../events.js";
import { emptyBucket, emptyTokens, utcDay } from "../events.js";

/**
 * Reading and writing the usage store.
 *
 * Nothing here decides *what* to import — that is `import.ts` — and nothing here
 * filters by anything the pure helpers in `filter.ts` already own. SQL narrows
 * the row set for speed; `clipToWindow` and `matchesProject` still decide
 * membership, so the selection a report sees is defined by the same code that
 * defined it when the store was a directory of JSON shards.
 */

/**
 * `node:sqlite` rejects `undefined`, and every optional column here is optional
 * because the provider genuinely had nothing to record.
 */
function bind(value: string | number | undefined): string | number | null {
  return value ?? null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function int(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export interface StoredFile {
  id: number;
  size: number;
  mtimeMs: number;
}

/**
 * Every transcript this provider already has a row for, keyed by its path
 * relative to the log root — the same key the JSON shards used.
 */
export function storedFiles(db: SqliteDatabase, provider: string): Map<string, StoredFile> {
  const rows = db
    .prepare("SELECT id, relative, size, mtime_ms FROM file WHERE provider = ?")
    .all(provider);
  const found = new Map<string, StoredFile>();
  for (const row of rows) {
    found.set(String(row.relative), {
      id: Number(row.id),
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
    });
  }
  return found;
}

/** The prepared statements one import run reuses across every file it writes. */
export interface WriteStatements {
  deleteFile: SqliteStatement;
  insertFile: SqliteStatement;
  insertEvent: SqliteStatement;
  insertDay: SqliteStatement;
  insertDayModel: SqliteStatement;
  insertDayTool: SqliteStatement;
  insertDaySkill: SqliteStatement;
  insertDayCommand: SqliteStatement;
  insertDayAgent: SqliteStatement;
  insertDayHook: SqliteStatement;
}

export function prepareWrites(db: SqliteDatabase): WriteStatements {
  return {
    deleteFile: db.prepare("DELETE FROM file WHERE id = ?"),
    insertFile: db.prepare(
      `INSERT INTO file(provider, relative, path, size, mtime_ms, session_id, kind,
         parent_session_id, agent_id, agent_type, agent_path, spawn_depth, project,
         title, git_branch, tool_version, first_ts, last_ts, malformed_lines, imported_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    insertEvent: db.prepare(
      `INSERT INTO event(file_id, ts, day, kind, model, tool, name, status, duration_ms, depth,
         input, output, cache_read, cache_write, cache_write_5m, cache_write_1h,
         thinking, web_search, web_fetch, requests)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    insertDay: db.prepare(
      "INSERT INTO day(file_id, day, prompts, errors, compactions) VALUES(?,?,?,?,?)",
    ),
    insertDayModel: db.prepare(
      `INSERT INTO day_model(day_id, model, input, output, cache_read, cache_write,
         cache_write_5m, cache_write_1h, thinking, web_search, web_fetch, requests)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    insertDayTool: db.prepare("INSERT INTO day_tool(day_id, tool, calls) VALUES(?,?,?)"),
    insertDaySkill: db.prepare("INSERT INTO day_skill(day_id, skill, calls) VALUES(?,?,?)"),
    insertDayCommand: db.prepare("INSERT INTO day_command(day_id, command, calls) VALUES(?,?,?)"),
    insertDayAgent: db.prepare(
      "INSERT INTO day_agent(day_id, agent, count, max_depth) VALUES(?,?,?,?)",
    ),
    insertDayHook: db.prepare(
      `INSERT INTO day_hook(day_id, hook, count, failures, cancelled, total_ms, max_ms)
       VALUES(?,?,?,?,?,?,?)`,
    ),
  };
}

/**
 * Writes one parsed transcript, replacing any row it already had.
 *
 * The delete is what makes a re-import idempotent: `ON DELETE CASCADE` clears
 * the file's events and day buckets, so a transcript that grew is rewritten
 * whole rather than accumulating a second copy of everything it already held.
 */
export function writeParsedFile(
  statements: WriteStatements,
  parsed: ParsedFile,
  relative: string,
  importedAt: string,
  existingId?: number,
): void {
  if (existingId !== undefined) statements.deleteFile.run(existingId);

  const aggregate = parsed.aggregate;
  const inserted = statements.insertFile.run(
    aggregate.provider,
    relative,
    aggregate.file,
    aggregate.size,
    aggregate.mtimeMs,
    aggregate.sessionId,
    aggregate.kind,
    bind(aggregate.parentSessionId),
    bind(aggregate.agentId),
    bind(aggregate.agentType),
    bind(aggregate.agentPath),
    bind(aggregate.spawnDepth),
    aggregate.project,
    bind(aggregate.title),
    bind(aggregate.gitBranch),
    bind(aggregate.toolVersion),
    aggregate.firstTs,
    aggregate.lastTs,
    aggregate.malformedLines,
    importedAt,
  );
  const fileId = Number(inserted.lastInsertRowid);

  for (const event of parsed.events) {
    const day = utcDay(event.ts);
    if (!day) continue;
    const tokens = event.tokens;
    statements.insertEvent.run(
      fileId,
      event.ts,
      day,
      event.kind,
      bind(event.model),
      bind(event.tool),
      bind(event.name),
      bind(event.status),
      bind(event.durationMs),
      bind(event.depth),
      bind(tokens?.input),
      bind(tokens?.output),
      bind(tokens?.cacheRead),
      bind(tokens?.cacheWrite),
      bind(tokens?.cacheWrite5m),
      bind(tokens?.cacheWrite1h),
      bind(tokens?.thinking),
      bind(tokens?.webSearch),
      bind(tokens?.webFetch),
      bind(tokens?.requests),
    );
  }

  for (const [day, bucket] of Object.entries(aggregate.days)) {
    const dayRow = statements.insertDay.run(
      fileId,
      day,
      bucket.prompts,
      bucket.errors,
      bucket.compactions,
    );
    const dayId = Number(dayRow.lastInsertRowid);
    for (const [model, tokens] of Object.entries(bucket.models)) {
      statements.insertDayModel.run(
        dayId,
        model,
        tokens.input,
        tokens.output,
        tokens.cacheRead,
        tokens.cacheWrite,
        tokens.cacheWrite5m,
        tokens.cacheWrite1h,
        tokens.thinking,
        tokens.webSearch,
        tokens.webFetch,
        tokens.requests,
      );
    }
    for (const [tool, calls] of Object.entries(bucket.tools)) {
      statements.insertDayTool.run(dayId, tool, calls);
    }
    for (const [skill, calls] of Object.entries(bucket.skills)) {
      statements.insertDaySkill.run(dayId, skill, calls);
    }
    for (const [command, calls] of Object.entries(bucket.commands)) {
      statements.insertDayCommand.run(dayId, command, calls);
    }
    for (const [agent, totals] of Object.entries(bucket.agents)) {
      statements.insertDayAgent.run(dayId, agent, totals.count, totals.maxDepth);
    }
    for (const [hook, totals] of Object.entries(bucket.hooks)) {
      statements.insertDayHook.run(
        dayId,
        hook,
        totals.count,
        totals.failures,
        totals.cancelled,
        totals.totalMs,
        totals.maxMs,
      );
    }
  }
}

/**
 * Drops rows for transcripts a complete walk did not find.
 *
 * Only ever called after a walk that looked at everything. A walk pruned by
 * `--since` or `--no-subagents` has no evidence about the files it skipped, and
 * deleting them would evict entries the next full import would have to re-parse
 * from scratch — the invariant the JSON shard store called `partial`.
 */
export function deleteMissing(
  db: SqliteDatabase,
  provider: string,
  seen: ReadonlySet<string>,
): number {
  const rows = db.prepare("SELECT id, relative FROM file WHERE provider = ?").all(provider);
  const remove = db.prepare("DELETE FROM file WHERE id = ?");
  let removed = 0;
  for (const row of rows) {
    if (seen.has(String(row.relative))) continue;
    remove.run(Number(row.id));
    removed += 1;
  }
  return removed;
}

export interface SelectFilter {
  providers: readonly string[];
  /** Inclusive day bounds, pushed down purely to narrow the row set. */
  since?: string;
  until?: string;
  /** When false, subagent transcripts are left out of the walk entirely. */
  subagents: boolean;
}

/**
 * Hydrates the selection as `FileAggregate`s.
 *
 * The shape is exactly what the JSON shard store returned, so every rollup in
 * `aggregate.ts` runs against it unchanged. Child tables are read with one query
 * each rather than per file: the whole corpus is around 82k day rows, so seven
 * scans cost less than the round trips a per-file query would make.
 */
export function selectFiles(db: SqliteDatabase, filter: SelectFilter): FileAggregate[] {
  if (filter.providers.length === 0) return [];

  const placeholders = filter.providers.map(() => "?").join(",");
  const conditions = [`f.provider IN (${placeholders})`];
  const parameters: (string | number)[] = [...filter.providers];
  if (!filter.subagents) conditions.push("f.kind <> 'subagent'");

  const fileRows = db
    .prepare(`SELECT * FROM file f WHERE ${conditions.join(" AND ")} ORDER BY f.id`)
    .all(...parameters);

  const byId = new Map<number, FileAggregate>();
  for (const row of fileRows) {
    const id = Number(row.id);
    byId.set(id, {
      file: String(row.path),
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      provider: String(row.provider),
      sessionId: String(row.session_id),
      kind: String(row.kind) as TranscriptKind,
      ...(text(row.parent_session_id) ? { parentSessionId: text(row.parent_session_id) } : {}),
      ...(text(row.agent_id) ? { agentId: text(row.agent_id) } : {}),
      ...(text(row.agent_type) ? { agentType: text(row.agent_type) } : {}),
      ...(text(row.agent_path) ? { agentPath: text(row.agent_path) } : {}),
      ...(typeof row.spawn_depth === "number" ? { spawnDepth: row.spawn_depth } : {}),
      project: String(row.project),
      ...(text(row.title) ? { title: text(row.title) } : {}),
      ...(text(row.git_branch) ? { gitBranch: text(row.git_branch) } : {}),
      ...(text(row.tool_version) ? { toolVersion: text(row.tool_version) } : {}),
      firstTs: String(row.first_ts),
      lastTs: String(row.last_ts),
      days: {},
      malformedLines: Number(row.malformed_lines),
    });
  }
  if (byId.size === 0) return [];

  const dayConditions = [...conditions];
  const dayParameters = [...parameters];
  if (filter.since) {
    dayConditions.push("d.day >= ?");
    dayParameters.push(filter.since);
  }
  if (filter.until) {
    dayConditions.push("d.day <= ?");
    dayParameters.push(filter.until);
  }

  const buckets = new Map<number, DayBucket>();
  const dayRows = db
    .prepare(
      `SELECT d.id, d.file_id, d.day, d.prompts, d.errors, d.compactions
         FROM day d JOIN file f ON f.id = d.file_id
        WHERE ${dayConditions.join(" AND ")}`,
    )
    .all(...dayParameters);
  for (const row of dayRows) {
    const aggregate = byId.get(Number(row.file_id));
    if (!aggregate) continue;
    const bucket = emptyBucket();
    bucket.prompts = int(row.prompts);
    bucket.errors = int(row.errors);
    bucket.compactions = int(row.compactions);
    aggregate.days[String(row.day)] = bucket;
    buckets.set(Number(row.id), bucket);
  }
  if (buckets.size === 0) return [...byId.values()];

  const child = (table: string, columns: string): Iterable<Record<string, unknown>> =>
    db
      .prepare(
        `SELECT c.day_id, ${columns}
           FROM ${table} c
           JOIN day d ON d.id = c.day_id
           JOIN file f ON f.id = d.file_id
          WHERE ${dayConditions.join(" AND ")}`,
      )
      .all(...dayParameters);

  for (const row of child(
    "day_model",
    `c.model, c.input, c.output, c.cache_read, c.cache_write, c.cache_write_5m,
     c.cache_write_1h, c.thinking, c.web_search, c.web_fetch, c.requests`,
  )) {
    const bucket = buckets.get(Number(row.day_id));
    if (!bucket) continue;
    bucket.models[String(row.model)] = {
      ...emptyTokens(),
      input: int(row.input),
      output: int(row.output),
      cacheRead: int(row.cache_read),
      cacheWrite: int(row.cache_write),
      cacheWrite5m: int(row.cache_write_5m),
      cacheWrite1h: int(row.cache_write_1h),
      thinking: int(row.thinking),
      webSearch: int(row.web_search),
      webFetch: int(row.web_fetch),
      requests: int(row.requests),
    };
  }

  const counts: ReadonlyArray<[string, string, keyof DayBucket]> = [
    ["day_tool", "tool", "tools"],
    ["day_skill", "skill", "skills"],
    ["day_command", "command", "commands"],
  ];
  for (const [table, column, target] of counts) {
    for (const row of child(table, `c.${column} AS key, c.calls`)) {
      const bucket = buckets.get(Number(row.day_id));
      if (!bucket) continue;
      (bucket[target] as Record<string, number>)[String(row.key)] = int(row.calls);
    }
  }

  for (const row of child("day_agent", "c.agent, c.count, c.max_depth")) {
    const bucket = buckets.get(Number(row.day_id));
    if (!bucket) continue;
    bucket.agents[String(row.agent)] = { count: int(row.count), maxDepth: int(row.max_depth) };
  }

  for (const row of child(
    "day_hook",
    "c.hook, c.count, c.failures, c.cancelled, c.total_ms, c.max_ms",
  )) {
    const bucket = buckets.get(Number(row.day_id));
    if (!bucket) continue;
    bucket.hooks[String(row.hook)] = {
      count: int(row.count),
      failures: int(row.failures),
      cancelled: int(row.cancelled),
      totalMs: int(row.total_ms),
      maxMs: int(row.max_ms),
    };
  }

  return [...byId.values()];
}

export interface StoreStatus {
  path: string;
  present: boolean;
  schemaVersion: number;
  files: number;
  days: number;
  events: number;
  bytes: number;
  /** Most recent import as an ISO instant, or null when the store is empty. */
  updatedAt: string | null;
  /** Row counts per provider, so a caller can see what a store actually holds. */
  providers: Record<string, number>;
}

export function storeStatus(db: SqliteDatabase): Omit<StoreStatus, "path" | "present" | "bytes"> {
  const one = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
  const providers: Record<string, number> = {};
  for (const row of db
    .prepare("SELECT provider, COUNT(*) AS n FROM file GROUP BY provider ORDER BY provider")
    .all()) {
    providers[String(row.provider)] = Number(row.n);
  }
  const updated = db.prepare("SELECT MAX(imported_at) AS at FROM file").get()?.at;
  return {
    schemaVersion: Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0),
    files: one("SELECT COUNT(*) AS n FROM file"),
    days: one("SELECT COUNT(*) AS n FROM day"),
    events: one("SELECT COUNT(*) AS n FROM event"),
    updatedAt: typeof updated === "string" ? updated : null,
    providers,
  };
}
