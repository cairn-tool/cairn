import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export interface RawUrlResult {
  status: number | null;
  error?: string;
  redirected: boolean;
  finalUrl: string;
}

interface CacheEntry extends RawUrlResult {
  checkedAt: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export function getUrlCachePath(
  env: NodeJS.ProcessEnv = process.env,
  homedir = os.homedir(),
): string {
  const configured = env.XDG_CACHE_HOME?.trim();
  const base = configured ? configured : path.join(homedir, ".cache");
  return path.join(base, "cairn", "url-checks.json");
}

export function urlCacheKey(
  url: string,
  options: { timeout: number; retries: number; headFallbackStatuses: readonly number[] },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        url,
        timeout: options.timeout,
        retries: options.retries,
        headFallbackStatuses: [...options.headFallbackStatuses].sort((a, b) => a - b),
      }),
    )
    .digest("hex");
}

function read(cachePath: string): CacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as CacheFile;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object")
      throw new Error();
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

export function readUrlCache(
  cachePath: string,
  key: string,
  ttl: number,
  now = Date.now(),
): RawUrlResult | undefined {
  const entry = read(cachePath).entries[key];
  if (
    !entry ||
    !Number.isFinite(entry.checkedAt) ||
    !(
      entry.status === null ||
      (Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599)
    ) ||
    typeof entry.redirected !== "boolean" ||
    typeof entry.finalUrl !== "string" ||
    (entry.error !== undefined && typeof entry.error !== "string")
  )
    return undefined;
  const age = now - entry.checkedAt;
  if (age < 0 || age >= ttl) return undefined;
  const { checkedAt: _checkedAt, ...result } = entry;
  return result;
}

export function writeUrlCache(
  cachePath: string,
  key: string,
  result: RawUrlResult,
  now = Date.now(),
): boolean {
  let temporary: string | undefined;
  try {
    const cache = read(cachePath);
    cache.entries[key] = { ...result, checkedAt: now };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    temporary = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cache), "utf-8");
    fs.renameSync(temporary, cachePath);
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
