import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { archive as tarGz, tarball } from "../agent/package/tar.js";
import type { TarEntry } from "../agent/package/tar.js";
import { listMembers, readMember } from "./tar-read.js";

/**
 * Append-only compressed segments.
 *
 * A segment is a deterministic `.tar.gz` built by the writer in
 * `src/agent/package/tar.ts`, which already pins mtime, uid, gid, uname and
 * entry order. Once sealed it is never rewritten: a later run adds a new
 * segment, which is what makes the archive safe to copy to slower storage and
 * what keeps an interrupted run from corrupting what came before.
 *
 * Members are named `blobs/<aa>/<sha256>` rather than by their original path,
 * for two reasons. Deduplication falls out of it — two identical files are one
 * member — and every name is then 73 characters, comfortably inside the ustar
 * `name` field. Real paths would not be: the source corpus nests seven deep
 * under project slugs that are themselves absolute paths with the separators
 * replaced, and `tarball` refuses a path that will not fit rather than escalating
 * to a PAX header.
 */

/** Default seal threshold, in uncompressed bytes. */
export const DEFAULT_SEGMENT_BYTES = 64 * 1024 * 1024;

export interface PendingBlob {
  sha256: string;
  content: Buffer;
  mode: number;
}

export interface StoredBlob {
  sha256: string;
  size: number;
  /** Byte offset of the member's data within the uncompressed segment. */
  offset: number;
}

export interface SealedSegment {
  name: string;
  /** Size of the `.tar.gz` on disk. */
  bytes: number;
  /** Hash of the `.tar.gz`, which is what `archive verify` checks. */
  sha256: string;
  blobs: StoredBlob[];
}

export function hashBuffer(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function memberPath(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

export function segmentName(sequence: number): string {
  return `seg-${String(sequence).padStart(6, "0")}.tar.gz`;
}

/**
 * Writes pending blobs as one sealed segment.
 *
 * The archive is built once and then read to find each member's offset, rather
 * than the offsets being predicted from the entry sizes. Predicting them would
 * duplicate the writer's padding and header rules in a second place, where they
 * could drift; reading them back cannot be wrong about a file this same process
 * just produced.
 */
export function sealSegment(
  directory: string,
  sequence: number,
  pending: readonly PendingBlob[],
): SealedSegment {
  const entries: TarEntry[] = pending.map((blob) => ({
    path: memberPath(blob.sha256),
    content: blob.content,
    mode: blob.mode,
  }));

  const uncompressed = tarball(entries);
  const members = new Map(
    listMembers(uncompressed)
      .filter((member) => !member.directory)
      .map((member) => [member.path, member]),
  );

  const blobs: StoredBlob[] = pending.map((blob) => {
    const member = members.get(memberPath(blob.sha256));
    if (!member) throw new Error(`Segment is missing the member it was built with: ${blob.sha256}`);
    return { sha256: blob.sha256, size: member.size, offset: member.offset };
  });

  const name = segmentName(sequence);
  const payload = tarGz(entries);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, name);
  // Written to a temporary name and renamed, so an interrupted run never leaves
  // a half-written segment that the index would then claim is complete.
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, payload);
  fs.renameSync(temporary, target);

  return { name, bytes: payload.length, sha256: hashBuffer(payload), blobs };
}

/** Decompresses a segment. Callers that want several members read it once. */
export function readSegment(directory: string, name: string): Buffer {
  return zlib.gunzipSync(fs.readFileSync(path.join(directory, name)));
}

/**
 * Extracts one blob from an already-decompressed segment.
 *
 * The offset comes from the index, so this is a slice rather than a walk. The
 * hash is re-checked against the content because an archive whose index and
 * bytes disagree should say so rather than hand back the wrong file.
 */
export function extractBlob(uncompressed: Buffer, blob: StoredBlob): Buffer {
  const content = readMember(uncompressed, {
    path: memberPath(blob.sha256),
    mode: 0,
    size: blob.size,
    offset: blob.offset,
    directory: false,
  });
  const actual = hashBuffer(content);
  if (actual !== blob.sha256) {
    throw new Error(`Archive corruption: expected ${blob.sha256}, segment holds ${actual}`);
  }
  return content;
}

/**
 * Accumulates blobs and seals a segment when the threshold is reached.
 *
 * The threshold is on *uncompressed* bytes because that is what bounds memory:
 * the tar is built whole before it is compressed. A blob larger than the
 * threshold gets a segment to itself rather than being split, since a member
 * spanning two archives could not be read by `tar`.
 */
export class SegmentWriter {
  private pending: PendingBlob[] = [];
  private pendingBytes = 0;
  private sequence: number;
  readonly sealed: SealedSegment[] = [];

  constructor(
    private readonly directory: string,
    firstSequence: number,
    private readonly threshold: number = DEFAULT_SEGMENT_BYTES,
  ) {
    this.sequence = firstSequence;
  }

  add(blob: PendingBlob): void {
    this.pending.push(blob);
    this.pendingBytes += blob.content.length;
  }

  /**
   * Whether the buffer has reached the threshold.
   *
   * Sealing is the caller's move rather than a side effect of {@link add},
   * because the index rows for the blobs in a segment can only be written once
   * that segment has an id — so the caller has to know exactly when it happened.
   */
  get shouldSeal(): boolean {
    return this.pendingBytes >= this.threshold;
  }

  get buffered(): number {
    return this.pending.length;
  }

  flush(): SealedSegment | null {
    if (this.pending.length === 0) return null;
    const segment = sealSegment(this.directory, this.sequence, this.pending);
    this.sealed.push(segment);
    this.sequence += 1;
    this.pending = [];
    this.pendingBytes = 0;
    return segment;
  }
}
