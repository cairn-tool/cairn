import os from "node:os";
import path from "node:path";
import type { StoreHandle } from "../../sqlite-store.js";
import { openStore, StoreTooNewError } from "../../sqlite-store.js";
import { MIGRATIONS } from "./migrations.js";

/**
 * Where the usage store lives.
 *
 * `XDG_DATA_HOME`, not `XDG_CACHE_HOME`. The JSON shard store this replaced was
 * a cache — losing it cost a re-parse and nothing else. This is data: once
 * transcripts have been archived and pruned, it is the only record of that usage
 * left on the machine, and a cache directory is somewhere tools are entitled to
 * delete without asking.
 */
export function getUsageDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const base = configured ? configured : path.join(homedir, ".local", "share");
  return path.join(base, "cairn", "usage.db");
}

export { StoreTooNewError as DatabaseTooNewError } from "../../sqlite-store.js";

export interface OpenOptions {
  path: string;
  /** Open without migrating, and refuse to create. For readers and status. */
  readOnly?: boolean;
  /**
   * Apply pending migrations. Default true. When false, an out-of-date store
   * opens as-is, which is what `usage migrate --check` needs.
   */
  migrate?: boolean;
}

export type OpenResult = StoreHandle;

/**
 * Opens the usage store, migrating it forward.
 *
 * The mechanics live in `src/sqlite-store.ts`, shared with the archive index;
 * what belongs here is only which migrations apply and what the thing is called
 * when something goes wrong.
 */
export function openUsageDatabase(options: OpenOptions): OpenResult {
  return openStore({
    path: options.path,
    migrations: MIGRATIONS,
    label: "usage database",
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.migrate === false ? { migrate: false } : {}),
  });
}

export { StoreTooNewError };
