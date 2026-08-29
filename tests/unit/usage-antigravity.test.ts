import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { antigravityProvider } from "../../src/usage/providers/antigravity.js";
import type { TranscriptFile } from "../../src/usage/providers/types.js";
import { bucketTokens } from "../../src/usage/events.js";
import type { FileAggregate } from "../../src/usage/events.js";
import { ANTIGRAVITY_FIXTURE, buildAntigravityLogs } from "../helpers/antigravity-fixture.js";
import type { ConversationSpec } from "../helpers/antigravity-fixture.js";

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function logs(conversations: ConversationSpec[] = ANTIGRAVITY_FIXTURE): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-unit-"));
  temporary.push(root);
  return buildAntigravityLogs(root, conversations);
}

function transcriptFor(root: string, id: string): TranscriptFile {
  const file = path.join(root, "conversations", `${id}.db`);
  const stats = fs.statSync(file);
  return {
    file,
    relative: `${id}.db`,
    shard: "conversations",
    kind: "main",
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

async function read(conversations?: ConversationSpec[], index = 0): Promise<FileAggregate> {
  const root = logs(conversations);
  const specs = conversations ?? ANTIGRAVITY_FIXTURE;
  return antigravityProvider.read(transcriptFor(root, specs[index].id));
}

describe("antigravity discovery", () => {
  it("finds the trajectory databases and no sidecars", () => {
    const root = logs();
    fs.writeFileSync(path.join(root, "conversations", "stray.db-wal"), "x");
    const found = antigravityProvider.discover(root, { subagents: true });
    expect(found.map((file) => file.relative).sort()).toEqual([
      "11111111-1111-1111-1111-111111111111.db",
      "22222222-2222-2222-2222-222222222222.db",
    ]);
  });

  it("reports a root only when it holds trajectories", () => {
    const root = logs();
    expect(antigravityProvider.root({ env: {}, home: "/nowhere", override: root })).toBe(root);
    expect(antigravityProvider.root({ env: {}, home: "/nowhere" })).toBeNull();
  });
});

describe("antigravity token accounting", () => {
  it("sums per-request rows rather than differencing them", async () => {
    // Prompt tokens are the context size of each request, not a running total —
    // they fall whenever context is trimmed — so they are summed.
    const aggregate = await read();
    const days = Object.keys(aggregate.days).sort();
    expect(days).toEqual(["2026-08-01", "2026-08-02"]);
    expect(bucketTokens(aggregate.days["2026-08-01"]).input).toBe(1000);
    expect(bucketTokens(aggregate.days["2026-08-02"]).input).toBe(900);

    const first = aggregate.days["2026-08-01"].models["gemini-pro-default"];
    expect(first).toMatchObject({ input: 1000, output: 60, thinking: 40, requests: 1 });
  });

  it("reports no cache breakdown, because none is recorded", async () => {
    const tokens = bucketTokens((await read()).days["2026-08-01"]);
    expect(tokens.cacheRead).toBe(0);
    expect(tokens.cacheWrite).toBe(0);
    expect(antigravityProvider.capabilities.cacheTokens).toBe(false);
  });

  it("abandons the token column when the guard fails, keeping everything else", async () => {
    // The field numbers are reverse-engineered. A record where completion no
    // longer equals thinking + output is not the field we think it is, and
    // emitting its value would be worse than emitting nothing.
    const corrupted: ConversationSpec[] = [
      {
        ...ANTIGRAVITY_FIXTURE[0],
        usage: [
          { at: "2026-08-01T10:00:00Z", prompt: 1000, thinking: 40, output: 60 },
          {
            at: "2026-08-01T11:00:00Z",
            prompt: 10,
            thinking: 1,
            output: 1,
            corruptCompletion: true,
          },
        ],
      },
    ];
    const aggregate = await read(corrupted);
    for (const bucket of Object.values(aggregate.days)) {
      expect(Object.keys(bucket.models)).toEqual([]);
    }
    // The transcript-derived figures survive.
    expect(Object.values(aggregate.days).some((bucket) => bucket.prompts > 0)).toBe(true);
  });

  it("refuses an implausibly large prompt rather than reporting it", async () => {
    const aggregate = await read([
      {
        ...ANTIGRAVITY_FIXTURE[0],
        usage: [{ at: "2026-08-01T10:00:00Z", prompt: 9_000_000, thinking: 1, output: 1 }],
      },
    ]);
    for (const bucket of Object.values(aggregate.days)) {
      expect(Object.keys(bucket.models)).toEqual([]);
    }
  });
});

describe("antigravity identity and transcript", () => {
  it("takes workspace, branch, and title from the trajectory header", async () => {
    const aggregate = await read();
    expect(aggregate.project).toBe("/tmp/agproj");
    expect(aggregate.gitBranch).toBe("main");
    expect(aggregate.title).toBe("Parent run");
    expect(aggregate.kind).toBe("main");
  });

  it("recognises a subagent by its recorded parent", async () => {
    const aggregate = await read(ANTIGRAVITY_FIXTURE, 1);
    expect(aggregate.kind).toBe("subagent");
    expect(aggregate.parentSessionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(aggregate.agentType).toBe("docs-generate-writer");
  });

  it("counts tools, prompts, errors, and checkpoints from the JSONL", async () => {
    const aggregate = await read();
    const first = aggregate.days["2026-08-01"];
    expect(first.tools).toEqual({ write_to_file: 1, invoke_subagent: 1 });
    expect(first.prompts).toBe(1);
    expect(first.errors).toBe(1);
    expect(aggregate.days["2026-08-02"].compactions).toBe(1);
  });

  it("counts a torn transcript line rather than failing the trajectory", async () => {
    const aggregate = await read();
    expect(aggregate.malformedLines).toBe(1);
    expect(Object.keys(aggregate.days)).not.toEqual([]);
  });

  it("reads slash commands from the shared history file", async () => {
    const aggregate = await read();
    const commands = Object.values(aggregate.days).flatMap((bucket) =>
      Object.keys(bucket.commands),
    );
    expect(commands).toContain("/skills");
  });

  it("still reports the transcript when the database is unreadable", async () => {
    const root = logs();
    const id = ANTIGRAVITY_FIXTURE[0].id;
    const file = transcriptFor(root, id);
    fs.writeFileSync(file.file, "not a database at all");
    const aggregate = await antigravityProvider.read(file);
    expect(Object.values(aggregate.days).some((bucket) => bucket.prompts > 0)).toBe(true);
    for (const bucket of Object.values(aggregate.days)) {
      expect(Object.keys(bucket.models)).toEqual([]);
    }
  });
});
