import os from "node:os";
import type { SqliteDatabase } from "../sqlite.js";
import type { FileAggregate } from "./events.js";
import { sessionKey } from "./events.js";
import type { ProjectSelector, Window } from "./filter.js";
import { clipToWindow, matchesProject, modifiedSinceFor } from "./filter.js";
import { getUsageDatabasePath, openUsageDatabase } from "./db/open.js";
import {
  deleteMissing,
  prepareWrites,
  selectFiles,
  storedFiles,
  writeParsedFile,
} from "./db/store.js";
import type { StoredFile } from "./db/store.js";
import type { TranscriptFile, UsageProvider } from "./providers/types.js";

/**
 * Discovery, store reconciliation, and parsing.
 *
 * This is the only module in `src/usage` that both reads the filesystem and
 * writes the store; `filter.ts` and `aggregate.ts` stay pure so their rules can
 * be tested without fixtures on disk.
 *
 * The store is a SQLite database rather than the directory of JSON shards this
 * used to keep, but the reconciliation rules are unchanged and deliberately so:
 * freshness is still `(size, mtime)`, and a walk that discovery pruned still may
 * not delete. What the database adds is the per-event grain, which no report
 * reads today and no shard could have held.
 */

/** How many files one transaction covers, so a large import is not one lock. */
const BATCH = 200;

export interface ScanOptions {
  provider: UsageProvider;
  root: string;
  subagents: boolean;
  window: Window;
  projects: readonly ProjectSelector[];
  /** Keep only the n most recent sessions. Applied after aggregation. */
  last?: number;
  /** When false the store is neither read nor written. */
  useIndex: boolean;
  /** Re-parse every file even on a hit, then rewrite its rows. */
  rebuild?: boolean;
  /** Overrides the discovered store path. */
  databasePath?: string;
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
  /** The store this scan read and wrote, or null under `--no-index`. */
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

function isFresh(entry: StoredFile | undefined, file: TranscriptFile): boolean {
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

  const databasePath = options.useIndex ? (options.databasePath ?? getUsageDatabasePath()) : null;

  const aggregates: FileAggregate[] = [];

  if (!databasePath) {
    // `--no-index`: parse everything found and keep nothing.
    const parsed = await concurrent(
      discovered,
      options.concurrency ?? defaultScanConcurrency(),
      async (file) => {
        try {
          return await options.provider.read(file);
        } catch (error) {
          failures.push({ file: file.file, reason: (error as Error).message });
          return null;
        }
      },
    );
    for (const aggregate of parsed) {
      if (!aggregate) {
        counters.skipped += 1;
        continue;
      }
      counters.parsed += 1;
      counters.malformed += aggregate.malformedLines;
      aggregates.push(aggregate);
    }
  } else {
    const opened = openUsageDatabase({ path: databasePath });
    const db = opened.db;
    try {
      const stored = storedFiles(db, options.provider.name);
      const misses: TranscriptFile[] = [];
      const seen = new Set<string>();

      for (const file of discovered) {
        seen.add(file.relative);
        if (!options.rebuild && isFresh(stored.get(file.relative), file)) counters.cached += 1;
        else misses.push(file);
      }

      if (misses.length > 0) {
        const statements = prepareWrites(db);
        const importedAt = new Date().toISOString();
        // Parsing is the slow half and runs concurrently; writing is serial,
        // because one SQLite connection has one writer.
        for (let offset = 0; offset < misses.length; offset += BATCH) {
          const batch = misses.slice(offset, offset + BATCH);
          const parsed = await concurrent(
            batch,
            options.concurrency ?? defaultScanConcurrency(),
            async (file) => {
              try {
                return { file, parsed: await options.provider.parse(file) };
              } catch (error) {
                failures.push({ file: file.file, reason: (error as Error).message });
                return null;
              }
            },
          );
          db.exec("BEGIN");
          try {
            for (const result of parsed) {
              if (!result) {
                counters.skipped += 1;
                continue;
              }
              counters.parsed += 1;
              counters.malformed += result.parsed.aggregate.malformedLines;
              writeParsedFile(
                statements,
                result.parsed,
                result.file.relative,
                importedAt,
                stored.get(result.file.relative)?.id,
              );
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
      }

      // Only a complete walk may delete: absence proves the transcript is gone
      // only when the walk would have found it.
      if (!partial) {
        db.exec("BEGIN");
        try {
          deleteMissing(db, options.provider.name, seen);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }

      aggregates.push(
        ...selectFiles(db, {
          providers: [options.provider.name],
          subagents: options.subagents,
          since: options.window.since ?? undefined,
          until: options.window.until ?? undefined,
        }),
      );
    } finally {
      closeQuietly(db);
    }
  }

  let selected: FileAggregate[] = [];
  for (const aggregate of aggregates) {
    // Only some providers can tell a subagent transcript from its path; the
    // rest record it inside the file, so the filter is applied again here on
    // the parsed value. Discovery has already pruned whatever it could.
    if (!options.subagents && aggregate.kind === "subagent") continue;
    if (!matchesProject(aggregate.project, options.projects)) continue;
    const clipped = clipToWindow(aggregate, options.window);
    if (clipped) selected.push(clipped);
  }

  if (options.last !== undefined && options.last > 0) {
    selected = keepRecentSessions(selected, options.last);
  }
  counters.selected = selected.length;

  return { files: selected, counters, failures, cacheRoot: databasePath };
}

function closeQuietly(db: SqliteDatabase): void {
  try {
    db.close();
  } catch {
    // A store that will not close cleanly must not fail a report that already
    // has its numbers.
  }
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
    const key = sessionKey(file);
    const current = latest.get(key);
    if (current === undefined || file.lastTs > current) latest.set(key, file.lastTs);
  }
  const ranked = [...latest.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, last)
    .map(([key]) => key);
  const keep = new Set(ranked);
  return files.filter((file) => keep.has(sessionKey(file)));
}
