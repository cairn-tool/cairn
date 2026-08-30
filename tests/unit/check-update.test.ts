import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkUpdateAction } from "../../src/commands/update-check.js";
import { readCache } from "../../src/update-notifier.js";

const PKG = "@cairn-tool/cairn";

let tmpDir: string;
let cachePath: string;

interface Run {
  stdout: string;
  stderr: string;
  exitCodes: number[];
}

async function run(currentVersion: string, latest: string | null, format = "llm"): Promise<Run> {
  const captured: Run = { stdout: "", stderr: "", exitCodes: [] };
  await checkUpdateAction(
    PKG,
    currentVersion,
    { format },
    {
      fetchLatest: () => Promise.resolve(latest),
      cachePath,
      now: () => 5_000,
      stdout: (t) => (captured.stdout += t),
      stderr: (t) => (captured.stderr += t),
      exit: (c) => captured.exitCodes.push(c),
    },
  );
  return captured;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-update-"));
  cachePath = path.join(tmpDir, "update-check.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("check-update", () => {
  it("reports an available update and exits 2", async () => {
    const r = await run("1.0.0", "1.1.0");
    expect(r.stdout).toContain("Update available: 1.0.0 -> 1.1.0");
    expect(r.stdout).toContain(`npm install -g ${PKG}`);
    expect(r.exitCodes).toEqual([2]);
  });

  it("reports being current and exits 0", async () => {
    const r = await run("1.1.0", "1.1.0");
    expect(r.stdout).toContain("is up to date");
    expect(r.exitCodes).toEqual([]);
  });

  it("does not treat an older published version as an update", async () => {
    const r = await run("2.0.0", "1.9.9");
    expect(r.stdout).toContain("is up to date");
    expect(r.exitCodes).toEqual([]);
  });

  it("exits 1 with guidance when the registry cannot be reached", async () => {
    const r = await run("1.0.0", null);
    expect(r.stderr).toContain("Could not resolve the latest published version");
    expect(r.stdout).toBe("");
    expect(r.exitCodes).toEqual([1]);
  });

  it("emits parseable JSON on stdout when an update exists", async () => {
    const r = await run("1.0.0", "1.2.3", "json");
    expect(JSON.parse(r.stdout)).toEqual({
      current: "1.0.0",
      latest: "1.2.3",
      updateAvailable: true,
    });
    expect(r.exitCodes).toEqual([2]);
  });

  it("emits parseable JSON on stderr when the lookup fails", async () => {
    const r = await run("1.0.0", null, "json");
    expect(JSON.parse(r.stderr)).toMatchObject({
      current: "1.0.0",
      latest: null,
      updateAvailable: false,
    });
    expect(r.exitCodes).toEqual([1]);
  });

  it("refreshes the cache so the passive check backs off", async () => {
    await run("1.0.0", "1.1.0");
    expect(readCache(cachePath)).toEqual({ lastCheckedAt: 5_000, latestVersion: "1.1.0" });
  });

  it("leaves the cache untouched when the lookup fails", async () => {
    await run("1.0.0", null);
    expect(readCache(cachePath)).toBeNull();
  });

  it("falls back to llm output for an unknown format", async () => {
    const r = await run("1.0.0", "1.1.0", "nonsense");
    expect(r.stdout).toContain("Update available: 1.0.0 -> 1.1.0");
  });
});
