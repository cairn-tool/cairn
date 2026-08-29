import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * An OpenCode session store, built as a real SQLite file.
 *
 * Only the four tables the provider reads are created, with the real column
 * names, so a rename in the provider's SQL fails here rather than silently
 * returning nothing.
 */

export interface OpencodeMessageSpec {
  id: string;
  role: "user" | "assistant";
  createdMs: number;
  updatedMs?: number;
  agent?: string;
  providerID?: string;
  modelID?: string;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  /** Parts hanging off this message. */
  parts?: Array<{ createdMs: number; updatedMs?: number; data: Record<string, unknown> }>;
}

export interface OpencodeSessionSpec {
  id: string;
  parentId?: string;
  directory: string;
  title: string;
  version: string;
  /** Written to `session.time_updated`, which may lag its messages. */
  timeUpdatedMs: number;
  messages: OpencodeMessageSpec[];
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const SCHEMA = `
CREATE TABLE project (
  id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  agent TEXT, model TEXT, cost REAL DEFAULT 0 NOT NULL,
  tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
  tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_write INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
`;

export function buildOpencodeStore(root: string, sessions: readonly OpencodeSessionSpec[]): string {
  const require = createRequire(import.meta.url);
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  process.emitWarning = emit;

  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "opencode.db");
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  db.prepare(
    "INSERT INTO project(id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?,?)",
  ).run("prj_1", "/work/repo", "git", "repo", 1, 1, "[]");

  const session = db.prepare(
    `INSERT INTO session(id, project_id, parent_id, slug, directory, title, version,
      time_created, time_updated, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const message = db.prepare(
    "INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
  );
  const part = db.prepare(
    "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
  );

  let partId = 0;
  for (const spec of sessions) {
    // The rollup the provider must reproduce from the message grain alone.
    const rollup = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 };
    for (const item of spec.messages) {
      if (!item.tokens) continue;
      rollup.input += item.tokens.input;
      rollup.output += item.tokens.output;
      rollup.reasoning += item.tokens.reasoning;
      rollup.read += item.tokens.cache.read;
      rollup.write += item.tokens.cache.write;
    }
    session.run(
      spec.id,
      "prj_1",
      spec.parentId ?? null,
      spec.id,
      spec.directory,
      spec.title,
      spec.version,
      spec.messages[0]?.createdMs ?? 0,
      spec.timeUpdatedMs,
      rollup.input,
      rollup.output,
      rollup.reasoning,
      rollup.read,
      rollup.write,
    );

    for (const item of spec.messages) {
      const data: Record<string, unknown> =
        item.role === "user"
          ? { role: "user", time: { created: item.createdMs } }
          : {
              role: "assistant",
              agent: item.agent,
              modelID: item.modelID,
              providerID: item.providerID,
              tokens: item.tokens,
              cost: 0,
              time: { created: item.createdMs, completed: item.updatedMs ?? item.createdMs },
            };
      message.run(
        item.id,
        spec.id,
        item.createdMs,
        item.updatedMs ?? item.createdMs,
        JSON.stringify(data),
      );
      for (const entry of item.parts ?? []) {
        partId += 1;
        part.run(
          `prt_${String(partId).padStart(4, "0")}`,
          item.id,
          spec.id,
          entry.createdMs,
          entry.updatedMs ?? entry.createdMs,
          JSON.stringify(entry.data),
        );
      }
    }
  }
  db.close();
  return file;
}

const DAY = "2026-08-01T00:00:00.000Z";
const at = (hours: number, minutes = 0): number =>
  Date.parse(DAY) + hours * 3_600_000 + minutes * 60_000;

const TOKENS = { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 40 } };

export const OPENCODE_FIXTURE: readonly OpencodeSessionSpec[] = [
  {
    id: "ses_main",
    directory: "/work/repo",
    title: "a main session",
    version: "1.18.23",
    // Deliberately behind its own last message, which a real store does: the
    // freshness key has to come from the rows, not from this column.
    timeUpdatedMs: at(10),
    messages: [
      { id: "msg_1", role: "user", createdMs: at(10) },
      {
        id: "msg_2",
        role: "assistant",
        createdMs: at(10, 1),
        updatedMs: at(12),
        agent: "build",
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
        tokens: TOKENS,
        parts: [
          {
            createdMs: at(10, 2),
            data: { type: "tool", tool: "read", callID: "c1", state: { status: "completed" } },
          },
          {
            createdMs: at(10, 3),
            data: { type: "tool", tool: "grep", callID: "c2", state: { status: "error" } },
          },
          {
            createdMs: at(10, 4),
            data: {
              type: "tool",
              tool: "task",
              callID: "c3",
              state: { status: "completed", input: { subagent_type: "explore" } },
            },
          },
          // Carries a copy of the message's usage. Reading it as well would
          // double every figure, which is what the counting case asserts.
          {
            createdMs: at(10, 5),
            data: {
              type: "step-finish",
              reason: "stop",
              tokens: {
                total: 1200,
                input: 1000,
                output: 200,
                reasoning: 50,
                cache: { read: 300, write: 40 },
              },
              cost: 0,
            },
          },
        ],
      },
    ],
  },
  {
    id: "ses_child",
    parentId: "ses_main",
    directory: "/work/repo",
    title: "a subagent session",
    version: "1.18.23",
    timeUpdatedMs: at(11),
    messages: [
      { id: "msg_3", role: "user", createdMs: at(11) },
      {
        id: "msg_4",
        role: "assistant",
        createdMs: at(11, 1),
        // The child names its own role, which agrees with the parent's `task`.
        agent: "explore",
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
        tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        parts: [
          {
            createdMs: at(11, 2),
            data: { type: "tool", tool: "glob", callID: "c4", state: { status: "completed" } },
          },
        ],
      },
    ],
  },
];
