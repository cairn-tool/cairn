import { createRequire } from "node:module";

/**
 * The `node:sqlite` boundary.
 *
 * Two very different callers share this module. The antigravity provider opens
 * somebody else's database read-only and treats every failure as a missing
 * token column; the usage store and the artifact archive own their databases and
 * write to them. What they have in common is the loader below, which must not be
 * duplicated: the `process.emitWarning` swap it performs is load-bearing, and a
 * second copy would be a second chance to get it wrong.
 *
 * The interfaces are hand-written rather than imported from `node:sqlite`
 * because the module is only required at runtime — `@types/node` declares it,
 * but importing the type would make `dist` depend on a module the type checker
 * resolves and the emitted code must not.
 */

export interface SqliteRow {
  [column: string]: unknown;
}

/** The subset of `StatementSync` this project uses. */
export interface SqliteStatement {
  all(...parameters: unknown[]): SqliteRow[];
  get(...parameters: unknown[]): SqliteRow | undefined;
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...parameters: unknown[]): IterableIterator<SqliteRow>;
}

/** The subset of `DatabaseSync` this project uses. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export interface SqliteModule {
  DatabaseSync: new (path: string, options?: object) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined;

/**
 * Loads `node:sqlite`, suppressing its experimental warning.
 *
 * The warning goes to stderr, and stderr carries the JSON payload whenever a
 * command reports findings — so letting it through would corrupt a consumer's
 * parse. This is the same rule that keeps the update notifier off machine-
 * readable streams.
 *
 * Returns null when the runtime has no `node:sqlite`. For the antigravity
 * provider that costs the token column and nothing else; for the usage store it
 * is fatal, and `openDatabase` says so rather than degrading silently.
 *
 * The tri-state memo is deliberate: `undefined` means untried, `null` means
 * tried and unavailable, so a missing module is not re-required per call.
 */
export function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  const emit = process.emitWarning;
  try {
    process.emitWarning = () => {};
    // A synchronous require of a builtin, which `import` cannot do from a
    // non-async call site. `createRequire` is how ESM asks for one.
    sqliteModule = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqliteModule;
}

/** Thrown when a caller that requires SQLite cannot have it. */
export class SqliteUnavailableError extends Error {
  constructor() {
    super(
      "This build of Node has no `node:sqlite`. The usage store needs it; " +
        "run with --no-index to report without one.",
    );
    this.name = "SqliteUnavailableError";
  }
}

/** Loads the module or throws. For callers that cannot degrade. */
export function requireSqlite(): SqliteModule {
  const module = loadSqlite();
  if (!module) throw new SqliteUnavailableError();
  return module;
}
