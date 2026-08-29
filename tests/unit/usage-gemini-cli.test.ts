import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { geminiCliProvider } from "../../src/usage/providers/gemini-cli.js";
import { antigravityProvider } from "../../src/usage/providers/antigravity.js";
import type { FileAggregate } from "../../src/usage/events.js";
import type { TranscriptFile } from "../../src/usage/providers/types.js";
import { GEMINI_FIXTURE, buildGeminiLogs } from "../helpers/gemini-cli-fixture.js";

/**
 * Gemini CLI counting.
 *
 * The three distortions this provider exists to undo each get their own case,
 * because each of them is worth a different factor: the per-id repetition is
 * worth roughly two, the cache containment several, and counting a subagent's
 * injected first turn as a prompt is worth fourteen.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-gemini-"));
  temporary.push(root);
  return root;
}

function fixture(): string {
  return buildGeminiLogs(scratch(), GEMINI_FIXTURE);
}

function find(files: TranscriptFile[], fragment: string): TranscriptFile {
  // On the basename, not the whole path: a subagent lives in a directory named
  // after its parent, so matching the path would find the child.
  const found = files.find((file) => path.basename(file.relative).includes(fragment));
  if (!found) throw new Error(`no transcript matching ${fragment} in ${files.length} found`);
  return found;
}

async function parseOne(root: string, fragment: string): Promise<FileAggregate> {
  const files = geminiCliProvider.discover(root, { subagents: true });
  return geminiCliProvider.read(find(files, fragment));
}

function onlyDay(aggregate: FileAggregate, day: string) {
  const bucket = aggregate.days[day];
  if (!bucket) throw new Error(`no bucket for ${day} in ${Object.keys(aggregate.days).join(",")}`);
  return bucket;
}

describe("discovery", () => {
  it("separates main transcripts from the subagents nested beneath them", () => {
    const root = fixture();
    const all = geminiCliProvider.discover(root, { subagents: true });
    expect(all.filter((file) => file.kind === "main")).toHaveLength(2);
    expect(all.filter((file) => file.kind === "subagent")).toHaveLength(1);
    expect(find(all, "sub001").relative).toBe(
      path.join("alpha", "chats", "aaaa1111-2222-3333-4444-555566667777", "sub001.jsonl"),
    );
  });

  it("prunes subagents from the walk, rather than after reading them", () => {
    const root = fixture();
    const main = geminiCliProvider.discover(root, { subagents: false });
    expect(main).toHaveLength(2);
    expect(main.every((file) => file.kind === "main")).toBe(true);
  });

  it("skips the helper binaries the CLI downloads beside the projects", () => {
    const root = fixture();
    const found = geminiCliProvider.discover(root, { subagents: true });
    expect(found.some((file) => file.relative.includes("bin"))).toBe(false);
  });

  it("does not claim the Antigravity tree it shares a home with", () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, ".gemini", "antigravity-cli", "conversations"), {
      recursive: true,
    });
    const context = { env: {}, home: root };
    expect(geminiCliProvider.root(context)).toBeNull();
    expect(antigravityProvider.root(context)).not.toBeNull();
  });

  it("reports no root when the home holds no chats at all", () => {
    expect(geminiCliProvider.root({ env: {}, home: scratch() })).toBeNull();
  });
});

describe("token accounting", () => {
  it("counts one response from the three records that carry it", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    const tokens = onlyDay(aggregate, "2026-08-01").models["gemini-3.1-pro-preview"];
    expect(tokens.requests).toBe(1);
    // Counting each copy would report 3000 input and three requests.
    expect(tokens.output).toBe(50);
    expect(tokens.thinking).toBe(20);
  });

  it("subtracts the cached part out of input and reports it as a cache read", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    const tokens = onlyDay(aggregate, "2026-08-01").models["gemini-3.1-pro-preview"];
    // The record says input 1000 of which 400 cached; left merged, input reads
    // high by every cached prefix on every turn.
    expect(tokens.input).toBe(600);
    expect(tokens.cacheRead).toBe(400);
    // No cache-write figure exists anywhere in the format.
    expect(tokens.cacheWrite).toBe(0);
  });

  it("declares a cache breakdown, because the read half is real", () => {
    expect(geminiCliProvider.capabilities.cacheTokens).toBe(true);
  });

  it("drops the tokens of a record that fails the total guard, and keeps its tools", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    const bucket = onlyDay(aggregate, "2026-08-01");
    // r2 claims total 999 against 10 + 5 + 0. Its 10 input tokens are not in
    // the model totals, but the read_file it made still happened.
    expect(bucket.models["gemini-3.1-pro-preview"].input).toBe(600);
    expect(bucket.tools.read_file).toBe(1);
    expect(bucket.errors).toBe(1);
  });

  it("keeps a file whose header is missing entirely", async () => {
    const aggregate = await parseOne(fixture(), "bbbb2222");
    expect(aggregate.sessionId).toBe("session-2026-08-01T12-00-bbbb2222");
    expect(onlyDay(aggregate, "2026-08-01").models["gemini-3-flash-preview"].input).toBe(200);
  });

  it("counts a torn line without losing the records around it", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    expect(aggregate.malformedLines).toBe(1);
  });
});

describe("tools, skills, and agents", () => {
  it("takes the last tool list for a response id, not the sum of every copy", async () => {
    const bucket = onlyDay(await parseOne(fixture(), "aaaa1111"), "2026-08-01");
    // The three copies of r1 carry 0, then 1, then 2 calls. Summing gives 3.
    expect(bucket.tools.activate_skill).toBe(1);
    expect(bucket.tools.invoke_agent).toBe(1);
  });

  it("names the skill and the subagent role from the call arguments", async () => {
    const bucket = onlyDay(await parseOne(fixture(), "aaaa1111"), "2026-08-01");
    expect(bucket.skills["docs-lint"]).toBe(1);
    expect(bucket.agents.writer.count).toBe(1);
  });

  it("keeps Gemini's own tool names rather than Claude Code's", async () => {
    const bucket = onlyDay(await parseOne(fixture(), "aaaa1111"), "2026-08-01");
    // `invoke_agent` and `activate_skill` are this assistant's builtins. They
    // fill `agents` and `skills` as well, but renaming them in `tools` would
    // print a tool that never appears in the transcript.
    expect(Object.keys(bucket.tools).sort()).toEqual([
      "activate_skill",
      "invoke_agent",
      "read_file",
    ]);
  });
});

describe("prompts and identity", () => {
  it("counts a typed turn in a main transcript", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    expect(onlyDay(aggregate, "2026-08-01").prompts).toBe(1);
  });

  it("does not count the instruction a parent injected into its subagent", async () => {
    const aggregate = await parseOne(fixture(), "sub001");
    // On a real corpus these outnumber real prompts fourteen to one.
    expect(Object.values(aggregate.days).every((bucket) => bucket.prompts === 0)).toBe(true);
  });

  it("derives a subagent's parent from the directory holding it", async () => {
    const aggregate = await parseOne(fixture(), "sub001");
    expect(aggregate.kind).toBe("subagent");
    expect(aggregate.parentSessionId).toBe("aaaa1111-2222-3333-4444-555566667777");
    // The role lives in the parent's `invoke_agent` call; the child records
    // none of its own, so this stays unset rather than being guessed at.
    expect(aggregate.agentType).toBeUndefined();
  });

  it("reads the exact project root rather than reconstructing it from a slug", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    expect(aggregate.project).toBe("/work/alpha");
  });
});

describe("slash commands", () => {
  it("takes the command name from the history, on the day it was used", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    expect(onlyDay(aggregate, "2026-08-01").commands["/deploy"]).toBe(1);
    // A second use on a later day opens its own bucket, which the transcript
    // itself never touches.
    expect(onlyDay(aggregate, "2026-08-02").commands["/deploy"]).toBe(1);
  });

  it("ignores an ordinary typed prompt in the same history", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    const names = Object.values(aggregate.days).flatMap((bucket) => Object.keys(bucket.commands));
    expect(names).toEqual(["/deploy", "/deploy"]);
  });

  it("drops a command whose transcript no longer exists", async () => {
    const aggregate = await parseOne(fixture(), "aaaa1111");
    const total = Object.values(aggregate.days).reduce(
      (sum, bucket) => sum + Object.values(bucket.commands).reduce((a, b) => a + b, 0),
      0,
    );
    // `/orphan` belongs to a session `/clear` truncated. There is no aggregate
    // to attach it to, so it is not reported anywhere.
    expect(total).toBe(2);
  });

  it("attaches no history to a subagent, which cannot have been typed at", async () => {
    const aggregate = await parseOne(fixture(), "sub001");
    expect(Object.values(aggregate.days).every((b) => Object.keys(b.commands).length === 0)).toBe(
      true,
    );
  });
});
