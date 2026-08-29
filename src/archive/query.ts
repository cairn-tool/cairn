import fs from "node:fs";
import path from "node:path";
import type { SqliteDatabase } from "../sqlite.js";
import { closeQuietly } from "../sqlite-store.js";
import { LATEST_VERSION, indexPath, openArchive, segmentsDirectory } from "./db.js";
import { extractBlob, hashBuffer, readSegment } from "./segments.js";

/** Reading the archive: what it holds, and getting a file back out of it. */

export interface ArchiveStatus {
  root: string;
  present: boolean;
  schemaVersion: number;
  segments: number;
  blobs: number;
  artifacts: number;
  /** Distinct paths, which is fewer than `artifacts` once anything has changed. */
  paths: number;
  /** Uncompressed bytes of stored content. */
  bytes: number;
  /** Bytes the segments actually occupy. */
  compressedBytes: number;
  updatedAt: string | null;
  byClass: Record<string, { artifacts: number; bytes: number }>;
  byProvider: Record<string, number>;
}

function emptyStatus(root: string): ArchiveStatus {
  return {
    root,
    present: false,
    schemaVersion: LATEST_VERSION,
    segments: 0,
    blobs: 0,
    artifacts: 0,
    paths: 0,
    bytes: 0,
    compressedBytes: 0,
    updatedAt: null,
    byClass: {},
    byProvider: {},
  };
}

export function archiveStatus(root: string): ArchiveStatus {
  if (!fs.existsSync(indexPath(root))) return emptyStatus(root);
  let opened;
  try {
    opened = openArchive({ root, readOnly: true, migrate: false });
  } catch {
    return emptyStatus(root);
  }
  try {
    const db = opened.db;
    const one = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
    const byClass: ArchiveStatus["byClass"] = {};
    for (const row of db
      .prepare(
        `SELECT a.class, COUNT(*) AS n, COALESCE(SUM(b.size), 0) AS bytes
           FROM artifact a JOIN blob b ON b.sha256 = a.sha256
          GROUP BY a.class ORDER BY a.class`,
      )
      .all()) {
      byClass[String(row.class)] = { artifacts: Number(row.n), bytes: Number(row.bytes) };
    }
    const byProvider: Record<string, number> = {};
    for (const row of db
      .prepare("SELECT provider, COUNT(*) AS n FROM artifact GROUP BY provider ORDER BY provider")
      .all()) {
      byProvider[String(row.provider)] = Number(row.n);
    }
    const updated = db.prepare("SELECT MAX(last_seen) AS at FROM artifact").get()?.at;
    return {
      root,
      present: true,
      schemaVersion: Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0),
      segments: one("SELECT COUNT(*) AS n FROM segment"),
      blobs: one("SELECT COUNT(*) AS n FROM blob"),
      artifacts: one("SELECT COUNT(*) AS n FROM artifact"),
      paths: one("SELECT COUNT(*) AS n FROM (SELECT DISTINCT provider, path FROM artifact)"),
      bytes: one("SELECT COALESCE(SUM(size), 0) AS n FROM blob"),
      compressedBytes: one("SELECT COALESCE(SUM(bytes), 0) AS n FROM segment"),
      updatedAt: typeof updated === "string" ? updated : null,
      byClass,
      byProvider,
    };
  } catch {
    return emptyStatus(root);
  } finally {
    closeQuietly(opened.db);
  }
}

export interface ListFilter {
  providers?: readonly string[];
  class?: string;
  /** Inclusive lower bound on `last_seen`, as an ISO day. */
  since?: string;
  limit?: number;
}

export interface ArchivedFile {
  provider: string;
  set: string;
  class: string;
  path: string;
  sha256: string;
  size: number;
  firstSeen: string;
  lastSeen: string;
  /** How many distinct versions of this path the archive holds. */
  versions: number;
}

export function listArtifacts(db: SqliteDatabase, filter: ListFilter): ArchivedFile[] {
  // Only the newest row per path is listed; older rows are that path's history
  // and are reported as `versions` rather than as separate lines.
  const conditions = ["a.id IN (SELECT MAX(id) FROM artifact GROUP BY provider, path)"];
  const parameters: (string | number)[] = [];
  if (filter.providers && filter.providers.length > 0) {
    conditions.push(`a.provider IN (${filter.providers.map(() => "?").join(",")})`);
    parameters.push(...filter.providers);
  }
  if (filter.class) {
    conditions.push("a.class = ?");
    parameters.push(filter.class);
  }
  if (filter.since) {
    conditions.push("a.last_seen >= ?");
    parameters.push(filter.since);
  }
  // The limit is interpolated because SQLite will not bind a LIMIT, and is
  // floored to an integer here rather than trusted from the caller.
  const limit = filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : "";

  const rows = db
    .prepare(
      `SELECT a.provider, a.set_id, a.class, a.path, a.sha256, a.size,
              a.first_seen, a.last_seen,
              (SELECT COUNT(*) FROM artifact v
                WHERE v.provider = a.provider AND v.path = a.path) AS versions
         FROM artifact a
        WHERE ${conditions.join(" AND ")}
        ORDER BY a.last_seen DESC, a.path ASC
        ${limit}`,
    )
    .all(...parameters);

  return rows.map((row) => ({
    provider: String(row.provider),
    set: String(row.set_id),
    class: String(row.class),
    path: String(row.path),
    sha256: String(row.sha256),
    size: Number(row.size),
    firstSeen: String(row.first_seen),
    lastSeen: String(row.last_seen),
    versions: Number(row.versions),
  }));
}

export interface ResolvedBlob {
  sha256: string;
  size: number;
  offset: number;
  segment: string;
  path: string;
}

/**
 * Finds what to extract, by hash or by original path.
 *
 * A path may have several versions; the newest wins unless a hash was given,
 * which is how an older one is reached. A hash prefix is accepted because a full
 * sha256 is not something anyone types.
 */
export function resolve(db: SqliteDatabase, target: string): ResolvedBlob[] {
  const byHash = db
    .prepare(
      `SELECT b.sha256, b.size, b.offset, s.name AS segment,
              (SELECT path FROM artifact WHERE sha256 = b.sha256 ORDER BY id DESC LIMIT 1) AS path
         FROM blob b JOIN segment s ON s.id = b.segment_id
        WHERE b.sha256 = ? OR b.sha256 LIKE ?`,
    )
    .all(target, `${target}%`);
  if (byHash.length > 0) {
    return byHash.map((row) => ({
      sha256: String(row.sha256),
      size: Number(row.size),
      offset: Number(row.offset),
      segment: String(row.segment),
      path: String(row.path ?? row.sha256),
    }));
  }

  const byPath = db
    .prepare(
      `SELECT b.sha256, b.size, b.offset, s.name AS segment, a.path
         FROM artifact a
         JOIN blob b ON b.sha256 = a.sha256
         JOIN segment s ON s.id = b.segment_id
        WHERE a.path = ?
        ORDER BY a.id DESC LIMIT 1`,
    )
    .all(target);
  return byPath.map((row) => ({
    sha256: String(row.sha256),
    size: Number(row.size),
    offset: Number(row.offset),
    segment: String(row.segment),
    path: String(row.path),
  }));
}

export interface ExtractResult {
  path: string;
  sha256: string;
  bytes: number;
  written: string;
}

/** Writes one resolved blob into `outDir`, under its original basename. */
export function extract(root: string, blob: ResolvedBlob, outDir: string): ExtractResult {
  const uncompressed = readSegment(segmentsDirectory(root), blob.segment);
  const content = extractBlob(uncompressed, blob);
  fs.mkdirSync(outDir, { recursive: true });
  const written = path.join(outDir, path.basename(blob.path));
  fs.writeFileSync(written, content);
  return { path: blob.path, sha256: blob.sha256, bytes: content.length, written };
}

export interface VerifyFinding {
  segment: string;
  issue: string;
}

export interface VerifyResult {
  segments: number;
  blobs: number;
  checked: number;
  findings: VerifyFinding[];
  deep: boolean;
}

/**
 * Checks the archive against its index.
 *
 * The default pass hashes each segment file, which catches a truncated or
 * corrupted archive for the cost of reading it. `--deep` also decompresses every
 * segment and re-hashes each member, which additionally catches an index whose
 * offsets no longer point where it claims.
 */
export function verify(root: string, deep: boolean): VerifyResult {
  const result: VerifyResult = { segments: 0, blobs: 0, checked: 0, findings: [], deep };
  if (!fs.existsSync(indexPath(root))) return result;

  const opened = openArchive({ root, readOnly: true, migrate: false });
  const directory = segmentsDirectory(root);
  try {
    const db = opened.db;
    const segments = db.prepare("SELECT id, name, sha256 FROM segment ORDER BY id").all();
    result.segments = segments.length;

    for (const segment of segments) {
      const name = String(segment.name);
      const file = path.join(directory, name);
      let raw: Buffer;
      try {
        raw = fs.readFileSync(file);
      } catch {
        result.findings.push({ segment: name, issue: "missing from the segments directory" });
        continue;
      }
      const actual = hashBuffer(raw);
      if (actual !== String(segment.sha256)) {
        result.findings.push({
          segment: name,
          issue: `hash mismatch: index says ${String(segment.sha256).slice(0, 12)}, file is ${actual.slice(0, 12)}`,
        });
        // A segment whose bytes already disagree cannot say anything useful
        // about its members, so it is not opened further.
        continue;
      }
      result.checked += 1;

      const blobs = db
        .prepare("SELECT sha256, size, offset FROM blob WHERE segment_id = ?")
        .all(Number(segment.id));
      result.blobs += blobs.length;
      if (!deep) continue;

      let uncompressed: Buffer;
      try {
        uncompressed = readSegment(directory, name);
      } catch (error) {
        result.findings.push({
          segment: name,
          issue: `will not decompress: ${(error as Error).message}`,
        });
        continue;
      }
      for (const blob of blobs) {
        try {
          extractBlob(uncompressed, {
            sha256: String(blob.sha256),
            size: Number(blob.size),
            offset: Number(blob.offset),
          });
        } catch (error) {
          result.findings.push({
            segment: name,
            issue: `${String(blob.sha256).slice(0, 12)}: ${(error as Error).message}`,
          });
        }
      }
    }
    return result;
  } finally {
    closeQuietly(opened.db);
  }
}
