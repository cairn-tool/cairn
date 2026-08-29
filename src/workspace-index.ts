import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MarkdownDocument } from "./workspace.js";

const INDEX_VERSION = 1;
const STALE_LOCK_MS = 30_000;

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

interface IndexRecord {
  fingerprint: FileFingerprint;
  document: MarkdownDocument;
}

interface IndexFile {
  version: number;
  root: string;
  renderer: string;
  documents: Record<string, IndexRecord>;
}

export interface WorkspaceIndexStatus {
  cachePath: string;
  exists: boolean;
  version: number;
  indexed: number;
  current: number;
  stale: number;
  missing: number;
}

export function getWorkspaceIndexPath(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const base = env.XDG_CACHE_HOME || path.join(home, ".cache");
  const key = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
  return path.join(base, "cairn", "workspaces", `${key}.json`);
}

export function fingerprint(filePath: string): FileFingerprint {
  const stat = fs.statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function acquireLock(cachePath: string): number {
  const lockPath = `${cachePath}.lock`;
  try {
    return fs.openSync(lockPath, "wx");
  } catch (error) {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
        fs.rmSync(lockPath, { force: true });
        return fs.openSync(lockPath, "wx");
      }
    } catch {
      // Preserve the original lock acquisition failure.
    }
    throw error;
  }
}

function releaseLock(cachePath: string, lock: number | undefined, strict: boolean): void {
  if (lock === undefined) return;
  try {
    fs.closeSync(lock);
    fs.rmSync(`${cachePath}.lock`, { force: true });
  } catch (error) {
    if (strict) throw error;
  }
}

function validIndex(value: unknown, root: string, renderer: string): value is IndexFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IndexFile>;
  const validHeader =
    candidate.version === INDEX_VERSION &&
    candidate.root === root &&
    candidate.renderer === renderer &&
    !!candidate.documents &&
    typeof candidate.documents === "object";
  if (!validHeader) return false;
  return Object.values(candidate.documents as Record<string, unknown>).every((value) => {
    if (!value || typeof value !== "object") return false;
    const record = value as Partial<IndexRecord>;
    const document = record.document as Partial<MarkdownDocument> | undefined;
    return (
      !!record.fingerprint &&
      typeof record.fingerprint.size === "number" &&
      typeof record.fingerprint.mtimeMs === "number" &&
      !!document &&
      typeof document.path === "string" &&
      typeof document.content === "string" &&
      Array.isArray(document.lines) &&
      !!document.tree &&
      typeof document.tree === "object" &&
      Array.isArray(document.headings) &&
      Array.isArray(document.references) &&
      !!document.frontmatter &&
      typeof document.frontmatter === "object"
    );
  });
}

export class WorkspaceIndex {
  private loaded = false;
  private exists = false;
  private documents: Record<string, IndexRecord> = {};
  private readonly changed = new Map<string, IndexRecord>();
  private readonly removed = new Set<string>();

  constructor(
    readonly root: string,
    readonly renderer: string,
    readonly cachePath = getWorkspaceIndexPath(root),
  ) {}

  private key(filePath: string): string | undefined {
    const absolute = path.resolve(filePath);
    const relative = path.relative(this.root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
    return relative.split(path.sep).join("/");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
      if (!validIndex(parsed, this.root, this.renderer)) return;
      this.documents = parsed.documents;
      this.exists = true;
    } catch {
      // The index is an optimization. Missing or corrupt data is a cache miss.
    }
  }

  get(filePath: string, current: FileFingerprint): MarkdownDocument | undefined {
    this.load();
    const key = this.key(filePath);
    if (key === undefined || this.removed.has(key)) return undefined;
    const record = this.changed.get(key) ?? this.documents[key];
    if (!record || !sameFingerprint(record.fingerprint, current)) return undefined;
    return record.document;
  }

  set(filePath: string, current: FileFingerprint, document: MarkdownDocument): void {
    this.load();
    const key = this.key(filePath);
    if (key === undefined) return;
    this.changed.set(key, { fingerprint: current, document });
    this.removed.delete(key);
  }

  invalidate(filePath: string): void {
    this.load();
    const key = this.key(filePath);
    if (key === undefined) return;
    this.changed.delete(key);
    this.removed.add(key);
  }

  replace(
    directory: string,
    records: Map<string, { fingerprint: FileFingerprint; document: MarkdownDocument }>,
  ): void {
    this.load();
    const prefix = this.key(directory);
    if (prefix === undefined) return;
    const within = (key: string): boolean =>
      prefix === "" || key === prefix || key.startsWith(`${prefix}/`);
    for (const key of Object.keys(this.documents)) if (within(key)) this.removed.add(key);
    for (const key of this.changed.keys()) if (within(key)) this.removed.add(key);
    for (const [file, record] of records) this.set(file, record.fingerprint, record.document);
  }

  status(files: string[]): WorkspaceIndexStatus {
    this.load();
    let current = 0;
    let stale = 0;
    let missing = 0;
    for (const file of files) {
      const key = this.key(file);
      const record = key === undefined ? undefined : (this.changed.get(key) ?? this.documents[key]);
      if (!record) {
        missing++;
      } else if (sameFingerprint(record.fingerprint, fingerprint(file))) {
        current++;
      } else {
        stale++;
      }
    }
    return {
      cachePath: this.cachePath,
      exists: this.exists,
      version: INDEX_VERSION,
      indexed: Object.keys(this.documents).length,
      current,
      stale,
      missing,
    };
  }

  clear(strict = false): void {
    this.documents = {};
    this.changed.clear();
    this.removed.clear();
    this.loaded = true;
    this.exists = false;
    let lock: number | undefined;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      lock = acquireLock(this.cachePath);
      fs.rmSync(this.cachePath, { force: true });
    } catch (error) {
      if (strict) throw error;
    } finally {
      releaseLock(this.cachePath, lock, strict);
    }
  }

  flush(strict = false): void {
    if (this.changed.size === 0 && this.removed.size === 0) return;
    let lock: number | undefined;
    let temporary: string | undefined;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      lock = acquireLock(this.cachePath);
      let merged = { ...this.documents };
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
        if (validIndex(parsed, this.root, this.renderer)) merged = { ...parsed.documents };
      } catch {
        // Start a new index when the previous file is absent or invalid.
      }
      for (const key of this.removed) delete merged[key];
      for (const [key, record] of this.changed) merged[key] = record;
      temporary = `${this.cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          version: INDEX_VERSION,
          root: this.root,
          renderer: this.renderer,
          documents: merged,
        }),
        "utf-8",
      );
      fs.renameSync(temporary, this.cachePath);
      this.documents = merged;
      this.changed.clear();
      this.removed.clear();
      this.exists = true;
    } catch (error) {
      if (strict) throw error;
    } finally {
      if (temporary) {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // A temporary cache artifact must not affect command behavior.
        }
      }
      releaseLock(this.cachePath, lock, strict);
    }
  }
}
