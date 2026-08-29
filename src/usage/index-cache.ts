import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileAggregate } from "./events.js";

/**
 * The incremental scan index.
 *
 * Transcripts are append-only, so a file whose size and mtime are unchanged
 * since it was last read cannot hold a record the stored aggregate is missing.
 * That makes a `(path, size, mtime)` key sufficient and lets a rescan of a
 * multi-gigabyte corpus open only the handful of files that actually grew.
 *
 * Shards are one file per project directory so that `--project` reads only what
 * it needs, and a rescan rewrites only the shards that changed.
 *
 * `CACHE_VERSION` is a private, self-invalidating cache version, exactly like
 * the one in `src/url-cache.ts`. It is deliberately **not** a hand-owned
 * contract version: it is not `CONTRACT_VERSION`, not `PROFILE_SCHEMA_VERSION`,
 * not a bundle or test-file `schemaVersion`, it is not published anywhere, and
 * it must not be documented in `docs/contract.md`. Bump it freely whenever the
 * stored shape changes; a mismatch simply discards the shard and re-parses.
 */
export const CACHE_VERSION = 1;

interface Shard {
  version: number;
  entries: Record<string, FileAggregate>;
}

export function getUsageCacheRoot(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const configured = env.XDG_CACHE_HOME?.trim();
  const base = configured ? configured : path.join(homedir, ".cache");
  return path.join(base, "claude-cli", "usage", provider);
}

/** Keeps a shard name to one path segment, whatever the project directory is called. */
function shardFile(root: string, shard: string): string {
  return path.join(root, `${shard.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function readShard(root: string, shard: string): Record<string, FileAggregate> {
  try {
    const parsed = JSON.parse(fs.readFileSync(shardFile(root, shard), "utf-8")) as Shard;
    if (
      parsed?.version !== CACHE_VERSION ||
      !parsed.entries ||
      typeof parsed.entries !== "object"
    ) {
      return {};
    }
    return parsed.entries;
  } catch {
    return {};
  }
}

/** Best-effort, atomic. A cache that cannot be written must never fail a report. */
export function writeShard(
  root: string,
  shard: string,
  entries: Record<string, FileAggregate>,
): boolean {
  const target = shardFile(root, shard);
  let temporary: string | undefined;
  try {
    fs.mkdirSync(root, { recursive: true });
    temporary = `${target}.${process.pid}.tmp`;
    const shardData: Shard = { version: CACHE_VERSION, entries };
    fs.writeFileSync(temporary, JSON.stringify(shardData), "utf-8");
    fs.renameSync(temporary, target);
    return true;
  } catch {
    if (temporary) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Cache cleanup is best-effort.
      }
    }
    return false;
  }
}

export interface CacheStatus {
  root: string;
  present: boolean;
  shards: number;
  entries: number;
  bytes: number;
  /** Most recent shard mtime as an ISO instant, or null when the cache is empty. */
  updatedAt: string | null;
}

export function cacheStatus(root: string): CacheStatus {
  const status: CacheStatus = {
    root,
    present: false,
    shards: 0,
    entries: 0,
    bytes: 0,
    updatedAt: null,
  };
  let newest = 0;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(root, { withFileTypes: true });
    status.present = true;
  } catch {
    return status;
  }
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(root, entry.name);
    try {
      const stats = fs.statSync(file);
      status.shards += 1;
      status.bytes += stats.size;
      newest = Math.max(newest, stats.mtimeMs);
      status.entries += Object.keys(readShard(root, entry.name.replace(/\.json$/, ""))).length;
    } catch {
      // A shard that vanished mid-walk is simply not counted.
    }
  }
  if (newest > 0) status.updatedAt = new Date(newest).toISOString();
  return status;
}

/** Removes every shard for a provider. Returns how many files were deleted. */
export function clearCache(root: string): number {
  let removed = 0;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { force: true });
      removed += 1;
    } catch {
      // Best-effort.
    }
  }
  return removed;
}
