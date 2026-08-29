import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHECK_INTERVAL_MS,
  LOCK_STALE_MS,
  NOTIFIER_CONTRACT,
  acquireRefreshLock,
  formatNotice,
  getCachePath,
  getLockPath,
  hasJsonOutput,
  isCacheStale,
  isNewerVersion,
  isNotifierAllowed,
  readCache,
  releaseRefreshLock,
  shouldNotify,
  writeCache,
} from "../../src/update-notifier.js";

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-notifier-"));
  cachePath = path.join(tmpDir, "cairn", "update-check.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getCachePath", () => {
  it("honours XDG_CACHE_HOME", () => {
    const p = getCachePath({ XDG_CACHE_HOME: "/xdg" }, "/home/u");
    expect(p).toBe(path.join("/xdg", "cairn", "update-check.json"));
  });

  it("falls back to ~/.cache", () => {
    const p = getCachePath({}, "/home/u");
    expect(p).toBe(path.join("/home/u", ".cache", "cairn", "update-check.json"));
  });

  it("ignores an empty XDG_CACHE_HOME", () => {
    const p = getCachePath({ XDG_CACHE_HOME: "   " }, "/home/u");
    expect(p).toBe(path.join("/home/u", ".cache", "cairn", "update-check.json"));
  });
});

describe("cache read/write", () => {
  it("round-trips", () => {
    expect(writeCache(cachePath, { lastCheckedAt: 123, latestVersion: "1.2.3" })).toBe(true);
    expect(readCache(cachePath)).toEqual({ lastCheckedAt: 123, latestVersion: "1.2.3" });
  });

  it("returns null for a missing cache", () => {
    expect(readCache(path.join(tmpDir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt JSON rather than throwing", () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "{not json");
    expect(readCache(cachePath)).toBeNull();
  });

  it("rejects a cache with a non-numeric timestamp", () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: "soon", latestVersion: "1.0.0" }));
    expect(readCache(cachePath)).toBeNull();
  });

  it("tolerates a missing latestVersion", () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: 5 }));
    expect(readCache(cachePath)).toEqual({ lastCheckedAt: 5, latestVersion: null });
  });
});

describe("isCacheStale", () => {
  it("treats a missing cache as stale", () => {
    expect(isCacheStale(null, 1_000)).toBe(true);
  });

  it("is fresh inside the interval", () => {
    const cache = { lastCheckedAt: 1_000, latestVersion: "1.0.0" };
    expect(isCacheStale(cache, 1_000 + CHECK_INTERVAL_MS - 1)).toBe(false);
  });

  it("is stale at exactly the interval", () => {
    const cache = { lastCheckedAt: 1_000, latestVersion: "1.0.0" };
    expect(isCacheStale(cache, 1_000 + CHECK_INTERVAL_MS)).toBe(true);
  });

  it("re-checks when the clock moved backwards", () => {
    const cache = { lastCheckedAt: 10_000, latestVersion: "1.0.0" };
    expect(isCacheStale(cache, 5_000)).toBe(true);
  });
});

describe("isNewerVersion", () => {
  it("compares each version component", () => {
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
  });

  it("treats a release as newer than its own prerelease", () => {
    expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
  });

  it("reports an update over the placeholder dev version", () => {
    expect(isNewerVersion("1.0.3", "0.0.0-development")).toBe(true);
  });

  it("stays quiet on unparseable input", () => {
    expect(isNewerVersion("banana", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "banana")).toBe(false);
    expect(isNewerVersion("", "1.0.0")).toBe(false);
  });

  it("accepts a v prefix and build metadata", () => {
    expect(isNewerVersion("v1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.1+build.5", "1.0.0")).toBe(true);
  });
});

describe("hasJsonOutput", () => {
  it("detects both spellings", () => {
    expect(hasJsonOutput(["md", "lint", "--format=json"])).toBe(true);
    expect(hasJsonOutput(["md", "lint", "--format", "json"])).toBe(true);
    expect(hasJsonOutput(["md", "lint", "--format=jsonl"])).toBe(true);
    expect(hasJsonOutput(["md", "lint", "--format", "sarif"])).toBe(true);
  });

  it("does not match other formats", () => {
    expect(hasJsonOutput(["md", "lint", "--format=human"])).toBe(false);
    expect(hasJsonOutput(["md", "lint"])).toBe(false);
    expect(hasJsonOutput(["md", "lint", "--format"])).toBe(false);
  });
});

const allowedCtx = {
  argv: ["node", "cli.js", "md", "lint", "a.md"],
  isTty: true,
  env: {} as NodeJS.ProcessEnv,
};

describe("isNotifierAllowed", () => {
  it("allows an interactive non-JSON run", () => {
    expect(isNotifierAllowed(allowedCtx)).toBe(true);
  });

  it("is suppressed when stderr is not a TTY", () => {
    expect(isNotifierAllowed({ ...allowedCtx, isTty: false })).toBe(false);
  });

  it("is suppressed for JSON output", () => {
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["md", "lint", "--format=json"] })).toBe(false);
  });

  it("is suppressed in CI", () => {
    expect(isNotifierAllowed({ ...allowedCtx, env: { CI: "true" } })).toBe(false);
  });

  it("is suppressed by the opt-out variable", () => {
    expect(isNotifierAllowed({ ...allowedCtx, env: { CAIRN_NO_UPDATE_NOTIFIER: "1" } })).toBe(
      false,
    );
  });

  it("does not recurse into the refresh child", () => {
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["__refresh-update-cache"] })).toBe(false);
  });

  it("stays quiet during an explicit check-update", () => {
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["check-update"] })).toBe(false);
  });

  it("stays quiet for the contract discovery commands", () => {
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["describe"] })).toBe(false);
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["schema", "md-graph"] })).toBe(false);
    // `eval "$(cairn completion zsh)"` runs from an interactive rc file,
    // where stderr is a TTY — the notice would print on every shell start.
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["completion", "zsh"] })).toBe(false);
  });

  it("stays quiet for scripts run, whose child owns the real stderr", () => {
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["scripts", "run", "build"] })).toBe(false);
    // Matched by adjacency: `run` is a legal script name, and resolving one is
    // not executing one.
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["scripts", "which", "run"] })).toBe(true);
    expect(isNotifierAllowed({ ...allowedCtx, argv: ["scripts", "list"] })).toBe(true);
  });

  it("enforces every condition the published contract lists", () => {
    // NOTIFIER_CONTRACT is what `describe` reports to consumers, so each listed
    // condition must actually suppress the notice.
    const cases: Record<string, Parameters<typeof isNotifierAllowed>[0]> = {
      "CAIRN_NO_UPDATE_NOTIFIER=1": {
        ...allowedCtx,
        env: { CAIRN_NO_UPDATE_NOTIFIER: "1" },
      },
      "CI is set": { ...allowedCtx, env: { CI: "true" } },
      "stderr is not a TTY": { ...allowedCtx, isTty: false },
      "--format is json, jsonl, or sarif, including a project-configured format": {
        ...allowedCtx,
        argv: ["md", "lint", "--format=sarif"],
      },
      "the command is check-update, describe, schema, completion, scripts run, or the internal cache refresh":
        {
          ...allowedCtx,
          argv: ["describe"],
        },
    };
    expect(Object.keys(cases).sort()).toEqual([...NOTIFIER_CONTRACT.suppressedWhen].sort());
    for (const [condition, ctx] of Object.entries(cases))
      expect(isNotifierAllowed(ctx), condition).toBe(false);
  });
});

describe("shouldNotify", () => {
  const base = { ...allowedCtx, currentVersion: "1.0.0" };

  it("notifies when the cached version is newer", () => {
    expect(shouldNotify({ ...base, cache: { lastCheckedAt: 1, latestVersion: "1.1.0" } })).toBe(
      true,
    );
  });

  it("stays quiet when already current", () => {
    expect(shouldNotify({ ...base, cache: { lastCheckedAt: 1, latestVersion: "1.0.0" } })).toBe(
      false,
    );
  });

  it("stays quiet with no cache", () => {
    expect(shouldNotify({ ...base, cache: null })).toBe(false);
  });

  it("stays quiet when the cache never resolved a version", () => {
    expect(shouldNotify({ ...base, cache: { lastCheckedAt: 1, latestVersion: null } })).toBe(false);
  });

  it("respects suppression even when an update exists", () => {
    expect(
      shouldNotify({
        ...base,
        isTty: false,
        cache: { lastCheckedAt: 1, latestVersion: "9.9.9" },
      }),
    ).toBe(false);
  });
});

describe("refresh lock", () => {
  it("grants the lock to only one caller", () => {
    const lockPath = getLockPath(cachePath);
    expect(acquireRefreshLock(lockPath, 1_000)).toBe(true);
    expect(acquireRefreshLock(lockPath, 1_000)).toBe(false);
    expect(acquireRefreshLock(lockPath, 1_000)).toBe(false);
  });

  it("allows a new holder after release", () => {
    const lockPath = getLockPath(cachePath);
    expect(acquireRefreshLock(lockPath, 1_000)).toBe(true);
    releaseRefreshLock(lockPath);
    expect(acquireRefreshLock(lockPath, 1_000)).toBe(true);
  });

  it("takes over a lock abandoned by a crashed child", () => {
    const lockPath = getLockPath(cachePath);
    expect(acquireRefreshLock(lockPath, 1_000)).toBe(true);
    expect(acquireRefreshLock(lockPath, 1_000 + LOCK_STALE_MS - 1)).toBe(false);
    expect(acquireRefreshLock(lockPath, 1_000 + LOCK_STALE_MS)).toBe(true);
  });

  it("takes over an unparseable lock", () => {
    const lockPath = getLockPath(cachePath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "garbage");
    expect(acquireRefreshLock(lockPath, 1_000)).toBe(true);
  });

  it("releasing a lock that does not exist is harmless", () => {
    expect(() => releaseRefreshLock(getLockPath(cachePath))).not.toThrow();
  });

  it("keeps the lock beside the cache", () => {
    expect(getLockPath(cachePath)).toBe(path.join(path.dirname(cachePath), "update-check.lock"));
  });
});

describe("formatNotice", () => {
  it("names both versions and the install command", () => {
    const notice = formatNotice("1.0.0", "1.1.0", "@bstockus/cairn");
    expect(notice).toContain("1.0.0");
    expect(notice).toContain("1.1.0");
    expect(notice).toContain("npm install -g @bstockus/cairn");
  });
});
