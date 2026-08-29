import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUrlCache, urlCacheKey, writeUrlCache } from "../../src/url-cache.js";

let directory: string;
let cachePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-url-cache-"));
  cachePath = path.join(directory, "cache.json");
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("URL cache", () => {
  it("keys request-affecting options and excludes allowed statuses", () => {
    const first = urlCacheKey("https://example.com", {
      timeout: 10,
      retries: 1,
      headFallbackStatuses: [405],
    });
    const reordered = urlCacheKey("https://example.com", {
      timeout: 10,
      retries: 1,
      headFallbackStatuses: [501, 405],
    });
    expect(first).not.toBe(reordered);
  });

  it("treats stale and corrupt data as misses", () => {
    const key = "key";
    const result = { status: 200, redirected: false, finalUrl: "https://example.com" };
    expect(writeUrlCache(cachePath, key, result, 100)).toBe(true);
    expect(readUrlCache(cachePath, key, 10, 109)).toEqual(result);
    expect(readUrlCache(cachePath, key, 10, 110)).toBeUndefined();
    fs.writeFileSync(cachePath, "bad json");
    expect(readUrlCache(cachePath, key, 10, 105)).toBeUndefined();
  });
});
