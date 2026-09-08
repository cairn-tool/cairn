import type { SchemaEntry } from "../types.js";
import { schemaUri } from "../version.js";
import { DRAFT } from "./shared.js";

/**
 * Token counters shared by a case row and the session totals.
 *
 * Inlined rather than cross-referenced: a schema retrieved with
 * `cairn schema qa-result` must compile on its own, so no `$ref` leaves this
 * document. Four camelCase fields — both backends map onto these; the snake_case
 * Claude Code names never appear in a payload.
 */
// Null whenever a case produced no `result` event — a timeout, a harness error, or a
// case skipped before launch — and on `summary` when no case reported usage at all.
const USAGE = {
  type: ["object", "null"],
  properties: {
    inputTokens: { type: "integer", minimum: 0 },
    outputTokens: { type: "integer", minimum: 0 },
    cacheReadTokens: { type: "integer", minimum: 0 },
    cacheWriteTokens: { type: "integer", minimum: 0 },
  },
};

const LIST_CASE = {
  type: "object",
  required: ["name", "title", "agent", "model", "constraint", "status"],
  properties: {
    name: { type: "string" },
    title: { type: "string" },
    agent: { type: "string", description: "Backend name: cursor or claude-code." },
    model: { type: "string" },
    constraint: { type: "string" },
    status: { enum: ["pending", "done"] },
    pending: {
      type: "boolean",
      description:
        "Present on `qa run --dry-run`: always true, because dry-run lists the eligible queue.",
    },
  },
};

const RUN_CASE = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    title: { type: "string" },
    agent: { type: "string" },
    model: { type: "string" },
    constraint: { type: "string" },
    pending: { type: "boolean" },
    status: { type: "string" },
    exitCode: { type: ["integer", "null"] },
    tools: { type: "integer", minimum: 0 },
    usage: USAGE,
    note: { type: "string" },
    sessionId: { type: "string" },
    logDir: { type: "string" },
  },
};

export const qaResultSchema: SchemaEntry = {
  id: "qa-result",
  uri: schemaUri("v1", "qa-result"),
  title: "cairn qa result",
  commands: ["qa run", "qa summary", "qa list"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "qa-result"),
    title: "cairn qa result",
    description:
      "The --format json payload of every qa subcommand. command discriminates the shape. Experimental: the payload may still change without a major schema version.",
    type: "object",
    required: ["command", "ok"],
    properties: {
      command: { enum: ["run", "summary", "list"] },
      ok: {
        type: "boolean",
        description:
          "False when qa run found a failing case. list and summary are always true on a successful invocation.",
      },
      dryRun: { type: "boolean", description: "Present on qa run --dry-run." },
      repo: { type: "string" },
      runsDir: { type: "string" },
      runId: { type: "string", description: "Present after qa run actually launched cases." },
      message: { type: "string", description: "Present when the eligible queue was empty." },
      path: { type: "string", description: "Absolute path written by qa summary." },
      planned: {
        type: "integer",
        minimum: 0,
        description: "Cases on disk; emitted by qa summary.",
      },
      run: {
        type: "integer",
        minimum: 0,
        description: "Cases that have a run folder; emitted by qa summary.",
      },
      cases: {
        type: "array",
        items: { anyOf: [LIST_CASE, RUN_CASE] },
      },
      summary: {
        type: "object",
        properties: {
          ok: { type: "integer", minimum: 0 },
          fail: { type: "integer", minimum: 0 },
          skipped: { type: "integer", minimum: 0 },
          tools: { type: "integer", minimum: 0 },
          usage: USAGE,
          planned: { type: "integer", minimum: 0 },
          pending: { type: "integer", minimum: 0 },
          done: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};
