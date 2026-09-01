import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteDatabase } from "../sqlite.js";
import { loadSqlite } from "../sqlite.js";
import { closeQuietly, transact } from "../sqlite-store.js";
import type { UsageProvider } from "../usage/providers/types.js";
import { openArchive, segmentsDirectory } from "./db.js";
import type { ArtifactClass, ArtifactSet } from "./sets.js";
import { profileFor } from "./sets.js";
import type { RunReporter } from "./progress.js";
import { DEFAULT_SEGMENT_BYTES, hashBuffer, SegmentWriter } from "./segments.js";

/**
 * The incremental archive walk.
 *
 * Two independent things make a run cheap on the second pass. A file whose
 * `(path, size, mtime)` already matches an indexed row is never opened, so an
 * unchanged corpus costs a stat per file; and a file that *is* opened but whose
 * hash is already a stored blob is never written again, so a file that was
 * merely touched, or that duplicates another, costs nothing but its row.
 */

export interface Candidate {
  provider: string;
  set: ArtifactSet;
  /** Absolute path on disk. */
  file: string;
  /** Path recorded in the index: absolute, because that is what identifies it. */
  recordPath: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface RunCounters {
  /** Files the sets matched. */
  discovered: number;
  /** Already indexed at this size and mtime; never opened. */
  unchanged: number;
  /** Opened and hashed. */
  hashed: number;
  /** Hashed, but the content was already stored; only a row was written. */
  duplicate: number;
  /** Written into a segment. */
  stored: number;
  /** Matched but unreadable. */
  skipped: number;
  /** Uncompressed bytes added. */
  bytes: number;
}

export interface RunFailure {
  file: string;
  reason: string;
}

export interface RunResult {
  counters: RunCounters;
  failures: RunFailure[];
  segments: { name: string; bytes: number; blobs: number }[];
  /** Per class, what this run took in. */
  byClass: Record<string, { discovered: number; stored: number; bytes: number }>;
}

export function emptyCounters(): RunCounters {
  return {
    discovered: 0,
    unchanged: 0,
    hashed: 0,
    duplicate: 0,
    stored: 0,
    skipped: 0,
    bytes: 0,
  };
}

/**
 * Walks one set, yielding what it matches.
 *
 * Symbolic links are not followed. A link into a directory the sets deliberately
 * exclude would otherwise pull it in anyway, which is the failure mode the
 * allowlist in `sets.ts` exists to prevent.
 */
export function collectSet(root: string, provider: string, set: ArtifactSet): Candidate[] {
  const base = set.root ? path.join(root, set.root) : root;
  const found: Candidate[] = [];

  const walk = (directory: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      // A directory that is absent or unreadable simply contributes nothing.
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (set.recursive) walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!set.match(relative)) continue;
      let stats: fs.Stats;
      try {
        stats = fs.statSync(absolute);
      } catch {
        continue;
      }
      found.push({
        provider,
        set,
        file: absolute,
        recordPath: absolute,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        mode: stats.mode & 0o777,
      });
    }
  };

  walk(base, "");
  // Byte comparison, never localeCompare: segment membership must not depend on
  // the ICU build of the machine that ran the archive.
  found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return found;
}

/**
 * One provider present on this machine, with the trees its sets are relative to.
 *
 * `altRoot` is resolved by the caller alongside `root` and is null for every
 * provider but Cursor; a set marked `tree: "alt"` contributes nothing when it is
 * absent rather than falling back to the primary root, which would walk the
 * wrong tree.
 */
export interface ArchiveSource {
  provider: UsageProvider;
  root: string;
  altRoot?: string | null;
}

/** Everything the selected classes match, across the selected providers. */
export function collect(
  sources: ReadonlyArray<ArchiveSource>,
  classes: readonly ArtifactClass[],
): Candidate[] {
  const wanted = new Set(classes);
  const found: Candidate[] = [];
  for (const source of sources) {
    const profile = profileFor(source.provider.name);
    if (!profile) continue;
    for (const set of profile.sets) {
      if (!wanted.has(set.class)) continue;
      const base = set.tree === "alt" ? (source.altRoot ?? null) : source.root;
      if (!base) continue;
      found.push(...collectSet(base, source.provider.name, set));
    }
  }
  return found;
}

/**
 * Reads a candidate's bytes.
 *
 * A set marked `snapshot: "sqlite"` is copied through the online backup API into
 * a temporary file rather than read directly: those databases carry live `-wal`
 * sidecars, and a byte copy of the main file alone can capture a page image torn
 * mid-write. The snapshot is a single consistent file, which is also what makes
 * it worth archiving — a `.db` without its `-wal` may be missing recent writes.
 */
async function readCandidate(candidate: Candidate): Promise<Buffer> {
  if (candidate.set.snapshot !== "sqlite") return fs.readFileSync(candidate.file);

  const sqlite = loadSqlite();
  if (!sqlite) return fs.readFileSync(candidate.file);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-snapshot-"));
  const target = path.join(scratch, "snapshot.db");
  let source: SqliteDatabase | undefined;
  try {
    source = new sqlite.DatabaseSync(candidate.file, { readOnly: true });
    const backup = (sqlite as unknown as { backup: (db: unknown, to: string) => Promise<number> })
      .backup;
    await backup(source, target);
    return fs.readFileSync(target);
  } finally {
    closeQuietly(source);
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

interface IndexedArtifact {
  size: number;
  mtimeMs: number;
}

/**
 * The key a candidate and its stored row are matched on.
 *
 * One helper for both sides on purpose: they were briefly written separately,
 * with different separators, and the result was an archive that re-hashed its
 * entire corpus on every run while still producing correct output — a bug with
 * no wrong answer to give it away.
 *
 * The separator is a NUL, for the same reason `sessionKey` in
 * `src/usage/events.ts` uses one: it cannot occur in either half. A space can
 * and does occur in a path.
 */
function artifactKey(provider: string, file: string): string {
  return `${provider}\u0000${file}`;
}

/** What the index already holds, keyed by {@link artifactKey}. */
function indexedArtifacts(db: SqliteDatabase): Map<string, IndexedArtifact> {
  const found = new Map<string, IndexedArtifact>();
  // The newest row per path is the one whose size and mtime a freshness test
  // should compare against; an older row describes a version since replaced.
  for (const row of db
    .prepare(
      `SELECT provider, path, size, mtime_ms FROM artifact
        WHERE id IN (SELECT MAX(id) FROM artifact GROUP BY provider, path)`,
    )
    .all()) {
    found.set(artifactKey(String(row.provider), String(row.path)), {
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
    });
  }
  return found;
}

export interface RunOptions {
  archiveRoot: string;
  sources: ReadonlyArray<ArchiveSource>;
  classes: readonly ArtifactClass[];
  /** Report what would be taken in, storing nothing. */
  dryRun?: boolean;
  segmentBytes?: number;
  /**
   * Told what happened as it happens.
   *
   * The engine reports events; how they are drawn is the command's business, so
   * nothing here knows about terminals, colours, or `--verbose`.
   */
  reporter?: RunReporter;
}

export async function runArchive(options: RunOptions): Promise<RunResult> {
  const counters = emptyCounters();
  const failures: RunFailure[] = [];
  const byClass: RunResult["byClass"] = {};
  const bump = (name: string, field: "discovered" | "stored", amount = 1): void => {
    const entry = (byClass[name] ??= { discovered: 0, stored: 0, bytes: 0 });
    entry[field] += amount;
  };

  const candidates = collect(options.sources, options.classes);
  counters.discovered = candidates.length;
  let plannedBytes = 0;
  for (const candidate of candidates) {
    bump(candidate.set.class, "discovered");
    plannedBytes += candidate.size;
  }
  const reporter = options.reporter;
  reporter?.start?.({ files: candidates.length, bytes: plannedBytes });

  if (options.dryRun) {
    // Nothing is opened: a dry run reports what the sets matched and how much it
    // is, from the stat the walk already did.
    for (const candidate of candidates) {
      counters.bytes += candidate.size;
      (byClass[candidate.set.class] ??= { discovered: 0, stored: 0, bytes: 0 }).bytes +=
        candidate.size;
    }
    reporter?.finish?.();
    return { counters, failures, segments: [], byClass };
  }

  const opened = openArchive({ root: options.archiveRoot });
  const db = opened.db;
  try {
    const indexed = indexedArtifacts(db);
    /**
     * Blobs the index already holds, so an artifact row may reference them now.
     */
    const storedBlobs = new Set(
      db
        .prepare("SELECT sha256 FROM blob")
        .all()
        .map((row) => String(row.sha256)),
    );
    /**
     * Blobs buffered for the segment currently being built.
     *
     * Kept apart from {@link storedBlobs} because the two demand opposite
     * handling, and conflating them is a foreign key violation: a second file
     * with the same content as one still in the buffer cannot have its row
     * written yet, because the `blob` row it would reference does not exist
     * until that segment is sealed. It waits instead.
     */
    const pendingBlobs = new Set<string>();
    const nextSequence = Number(db.prepare("SELECT COUNT(*) AS n FROM segment").get()?.n ?? 0) + 1;

    const writer = new SegmentWriter(
      segmentsDirectory(options.archiveRoot),
      nextSequence,
      options.segmentBytes ?? DEFAULT_SEGMENT_BYTES,
    );

    const now = new Date().toISOString();
    const insertSegment = db.prepare(
      "INSERT INTO segment(name, bytes, blobs, sha256, sealed_at) VALUES(?,?,?,?,?)",
    );
    const insertBlob = db.prepare(
      "INSERT OR IGNORE INTO blob(sha256, size, segment_id, offset, stored_at) VALUES(?,?,?,?,?)",
    );
    const insertArtifact = db.prepare(
      `INSERT INTO artifact(provider, set_id, class, path, sha256, size, mtime_ms, mode,
         first_seen, last_seen)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider, path, sha256) DO UPDATE SET last_seen = excluded.last_seen`,
    );

    /** Rows waiting on the segment their content is being written into. */
    let waiting: Array<{ candidate: Candidate; sha256: string }> = [];

    const writeArtifact = (candidate: Candidate, sha256: string): void => {
      insertArtifact.run(
        candidate.provider,
        candidate.set.id,
        candidate.set.class,
        candidate.recordPath,
        sha256,
        candidate.size,
        candidate.mtimeMs,
        candidate.mode,
        now,
        now,
      );
    };

    /**
     * Seals whatever is buffered and writes the rows that were waiting on it.
     *
     * Segment, blobs and artifact rows go in together: an artifact row pointing
     * at a blob whose segment was never recorded would be an index that cannot
     * find its own content.
     */
    const commitSegment = (): void => {
      const segment = writer.flush();
      if (!segment) return;
      transact(db, () => {
        const inserted = insertSegment.run(
          segment.name,
          segment.bytes,
          segment.blobs.length,
          segment.sha256,
          now,
        );
        const segmentId = Number(inserted.lastInsertRowid);
        for (const blob of segment.blobs) {
          insertBlob.run(blob.sha256, blob.size, segmentId, blob.offset, now);
          storedBlobs.add(blob.sha256);
        }
        for (const row of waiting) writeArtifact(row.candidate, row.sha256);
      });
      waiting = [];
      pendingBlobs.clear();
      reporter?.segment?.({
        name: segment.name,
        bytes: segment.bytes,
        blobs: segment.blobs.length,
      });
    };

    for (const candidate of candidates) {
      const previous = indexed.get(artifactKey(candidate.provider, candidate.recordPath));
      if (previous && previous.size === candidate.size && previous.mtimeMs === candidate.mtimeMs) {
        counters.unchanged += 1;
        reporter?.file?.({
          path: candidate.recordPath,
          class: candidate.set.class,
          size: candidate.size,
          disposition: "unchanged",
        });
        continue;
      }

      let content: Buffer;
      try {
        content = await readCandidate(candidate);
      } catch (error) {
        counters.skipped += 1;
        const reason = (error as Error).message;
        failures.push({ file: candidate.file, reason });
        reporter?.failure?.({ file: candidate.file, reason });
        reporter?.file?.({
          path: candidate.recordPath,
          class: candidate.set.class,
          size: candidate.size,
          disposition: "skipped",
        });
        continue;
      }

      counters.hashed += 1;
      const sha256 = hashBuffer(content);

      const seen = (disposition: "stored" | "duplicate"): void =>
        reporter?.file?.({
          path: candidate.recordPath,
          class: candidate.set.class,
          size: candidate.size,
          disposition,
          sha256,
        });

      if (storedBlobs.has(sha256)) {
        // Same bytes under a new path, or a file touched without being changed.
        counters.duplicate += 1;
        transact(db, () => writeArtifact(candidate, sha256));
        seen("duplicate");
        continue;
      }

      if (pendingBlobs.has(sha256)) {
        // Content this same run has already buffered. One member covers both
        // paths, so only the row is added — once the segment is sealed.
        counters.duplicate += 1;
        waiting.push({ candidate, sha256 });
        seen("duplicate");
        continue;
      }

      counters.stored += 1;
      counters.bytes += content.length;
      bump(candidate.set.class, "stored");
      (byClass[candidate.set.class] ??= { discovered: 0, stored: 0, bytes: 0 }).bytes +=
        content.length;

      pendingBlobs.add(sha256);
      waiting.push({ candidate, sha256 });
      seen("stored");
      writer.add({ sha256, content, mode: candidate.mode });
      if (writer.shouldSeal) commitSegment();
    }

    commitSegment();
    reporter?.finish?.();

    return {
      counters,
      failures,
      segments: writer.sealed.map((segment) => ({
        name: segment.name,
        bytes: segment.bytes,
        blobs: segment.blobs.length,
      })),
      byClass,
    };
  } finally {
    closeQuietly(db);
  }
}
