import fs from "node:fs";
import { LATEST_VERSION } from "./migrations.js";
import { openUsageDatabase } from "./open.js";
import { storeStatus } from "./store.js";

export { getUsageDatabasePath, openUsageDatabase, DatabaseTooNewError } from "./open.js";
export type { OpenOptions, OpenResult } from "./open.js";
export { LATEST_VERSION, MIGRATIONS } from "./migrations.js";
export type { Migration } from "./migrations.js";
export {
  selectFiles,
  storedFiles,
  storeStatus,
  prepareWrites,
  writeParsedFile,
  deleteMissing,
} from "./store.js";
export type { SelectFilter, StoredFile, StoreStatus, WriteStatements } from "./store.js";

/**
 * What `usage index` reports.
 *
 * `shards` is retained at `0`. It described the JSON shard store that used to
 * back this command, and there is no longer any such thing — but it is a
 * required property of the published `usage-index` schema, and a consumer
 * reading it would break if it vanished. Recording the inconsistency is this
 * project's rule for exactly this situation; see `docs/contract.md`.
 *
 * `bytes` is the whole store's size on every entry rather than a per-provider
 * share, because one SQLite file holds them all and a row's share of it is not a
 * number that means anything. It is therefore *not* summed into the total.
 */
export interface IndexStatus {
  root: string;
  present: boolean;
  shards: number;
  entries: number;
  bytes: number;
  updatedAt: string | null;
  /** Day buckets held, across the whole store. */
  days: number;
  /** Events held, across the whole store. */
  events: number;
  /** Schema version of the store on disk, or the version this build writes. */
  schemaVersion: number;
}

function databaseBytes(path: string): number {
  let total = 0;
  // A WAL database is three files, and a large uncheckpointed WAL is real disk
  // the user is entitled to see accounted for.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(`${path}${suffix}`).size;
    } catch {
      // A sidecar that is absent contributes nothing.
    }
  }
  return total;
}

/**
 * Status of the store, optionally narrowed to one provider's rows.
 *
 * Never throws: a missing or unreadable store reports absent, exactly as the
 * shard store's `cacheStatus` did, so `usage index` on a fresh machine prints a
 * status rather than an error.
 */
export function databaseStatus(path: string, provider?: string): IndexStatus {
  const absent: IndexStatus = {
    root: path,
    present: false,
    shards: 0,
    entries: 0,
    bytes: 0,
    updatedAt: null,
    days: 0,
    events: 0,
    schemaVersion: LATEST_VERSION,
  };
  if (!fs.existsSync(path)) return absent;

  let opened;
  try {
    opened = openUsageDatabase({ path, readOnly: true, migrate: false });
  } catch {
    return absent;
  }
  try {
    const status = storeStatus(opened.db);
    const entries = provider ? (status.providers[provider] ?? 0) : status.files;
    return {
      root: path,
      present: true,
      shards: 0,
      entries,
      bytes: databaseBytes(path),
      updatedAt: status.updatedAt,
      days: status.days,
      events: status.events,
      schemaVersion: status.schemaVersion,
    };
  } catch {
    return absent;
  } finally {
    try {
      opened.db.close();
    } catch {
      // Closing a read-only handle is best-effort.
    }
  }
}

/**
 * Drops a provider's rows, or the whole store when no provider is named.
 *
 * Returns transcripts removed. The space is not reclaimed: `VACUUM` rewrites the
 * entire file, which on a multi-gigabyte store costs far more than the pages it
 * frees, and SQLite reuses them for the next import anyway.
 */
export function clearDatabase(path: string, provider?: string): number {
  if (!fs.existsSync(path)) return 0;
  let opened;
  try {
    opened = openUsageDatabase({ path, migrate: false });
  } catch {
    return 0;
  }
  try {
    const before = Number(
      opened.db
        .prepare(
          provider
            ? "SELECT COUNT(*) AS n FROM file WHERE provider = ?"
            : "SELECT COUNT(*) AS n FROM file",
        )
        .get(...(provider ? [provider] : []))?.n ?? 0,
    );
    if (provider) opened.db.prepare("DELETE FROM file WHERE provider = ?").run(provider);
    else opened.db.exec("DELETE FROM file");
    return before;
  } catch {
    return 0;
  } finally {
    try {
      opened.db.close();
    } catch {
      // Best-effort.
    }
  }
}
