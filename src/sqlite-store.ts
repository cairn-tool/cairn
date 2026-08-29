import fs from "node:fs";
import path from "node:path";
import type { SqliteDatabase } from "./sqlite.js";
import { requireSqlite } from "./sqlite.js";

/**
 * Opening and migrating a SQLite store this project owns.
 *
 * Two stores use it — the usage store and the artifact archive index — and they
 * share it rather than each carrying a copy, because the parts that are easy to
 * get subtly wrong are the same in both: running migrations inside one
 * transaction, writing `user_version` inside that same transaction, and refusing
 * a file from the future instead of writing to it.
 *
 * These are **migrated** stores, not caches. `src/url-cache.ts` and the
 * workspace index invalidate by discarding, which is safe because their contents
 * are always re-derivable. Neither of these is: an archive holds the only copy
 * of files that may since have been deleted, and the usage store can outlive the
 * transcripts it was built from. So a version bump carries the data forward, and
 * the rules in {@link Migration} are not optional.
 */

export interface Migration {
  version: number;
  description: string;
  up(db: SqliteDatabase): void;
}

/**
 * Thrown when the file on disk was written by a newer build.
 *
 * Refusing is the point. A newer schema may carry columns this build does not
 * know about, and opening it read-write would drop them on the next write — for
 * a store that may hold the only copy of something, silently.
 */
export class StoreTooNewError extends Error {
  constructor(
    readonly label: string,
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `The ${label} is at schema version ${found}, but this build of cairn ` +
        `understands ${supported}. Upgrade cairn to read it.`,
    );
    this.name = "StoreTooNewError";
  }
}

export interface StoreOptions {
  path: string;
  /** Ordered migrations. The highest version is what this build writes. */
  migrations: readonly Migration[];
  /** Names the store in error messages, e.g. "usage database". */
  label: string;
  /** Open without migrating, and refuse to create. */
  readOnly?: boolean;
  /** Apply pending migrations. Default true. */
  migrate?: boolean;
}

export interface StoreHandle {
  db: SqliteDatabase;
  /** Version before this call did anything. */
  from: number;
  /** Version now. */
  to: number;
  /** Versions applied by this call, in order. */
  applied: number[];
}

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((highest, migration) => Math.max(highest, migration.version), 0);
}

export function userVersion(db: SqliteDatabase): number {
  const value = db.prepare("PRAGMA user_version").get()?.user_version;
  return typeof value === "number" ? value : 0;
}

export function openStore(options: StoreOptions): StoreHandle {
  const sqlite = requireSqlite();
  const readOnly = options.readOnly === true;
  const latest = latestVersion(options.migrations);

  if (readOnly && !fs.existsSync(options.path)) {
    throw new Error(`No ${options.label} at ${options.path}.`);
  }
  if (!readOnly) fs.mkdirSync(path.dirname(options.path), { recursive: true });

  const db = new sqlite.DatabaseSync(options.path, readOnly ? { readOnly: true } : {});

  try {
    if (!readOnly) {
      // WAL so a reader in another process is not blocked by an import, which is
      // the normal shape here: a report runs while another terminal writes.
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    // Both schemas lean on ON DELETE CASCADE to replace a row's children. With
    // this pragma off SQLite silently orphans them instead.
    db.exec("PRAGMA foreign_keys = ON");

    const from = userVersion(db);
    if (from > latest) throw new StoreTooNewError(options.label, from, latest);

    const applied: number[] = [];
    if (options.migrate !== false && !readOnly && from < latest) {
      const pending = options.migrations
        .filter((migration) => migration.version > from)
        .sort((a, b) => a.version - b.version);
      db.exec("BEGIN");
      try {
        for (const migration of pending) {
          migration.up(db);
          applied.push(migration.version);
        }
        // A pragma takes no bound parameter, so the value is interpolated. It is
        // a number derived from this build's own migration list, never input.
        db.exec(`PRAGMA user_version = ${latest}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    return { db, from, to: userVersion(db), applied };
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

/** Closing must never fail a caller that already has its answer. */
export function closeQuietly(db: SqliteDatabase | undefined): void {
  try {
    db?.close();
  } catch {
    // Best-effort.
  }
}

/** Runs `work` inside a transaction, rolling back if it throws. */
export function transact<T>(db: SqliteDatabase, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
