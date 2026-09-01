import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";
import { CURSOR_FIXTURE, buildCursorStore } from "../helpers/cursor-fixture.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporary: string[] = [];

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function scratch(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  return root;
}

afterAll(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A miniature Claude Code home.
 *
 * Built rather than committed so the cases can change a file mid-test, which is
 * the whole point of an incremental archive.
 */
let home = "";
let archive = "";

function logs(): string {
  return path.join(home, ".claude");
}

function writeFile(relative: string, content: string): string {
  const target = path.join(logs(), relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

beforeEach(() => {
  home = scratch("archive-e2e-home-");
  archive = scratch("archive-e2e-store-");
  fs.mkdirSync(path.join(logs(), "projects"), { recursive: true });
  writeFile("plans/one.md", "# Plan one\n");
  writeFile("plans/two.md", "# Plan two\n");
  // Byte-identical to one.md: two paths, one stored blob.
  writeFile("plans/duplicate.md", "# Plan one\n");
  writeFile("projects/slug/session/tool-results/fetched.pdf", "PDF-BYTES");
  writeFile("projects/slug/session.jsonl", '{"type":"user"}\n');
  // Never archived: not named by any set.
  writeFile("plugins/heavy/payload.bin", "x".repeat(4096));
  writeFile("jobs/abc/build.o", "y".repeat(4096));
});

async function run(...args: string[]): Promise<Run> {
  const env = { ...process.env, CI: "1", HOME: home, XDG_DATA_HOME: archive };
  delete env.CLAUDE_CONFIG_DIR;
  try {
    const result = await exec("node", [cli, "archive", ...args, "--archive", archive], { env });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

function json(result: Run): Record<string, unknown> {
  return JSON.parse(result.stdout.trim() || result.stderr.trim()) as Record<string, unknown>;
}

function validate(schemaId: string, payload: unknown): void {
  const entry = SCHEMA_BY_ID.get(schemaId);
  expect(entry, `schema ${schemaId} is not published`).toBeDefined();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const check = ajv.compile(entry!.schema);
  expect(check(payload), ajv.errorsText(check.errors, { separator: "; " })).toBe(true);
}

/** `--logs` is a `run` option only; the read commands never take one. */
function withLogs(...args: string[]): string[] {
  return [...args, "--logs", logs(), "-fj"];
}

describe("archive run", () => {
  it("stores plans and artifacts by default, and nothing else", async () => {
    const payload = json(await run(...withLogs("run")));
    validate("archive-result", payload);
    expect(payload.include).toEqual(["plan", "artifact"]);

    const counters = payload.run as Record<string, number>;
    // three plans and one tool result; the transcript is not a default class.
    expect(counters.discovered).toBe(4);
    // duplicate.md is byte-identical to one.md, so three blobs cover four paths.
    expect(counters.stored).toBe(3);
    expect(counters.duplicate).toBe(1);

    const listing = json(await run("list", "--top", "0", "-fj"));
    const paths = (listing.files as Array<{ path: string }>).map((file) =>
      path.relative(logs(), file.path),
    );
    expect(paths.sort()).toEqual([
      "plans/duplicate.md",
      "plans/one.md",
      "plans/two.md",
      "projects/slug/session/tool-results/fetched.pdf",
    ]);
    // The directories a blocklist would eventually fail to exclude.
    expect(paths.some((file) => file.startsWith("plugins/"))).toBe(false);
    expect(paths.some((file) => file.startsWith("jobs/"))).toBe(false);
  });

  it("takes transcripts only when asked", async () => {
    const payload = json(await run(...withLogs("run", "--include", "transcripts")));
    const listing = json(await run("list", "--top", "0", "-fj"));
    expect((payload.run as Record<string, number>).stored).toBe(1);
    expect(
      (listing.files as Array<{ class: string }>).every((file) => file.class === "transcript"),
    ).toBe(true);
  });

  it("stores nothing on a second run over an unchanged corpus", async () => {
    await run(...withLogs("run"));
    const second = json(await run(...withLogs("run")));
    const counters = second.run as Record<string, number>;
    expect(counters.unchanged).toBe(4);
    expect(counters.hashed).toBe(0);
    expect(counters.stored).toBe(0);
    // Nothing opened means no second segment.
    expect(second.segments).toEqual([]);
  });

  it("keeps every version of a file that changes", async () => {
    await run(...withLogs("run"));
    writeFile("plans/two.md", "# Plan two, revised\n");
    const second = json(await run(...withLogs("run")));
    expect((second.run as Record<string, number>).stored).toBe(1);

    const listing = json(await run("list", "--top", "0", "-fj"));
    const two = (listing.files as Array<{ path: string; versions: number }>).find((file) =>
      file.path.endsWith("two.md"),
    );
    expect(two?.versions).toBe(2);

    // The listing shows the newest; the older one is still reachable by hash.
    const status = json(await run("status", "-fj"));
    expect((status.archive as Record<string, number>).blobs).toBe(4);
  });

  it("reports what it would take without writing anything", async () => {
    const payload = json(await run(...withLogs("run", "--dry-run")));
    validate("archive-result", payload);
    expect(payload.action).toBe("dry-run");
    expect((payload.run as Record<string, number>).stored).toBe(0);
    expect(fs.existsSync(path.join(archive, "segments"))).toBe(false);
  });

  it("rejects an unknown --include class rather than archiving nothing", async () => {
    const result = await run(...withLogs("run", "--include", "everything"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --include");
  });

  it("seals more than one segment when the threshold is small", async () => {
    const payload = json(await run(...withLogs("run", "--segment-size", "1")));
    // Every blob exceeds a one-byte threshold, so each seals its own segment.
    expect((payload.segments as unknown[]).length).toBe(3);
  });
});

describe("archive extract", () => {
  it("writes a file back out byte for byte", async () => {
    await run(...withLogs("run"));
    const out = scratch("archive-e2e-out-");
    const source = path.join(logs(), "plans", "one.md");
    const payload = json(await run("extract", source, "--out", out, "-fj"));
    validate("archive-result", payload);

    const extracted = payload.extracted as { written: string; bytes: number };
    expect(fs.readFileSync(extracted.written, "utf-8")).toBe(fs.readFileSync(source, "utf-8"));
  });

  it("resolves a path to its newest version, and a hash to that exact one", async () => {
    await run(...withLogs("run"));
    const source = path.join(logs(), "plans", "two.md");
    const first = json(await run("extract", source, "--out", scratch("out-"), "-fj"));
    const oldHash = (first.extracted as { sha256: string }).sha256;

    writeFile("plans/two.md", "# Plan two, revised\n");
    await run(...withLogs("run"));

    const out = scratch("out-");
    const byPath = json(await run("extract", source, "--out", out, "-fj"));
    expect(fs.readFileSync((byPath.extracted as { written: string }).written, "utf-8")).toBe(
      "# Plan two, revised\n",
    );

    const byHash = json(
      await run("extract", oldHash.slice(0, 12), "--out", scratch("out-"), "-fj"),
    );
    expect(fs.readFileSync((byHash.extracted as { written: string }).written, "utf-8")).toBe(
      "# Plan two\n",
    );
  });

  it("reports a miss rather than writing an empty file", async () => {
    await run(...withLogs("run"));
    const result = await run("extract", "/nowhere/at/all.md", "--out", scratch("out-"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Nothing in the archive matches");
  });
});

describe("archive verify", () => {
  it("passes over an intact archive, shallow and deep", async () => {
    await run(...withLogs("run"));
    const shallow = json(await run("verify", "-fj"));
    validate("archive-result", shallow);
    expect((shallow.verify as Record<string, unknown>).findings).toEqual([]);

    const deep = json(await run("verify", "--deep", "-fj"));
    expect((deep.verify as Record<string, unknown>).findings).toEqual([]);
    expect((deep.verify as Record<string, number>).blobs).toBe(3);
  });

  it("exits 2 on a corrupted segment, without --strict", async () => {
    // Corruption is the actionable finding this command exists to report, which
    // is why it is the one command here that fails by default.
    await run(...withLogs("run"));
    const segments = path.join(archive, "segments");
    const name = fs.readdirSync(segments)[0];
    const file = path.join(segments, name);
    const bytes = fs.readFileSync(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(file, bytes);

    const result = await run("verify", "-fj");
    expect(result.exitCode).toBe(2);
    const payload = json(result);
    validate("archive-result", payload);
    const findings = (payload.verify as { findings: Array<{ segment: string }> }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].segment).toBe(name);
  });

  it("reports a segment the index knows about but the directory has lost", async () => {
    await run(...withLogs("run"));
    const segments = path.join(archive, "segments");
    fs.rmSync(path.join(segments, fs.readdirSync(segments)[0]));
    const result = await run("verify", "-fj");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing");
  });
});

describe("archive status and list", () => {
  it("reports an absent archive without failing", async () => {
    const payload = json(await run("status", "-fj"));
    validate("archive-listing", payload);
    expect((payload.archive as Record<string, unknown>).present).toBe(false);
  });

  it("lists nothing, and exits 0, before anything has been archived", async () => {
    const payload = json(await run("list", "-fj"));
    validate("archive-listing", payload);
    expect(payload.files).toEqual([]);
  });

  it("filters by class", async () => {
    await run(...withLogs("run", "--include", "plans,artifacts,transcripts"));
    const plans = json(await run("list", "--class", "plan", "--top", "0", "-fj"));
    expect((plans.files as Array<{ class: string }>).every((f) => f.class === "plan")).toBe(true);
    expect((plans.files as unknown[]).length).toBe(3);
  });

  it("rejects an unknown --class", async () => {
    const result = await run("list", "--class", "nonsense");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --class");
  });
});

describe("archive migrate", () => {
  it("creates the index at the current version and reports nothing pending", async () => {
    const payload = json(await run("migrate", "-fj"));
    validate("archive-result", payload);
    const migrations = payload.migrations as { from: number; to: number; applied: number[] };
    expect(migrations.from).toBe(0);
    expect(migrations.to).toBe(1);
    expect(migrations.applied).toEqual([1]);

    const again = json(await run("migrate", "-fj"));
    expect((again.migrations as { applied: number[] }).applied).toEqual([]);
  });

  it("refuses an index written by a newer cairn rather than guessing", async () => {
    await run(...withLogs("run"));
    const index = path.join(archive, "archive.db");
    // `user_version` lives in the file header, at a fixed offset, big-endian.
    const handle = fs.openSync(index, "r+");
    const bump = Buffer.alloc(4);
    bump.writeUInt32BE(4242);
    fs.writeSync(handle, bump, 0, 4, 60);
    fs.closeSync(handle);

    const result = await run("migrate");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("4242");
  });
});

/**
 * The only profile whose sets span two trees.
 *
 * Cursor keeps its conversation store in the Electron user-data directory and
 * its plans and session output under `~/.cursor`. Both are built here, because
 * the thing worth testing end to end is that one `archive run` reaches both.
 */
describe("archive run over two trees", () => {
  function cursorHome(): string {
    return path.join(home, "Library", "Application Support", "Cursor");
  }

  function writeCursor(relative: string, content: string): void {
    const target = path.join(home, ".cursor", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  beforeEach(() => {
    buildCursorStore(cursorHome(), CURSOR_FIXTURE);
    writeCursor("plans/feature.plan.md", "# A plan\n");
    writeCursor("projects/slug/agent-transcripts/uuid/uuid.jsonl", '{"role":"user"}\n');
    writeCursor("projects/slug/canvases/board.json", "{}\n");
    writeCursor("hooks.json", "{}\n");
    // Never archived: no set names either of these, and the first is the tree
    // that dominates `~/.cursor` on a real machine.
    writeCursor("extensions/some.ext/out/extension.js", "z".repeat(4096));
    writeCursor("projects/slug/terminals/123.txt", "z".repeat(4096));
    // Never archived: a stale copy of the store, months out of date and as
    // large as the store itself.
    fs.writeFileSync(path.join(cursorHome(), "User", "globalStorage", "state.vscdb.backup"), "old");
  });

  async function runCursor(...args: string[]): Promise<Run> {
    return run(...args, "--provider", "cursor");
  }

  it("reaches the alternate tree a default run selects from", async () => {
    const payload = JSON.parse((await runCursor("run", "--format", "json")).stdout) as {
      archive: { byClass: Record<string, { artifacts: number }> };
      sources: Array<{ root: string }>;
    };
    // The plan and the canvas live under `~/.cursor`, which is not the root the
    // run reports: that one is the user-data directory holding the store.
    expect(payload.sources[0].root).toBe(cursorHome());
    expect(payload.archive.byClass.plan.artifacts).toBe(1);
    expect(payload.archive.byClass.artifact.artifacts).toBe(1);
    // Transcripts and logs are opt-in for every provider.
    expect(payload.archive.byClass.transcript).toBeUndefined();
    expect(payload.archive.byClass.log).toBeUndefined();
  });

  it("takes the store from the log root and the transcripts from the other tree", async () => {
    await runCursor("run", "--include", "plans,artifacts,transcripts,logs");
    const listing = JSON.parse((await runCursor("list", "--format", "json")).stdout) as {
      files: Array<{ path: string; set: string }>;
    };
    const bySet = new Map(listing.files.map((entry) => [entry.set, entry.path]));

    expect(bySet.get("transcripts")).toContain(path.join(".cursor", "projects"));
    expect(bySet.get("conversations")).toContain(path.join("globalStorage", "state.vscdb"));
    expect(bySet.get("hooks")).toContain(path.join(".cursor", "hooks.json"));

    const paths = listing.files.map((entry) => entry.path);
    // The allowlist is what keeps these out, not a blocklist that could miss one.
    expect(paths.some((entry) => entry.includes("extensions"))).toBe(false);
    expect(paths.some((entry) => entry.includes("terminals"))).toBe(false);
    expect(paths.some((entry) => entry.endsWith("state.vscdb.backup"))).toBe(false);
  });

  it("snapshots the live store rather than copying its bytes", async () => {
    // The store carries `-wal` sidecars, so a byte copy can catch a torn page.
    // A snapshot is a valid database on its own, which is what makes it worth
    // archiving at all.
    const first = await runCursor("run", "--include", "logs");
    expect(first.exitCode).toBe(0);
    // `verify` reads the archive, so it takes no --provider.
    const verified = await run("verify", "--deep");
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout).toContain("segments verified");
  });
});

describe("formats", () => {
  it("keeps stderr clean on a clean run, which the sqlite warning would not", async () => {
    const result = await run(...withLogs("run"));
    expect(result.stderr).toBe("");
  });

  it("refuses --envelope without --format json", async () => {
    const result = await run("status", "--envelope");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--envelope requires");
  });

  it("refuses an unknown format", async () => {
    const result = await run("status", "--format", "xml");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid output format");
  });
});
