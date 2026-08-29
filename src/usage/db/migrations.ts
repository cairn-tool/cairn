import type { Migration } from "../../sqlite-store.js";
import { latestVersion } from "../../sqlite-store.js";
import { SCHEMA_V1 } from "./schema.js";

/**
 * The usage store's schema versions.
 *
 * This is a **fifth hand-owned version**, and the first in this project that is
 * migrated rather than discarded. `CACHE_VERSION` in the old JSON shard store
 * and the one in `src/url-cache.ts` are private and self-invalidating: a
 * mismatch throws the file away and costs a re-parse. This one cannot work that
 * way. Once `archive run --include transcripts` has run and the source logs are
 * pruned, the database is the only surviving record of that usage, so a version
 * bump has to carry the data forward.
 *
 * That makes the rules different, and they are worth stating:
 *
 * - **Never edit a shipped migration.** A database in the field has already run
 *   it; changing it means two databases claim the same version with different
 *   shapes. Add a new one instead.
 * - **A migration must be able to run on real data**, not just on an empty file.
 * - **A database from the future is refused, not guessed at.** A newer `cairn`
 *   may have written columns this build knows nothing about, and opening it
 *   read-write risks dropping them on the next write.
 *
 * `PRAGMA user_version` is the store, because SQLite keeps it in the file header
 * where it costs no table and cannot itself need migrating.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "Initial schema: files, events, and the materialized day rollup",
    up(db) {
      db.exec(SCHEMA_V1);
    },
  },
];

/** The version a database this build writes ends up at. */
export const LATEST_VERSION: number = latestVersion(MIGRATIONS);

export type { Migration } from "../../sqlite-store.js";
