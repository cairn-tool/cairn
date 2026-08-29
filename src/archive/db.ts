import os from "node:os";
import path from "node:path";
import type { Migration, StoreHandle } from "../sqlite-store.js";
import { latestVersion, openStore } from "../sqlite-store.js";

/**
 * The archive index.
 *
 * Content-addressed, which is what makes the archive incremental in both
 * directions at once. A file whose bytes have not changed is already a `blob`
 * and is not stored again; a file whose bytes *have* changed gets a second
 * `artifact` row against a new blob, so the archive keeps every version it ever
 * saw without anyone asking it to.
 *
 * The index is a convenience, not the archive. Every segment is a plain
 * `.tar.gz` whose members are named by their own hash, so `tar tzf` recovers the
 * contents with no database and no `cairn` — which is the whole point of
 * choosing a standard container for something meant to outlive the tool.
 */
const SCHEMA_V1 = `
CREATE TABLE meta(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE segment(
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  bytes     INTEGER NOT NULL,
  blobs     INTEGER NOT NULL,
  sha256    TEXT    NOT NULL,
  sealed_at TEXT    NOT NULL
);

CREATE TABLE blob(
  sha256     TEXT    PRIMARY KEY,
  size       INTEGER NOT NULL,
  segment_id INTEGER NOT NULL REFERENCES segment(id),
  offset     INTEGER NOT NULL,
  stored_at  TEXT    NOT NULL
);

CREATE TABLE artifact(
  id         INTEGER PRIMARY KEY,
  provider   TEXT    NOT NULL,
  set_id     TEXT    NOT NULL,
  class      TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL REFERENCES blob(sha256),
  size       INTEGER NOT NULL,
  mtime_ms   REAL    NOT NULL,
  mode       INTEGER NOT NULL,
  first_seen TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  UNIQUE(provider, path, sha256)
);

CREATE INDEX artifact_path  ON artifact(provider, path);
CREATE INDEX artifact_class ON artifact(class, last_seen);
CREATE INDEX blob_segment   ON blob(segment_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "Initial schema: segments, blobs, and artifact path history",
    up(db) {
      db.exec(SCHEMA_V1);
    },
  },
];

export const LATEST_VERSION: number = latestVersion(MIGRATIONS);

/**
 * Where the archive lives.
 *
 * Under `XDG_DATA_HOME` like the usage store, and for a stronger version of the
 * same reason: this one holds the only copy of files whose originals may since
 * have been deleted. `--archive` points it somewhere else — external or network
 * storage — which is the expected shape once transcripts are included.
 */
export function getArchiveRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const base = configured ? configured : path.join(homedir, ".local", "share");
  return path.join(base, "cairn", "archive");
}

export function indexPath(root: string): string {
  return path.join(root, "archive.db");
}

export function segmentsDirectory(root: string): string {
  return path.join(root, "segments");
}

export interface OpenArchiveOptions {
  root: string;
  readOnly?: boolean;
  migrate?: boolean;
}

export function openArchive(options: OpenArchiveOptions): StoreHandle {
  return openStore({
    path: indexPath(options.root),
    migrations: MIGRATIONS,
    label: "archive index",
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.migrate === false ? { migrate: false } : {}),
  });
}
