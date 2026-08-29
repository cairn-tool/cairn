import os from "node:os";
import type { FileAggregate } from "./events.js";
import type { ProjectSelector, Window } from "./filter.js";
import { clipToWindow, matchesProject, modifiedSinceFor } from "./filter.js";
import { getUsageCacheRoot, readShard, writeShard } from "./index-cache.js";
import type { TranscriptFile, UsageProvider } from "./providers/types.js";

/**
 * Discovery, cache reconciliation, and parsing.
 *
 * This is the only module in `src/usage` that both reads the filesystem and
 * writes the cache; `filter.ts` and `aggregate.ts` stay pure so their rules can
 * be tested without fixtures on disk.
 */

export interface ScanOptions {
  provider: UsageProvider;
  root: string;
  subagents: boolean;
  window: Window;
  projects: readonly ProjectSelector[];
  /** Keep only the n most recent sessions. Applied after aggregation. */
  last?: number;
  /** When false the cache is neither read nor written. */
  useIndex: boolean;
  /** Re-parse every file even on a cache hit, then rewrite the shards. */
  rebuild?: boolean;
  cacheRoot?: string;
  concurrency?: number;
}

export interface ScanCounters {
  /** Transcripts the provider found, after the mtime prune. */
  discovered: number;
  /** Served from the index without opening the file. */
  cached: number;
  /** Opened and parsed. */
  parsed: number;
  /** Found but unreadable. */
  skipped: number;
  /** Lines that were not valid JSON, across every file parsed. */
  malformed: number;
  /** Aggregates left after the project and window filters. */
  selected: number;
}

export interface ScanFailure {
  file: string;
  reason: string;
}

export interface ScanResult {
  files: FileAggregate[];
  counters: ScanCounters;
  failures: ScanFailure[];
  cacheRoot: string | null;
}

/**
 * Bounded worker pool, in the shape already used by `src/commands/audit.ts` and
 * `src/commands/check-urls.ts`.
 */
async function concurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker),
  );
  return results;
}

export function defaultScanConcurrency(): number {
  return Math.max(2, Math.min(8, os.cpus().length));
}

function isFresh(entry: FileAggregate | undefined, file: TranscriptFile): boolean {
  return entry !== undefined && entry.size === file.size && entry.mtimeMs === file.mtimeMs;
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const counters: ScanCounters = {
    discovered: 0,
    cached: 0,
    parsed: 0,
    skipped: 0,
    malformed: 0,
    selected: 0,
  };
  const failures: ScanFailure[] = [];

  const modifiedSince = modifiedSinceFor(options.window);
  const discovered = options.provider.discover(options.root, {
    subagents: options.subagents,
    modifiedSince,
  });
  counters.discovered = discovered.length;

  /**
   * Whether discovery deliberately looked at only part of the corpus.
   *
   * A pruned walk must merge into the stored shard rather than replace it:
   * rebuilding a shard from a `--since 7d` or `--no-subagents` discovery would
   * evict every entry the walk never considered, so the next full scan would
   * re-parse everything it had already done. Only a complete walk is entitled to
   * drop entries, because only then does an entry's absence prove the transcript
   * is gone.
   */
  const partial = modifiedSince !== undefined || !options.subagents;

  const cacheRoot = options.useIndex
    ? (options.cacheRoot ?? getUsageCacheRoot(options.provider.name))
    : null;

  const byShard = new Map<string, TranscriptFile[]>();
  for (const file of discovered) {
    const bucket = byShard.get(file.shard);
    if (bucket) bucket.push(file);
    else byShard.set(file.shard, [file]);
  }

  const aggregates: FileAggregate[] = [];

  for (const [shard, files] of byShard) {
    const stored = cacheRoot ? readShard(cacheRoot, shard) : {};
    // A complete walk rebuilds the shard from what it found, so a transcript
    // that has since been deleted drops out instead of accumulating forever. A
    // partial walk starts from what is already stored, because it has no
    // evidence about the files it skipped.
    const rekeyed: Record<string, FileAggregate> = partial ? { ...stored } : {};
    const misses: TranscriptFile[] = [];

    for (const file of files) {
      const entry = stored[file.relative];
      if (!options.rebuild && isFresh(entry, file)) {
        counters.cached += 1;
        rekeyed[file.relative] = entry!;
        aggregates.push(entry!);
      } else {
        misses.push(file);
      }
    }

    const parsed = await concurrent(
      misses,
      options.concurrency ?? defaultScanConcurrency(),
      async (file) => {
        try {
          return { file, aggregate: await options.provider.read(file) };
        } catch (error) {
          failures.push({ file: file.file, reason: (error as Error).message });
          return null;
        }
      },
    );

    for (const result of parsed) {
      if (!result) {
        counters.skipped += 1;
        continue;
      }
      counters.parsed += 1;
      counters.malformed += result.aggregate.malformedLines;
      rekeyed[result.file.relative] = result.aggregate;
      aggregates.push(result.aggregate);
    }

    // A partial walk can only ever add, so with nothing parsed there is nothing
    // to store; a complete walk also rewrites when an entry has disappeared.
    const changed = partial
      ? misses.length > 0
      : misses.length > 0 || Object.keys(rekeyed).length !== Object.keys(stored).length;
    if (cacheRoot && changed) writeShard(cacheRoot, shard, rekeyed);
  }

  let selected: FileAggregate[] = [];
  for (const aggregate of aggregates) {
    if (!matchesProject(aggregate.project, options.projects)) continue;
    const clipped = clipToWindow(aggregate, options.window);
    if (clipped) selected.push(clipped);
  }

  if (options.last !== undefined && options.last > 0) {
    selected = keepRecentSessions(selected, options.last);
  }
  counters.selected = selected.length;

  return { files: selected, counters, failures, cacheRoot };
}

/**
 * Keeps every aggregate belonging to the n most recently active sessions.
 *
 * Sessions rather than files: a session's subagent transcripts are part of it,
 * and `--last 10` that silently dropped nine tenths of the tokens would be
 * worse than useless.
 */
export function keepRecentSessions(files: FileAggregate[], last: number): FileAggregate[] {
  const latest = new Map<string, string>();
  for (const file of files) {
    const current = latest.get(file.sessionId);
    if (current === undefined || file.lastTs > current) latest.set(file.sessionId, file.lastTs);
  }
  const ranked = [...latest.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, last)
    .map(([sessionId]) => sessionId);
  const keep = new Set(ranked);
  return files.filter((file) => keep.has(file.sessionId));
}
