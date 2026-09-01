import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * A Cursor editor store, built as a real SQLite file.
 *
 * Only the three tables the provider reads are created, with the real table and
 * column names and the real key prefixes, so a rename in the provider's SQL
 * fails here rather than silently returning nothing.
 *
 * The fixture deliberately covers the four shapes that make this provider
 * awkward, because each of them was found in a real corpus:
 *
 * - a **legacy** conversation whose turns carry nonzero `tokenCount`;
 * - a **current** conversation whose turns carry the field with zeroes in it,
 *   which must contribute no requests at all;
 * - a conversation that exists only as `composerData` and turns, with **no row
 *   in `composerHeaders` and no entry in the legacy index** -- the majority of
 *   the token-bearing conversations on a real machine;
 * - a **subagent**, joined back to its parent's spawning tool call by
 *   `subagentInfo.toolCallId`.
 */

export interface CursorTurnSpec {
  /** 1 is a user turn, 2 an assistant turn, exactly as Cursor records it. */
  type: 1 | 2;
  inputTokens?: number;
  outputTokens?: number;
  /** `timingInfo.clientRpcSendTime`; almost every real turn lacks one. */
  sentMs?: number;
  tool?: string;
  toolStatus?: "completed" | "error" | "cancelled" | "loading";
  toolCallId?: string;
}

export interface CursorConversationSpec {
  id: string;
  createdMs: number;
  updatedMs?: number;
  /** `modelConfig.modelName`; absent on conversations from the token era. */
  model?: string;
  /** Legacy `usageData`, the model fallback when `modelConfig` is absent. */
  usageData?: Record<string, { costInCents: number; amount: number }>;
  name?: string;
  /** Absolute path, written as `workspaceIdentifier.uri.fsPath`. */
  project?: string;
  /** A multi-root window names a `.code-workspace` document instead. */
  multiRootConfigPath?: string;
  subagent?: { parentComposerId: string; subagentTypeName: string; toolCallId: string };
  /** Where this conversation's identity is indexed. Default `"table"`. */
  index?: "table" | "legacy" | "none";
  turns: CursorTurnSpec[];
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const SCHEMA = `
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE composerHeaders (
  composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
  lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
  recency INTEGER, checkpointAt INTEGER, value TEXT
);
`;

/** The identity block both indexes carry, in the shape Cursor writes it. */
function identity(spec: CursorConversationSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: "head",
    composerId: spec.id,
    createdAt: spec.createdMs,
  };
  if (spec.updatedMs !== undefined) entry.lastUpdatedAt = spec.updatedMs;
  if (spec.name) entry.name = spec.name;
  if (spec.project) {
    entry.workspaceIdentifier = {
      id: "workspace-hash",
      uri: { $mid: 1, fsPath: spec.project, path: spec.project, scheme: "file" },
    };
  }
  if (spec.multiRootConfigPath) {
    entry.workspaceIdentifier = {
      id: "workspace-hash",
      configPath: { $mid: 1, fsPath: spec.multiRootConfigPath, scheme: "file" },
    };
  }
  if (spec.subagent) entry.subagentInfo = { subagentType: 3, ...spec.subagent };
  return entry;
}

function turnValue(turn: CursorTurnSpec): string {
  const bubble: Record<string, unknown> = {
    _v: 2,
    type: turn.type,
    // Cursor writes the counters on every turn, and zeroes them once it stopped
    // settling usage on the client. Both shapes have to be represented.
    tokenCount: { inputTokens: turn.inputTokens ?? 0, outputTokens: turn.outputTokens ?? 0 },
    text: "",
    codeBlocks: [],
    toolResults: [],
  };
  if (turn.sentMs !== undefined) {
    bubble.timingInfo = {
      clientStartTime: 1,
      clientRpcSendTime: turn.sentMs,
      clientSettleTime: turn.sentMs,
      clientEndTime: turn.sentMs,
    };
  }
  if (turn.tool) {
    bubble.toolFormerData = {
      tool: turn.tool,
      name: turn.tool,
      status: turn.toolStatus ?? "completed",
      toolCallId: turn.toolCallId ?? `call-${turn.tool}`,
      rawArgs: "{}",
      params: "{}",
    };
  }
  return JSON.stringify(bubble);
}

export function buildCursorStore(
  root: string,
  conversations: readonly CursorConversationSpec[],
): string {
  const require = createRequire(import.meta.url);
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  process.emitWarning = emit;

  const file = path.join(root, "User", "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });

  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    const kv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const item = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    const header = db.prepare(
      `INSERT INTO composerHeaders
         (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency,
          checkpointAt, value)
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
    );

    const legacy: Array<Record<string, unknown>> = [];
    for (const spec of conversations) {
      const data: Record<string, unknown> = {
        _v: 3,
        composerId: spec.id,
        createdAt: spec.createdMs,
        fullConversationHeadersOnly: spec.turns.map((_, index) => ({
          bubbleId: `${spec.id}-turn-${index}`,
          type: spec.turns[index].type,
        })),
        // Present on every real conversation and deliberately never read: it is
        // the last turn's context size, not a cumulative figure.
        contextTokensUsed: 128_000,
        contextTokenLimit: 300_000,
      };
      if (spec.updatedMs !== undefined) data.lastUpdatedAt = spec.updatedMs;
      if (spec.name) data.name = spec.name;
      if (spec.model) data.modelConfig = { modelName: spec.model, maxMode: false };
      if (spec.usageData) data.usageData = spec.usageData;
      kv.run(`composerData:${spec.id}`, JSON.stringify(data));

      spec.turns.forEach((turn, index) => {
        kv.run(`bubbleId:${spec.id}:${spec.id}-turn-${index}`, turnValue(turn));
      });

      const where = spec.index ?? "table";
      if (where === "table") {
        header.run(
          spec.id,
          "workspace-hash",
          spec.createdMs,
          spec.updatedMs ?? null,
          spec.subagent ? 1 : 0,
          spec.createdMs,
          JSON.stringify(identity(spec)),
        );
      } else if (where === "legacy") {
        legacy.push(identity(spec));
      }
    }
    // The pre-`composerHeaders` index, which Cursor did not backfill and still
    // writes beside the table.
    item.run("composer.composerHeaders", JSON.stringify({ allComposers: legacy }));
  } finally {
    db.close();
  }
  return file;
}

const DAY = Date.UTC(2025, 7, 1, 12);
const LATER = Date.UTC(2026, 7, 1, 12);

export const CURSOR_FIXTURE: CursorConversationSpec[] = [
  {
    // The token era: real per-request counters, and no `modelConfig`, so the
    // model has to come from the single name in `usageData`.
    id: "11111111-1111-4111-8111-111111111111",
    createdMs: DAY,
    updatedMs: DAY + 60_000,
    usageData: { "claude-4-sonnet-thinking": { costInCents: 104, amount: 2 } },
    name: "legacy conversation",
    project: "/work/alpha",
    turns: [
      { type: 1 },
      { type: 2, inputTokens: 1000, outputTokens: 200 },
      { type: 2, inputTokens: 500, outputTokens: 100, tool: "read_file_v2" },
      // A turn Cursor recorded with the counters zeroed contributes no request.
      { type: 2, tool: "mcp-atlassian-plugin-atlassian-getJiraIssue" },
      { type: 2, tool: "run_terminal_command_v2", toolStatus: "error" },
      { type: 2, tool: "task_v2", toolCallId: "spawn-1" },
    ],
  },
  {
    // Indexed only in the legacy blob, and spawned by the conversation above.
    id: "22222222-2222-4222-8222-222222222222",
    createdMs: DAY,
    index: "legacy",
    model: "claude-4.5-sonnet-thinking",
    project: "/work/alpha",
    subagent: {
      parentComposerId: "11111111-1111-4111-8111-111111111111",
      subagentTypeName: "explore",
      toolCallId: "spawn-1",
    },
    turns: [{ type: 1 }, { type: 2, inputTokens: 300, outputTokens: 50 }],
  },
  {
    // Present in neither index. On a real machine this is where most of the
    // tokens are, so it must still be discovered and counted.
    id: "33333333-3333-4333-8333-333333333333",
    createdMs: DAY,
    index: "none",
    model: "gpt-5",
    turns: [{ type: 1 }, { type: 2, inputTokens: 700, outputTokens: 90, sentMs: LATER }],
  },
  {
    // Current Cursor: turns carry the field with zeroes and settle usage
    // server-side, so this contributes prompts and tools but no tokens.
    id: "44444444-4444-4444-8444-444444444444",
    createdMs: LATER,
    updatedMs: LATER + 60_000,
    model: "claude-sonnet-5",
    name: "current conversation",
    project: "/work/beta",
    turns: [
      { type: 1 },
      { type: 2 },
      { type: 2, tool: "edit_file_v2" },
      { type: 2, tool: "glob_file_search" },
    ],
  },
  {
    // A multi-root window, whose workspace identifier names a document rather
    // than a directory, so no project can be attributed.
    id: "55555555-5555-4555-8555-555555555555",
    createdMs: LATER,
    model: "grok-4.6",
    multiRootConfigPath: "/somewhere/Workspaces/1/workspace.json",
    turns: [{ type: 1 }],
  },
];
