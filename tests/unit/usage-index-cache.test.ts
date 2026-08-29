import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_VERSION,
  cacheStatus,
  clearCache,
  getUsageCacheRoot,
  readShard,
  writeShard,
} from "../../src/usage/index-cache.js";
import type { FileAggregate } from "../../src/usage/events.js";

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
  temporary.push(dir);
  return dir;
}

function entry(overrides: Partial<FileAggregate> = {}): FileAggregate {
  return {
    file: "/logs/projects/p/s.jsonl",
    size: 100,
    mtimeMs: 1000,
    provider: "claude-code",
    sessionId: "s",
    kind: "main",
    project: "/tmp/p",
    firstTs: "2026-08-01T00:00:00.000Z",
    lastTs: "2026-08-01T01:00:00.000Z",
    days: {},
    malformedLines: 0,
    ...overrides,
  };
}

describe("getUsageCacheRoot", () => {
  it("honours XDG_CACHE_HOME, and falls back to ~/.cache", () => {
    expect(getUsageCacheRoot("claude-code", { XDG_CACHE_HOME: "/xdg" }, "/home/u")).toBe(
      "/xdg/cairn/usage/claude-code",
    );
    expect(getUsageCacheRoot("claude-code", {}, "/home/u")).toBe(
      "/home/u/.cache/cairn/usage/claude-code",
    );
  });

  it("gives each provider its own directory", () => {
    expect(getUsageCacheRoot("other", { XDG_CACHE_HOME: "/xdg" }, "/home/u")).toBe(
      "/xdg/cairn/usage/other",
    );
  });
});

describe("shards", () => {
  it("round-trips entries", () => {
    const dir = root();
    expect(writeShard(dir, "proj", { "s.jsonl": entry() })).toBe(true);
    expect(readShard(dir, "proj")["s.jsonl"].sessionId).toBe("s");
  });

  it("returns nothing for a shard that was never written", () => {
    expect(readShard(root(), "missing")).toEqual({});
  });

  it("discards a shard written by a different cache version", () => {
    // The version is private and self-invalidating: a mismatch costs a re-parse,
    // never a wrong answer, which is why it is not a published contract version.
    const dir = root();
    writeShard(dir, "proj", { "s.jsonl": entry() });
    const file = path.join(dir, "proj.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    fs.writeFileSync(file, JSON.stringify({ ...stored, version: CACHE_VERSION + 1 }));
    expect(readShard(dir, "proj")).toEqual({});
  });

  it("discards an unparseable shard rather than failing the report", () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, "proj.json"), "{ truncated");
    expect(readShard(dir, "proj")).toEqual({});
  });

  it("keeps a shard name to one path segment", () => {
    const dir = root();
    writeShard(dir, "-Users-x/../escape", { "s.jsonl": entry() });
    expect(fs.readdirSync(dir).every((name) => !name.includes(path.sep))).toBe(true);
    expect(readShard(dir, "-Users-x/../escape")["s.jsonl"]).toBeDefined();
  });
});

describe("cacheStatus and clearCache", () => {
  it("reports an absent cache without creating it", () => {
    const missing = path.join(root(), "nope");
    const status = cacheStatus(missing);
    expect(status).toMatchObject({ present: false, shards: 0, entries: 0, bytes: 0 });
    expect(status.updatedAt).toBeNull();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("counts shards and the transcripts inside them", () => {
    const dir = root();
    writeShard(dir, "a", { "1.jsonl": entry(), "2.jsonl": entry() });
    writeShard(dir, "b", { "3.jsonl": entry() });
    const status = cacheStatus(dir);
    expect(status).toMatchObject({ present: true, shards: 2, entries: 3 });
    expect(status.bytes).toBeGreaterThan(0);
    expect(status.updatedAt).not.toBeNull();
  });

  it("removes every shard and reports how many", () => {
    const dir = root();
    writeShard(dir, "a", { "1.jsonl": entry() });
    writeShard(dir, "b", { "2.jsonl": entry() });
    expect(clearCache(dir)).toBe(2);
    expect(cacheStatus(dir).entries).toBe(0);
    expect(clearCache(path.join(dir, "gone"))).toBe(0);
  });
});
