import type { JsonSchema, SchemaEntry } from "../types.js";
import { schemaUri } from "../version.js";
import { DRAFT, stringArray } from "./shared.js";

/**
 * Fragments are inlined into every document that needs them rather than shared
 * by `$ref`: a schema retrieved with `claude-cli schema <id>` must compile on
 * its own.
 */
const TOKENS: JsonSchema = {
  type: "object",
  description: "Token counters. Requests are deduplicated API responses, not transcript lines.",
  required: [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite5m",
    "cacheWrite1h",
    "thinking",
    "webSearch",
    "webFetch",
    "requests",
  ],
  properties: {
    input: { type: "integer", minimum: 0 },
    output: { type: "integer", minimum: 0 },
    cacheRead: { type: "integer", minimum: 0 },
    cacheWrite: {
      type: "integer",
      minimum: 0,
      description: "Authoritative cache-write total, whether or not the TTL split is known.",
    },
    cacheWrite5m: {
      type: "integer",
      minimum: 0,
      description:
        "Best-effort TTL split. The oldest records carry no split, so 5m and 1h can sum to less than cacheWrite, and never to more.",
    },
    cacheWrite1h: { type: "integer", minimum: 0 },
    thinking: { type: "integer", minimum: 0 },
    webSearch: { type: "integer", minimum: 0, description: "Server-side web search requests." },
    webFetch: { type: "integer", minimum: 0 },
    requests: { type: "integer", minimum: 0 },
  },
};

const SCOPE: JsonSchema = {
  type: "object",
  description: "What the report covered.",
  required: ["provider", "root", "window", "projects", "subagents", "last", "index"],
  properties: {
    provider: { type: "string" },
    root: { type: "string", description: "Log root the transcripts were read from." },
    window: {
      type: "object",
      description: "Inclusive day bounds. Null means unbounded on that side.",
      required: ["since", "until"],
      properties: {
        since: { type: ["string", "null"] },
        until: { type: ["string", "null"] },
      },
    },
    projects: { ...stringArray, description: "`--project` selectors, as typed." },
    subagents: { type: "boolean" },
    last: { type: ["integer", "null"], minimum: 0 },
    index: { type: "boolean", description: "False when `--no-index` bypassed the cache." },
  },
};

const SCAN: JsonSchema = {
  type: "object",
  description:
    "What the scan touched. Unreadable transcripts and malformed lines are counted rather than fatal; only --strict turns them into exit 2.",
  required: ["discovered", "cached", "parsed", "skipped", "malformed", "selected", "failures"],
  properties: {
    discovered: { type: "integer", minimum: 0 },
    cached: { type: "integer", minimum: 0, description: "Served from the index unopened." },
    parsed: { type: "integer", minimum: 0 },
    skipped: { type: "integer", minimum: 0 },
    malformed: { type: "integer", minimum: 0, description: "Lines that were not valid JSON." },
    selected: {
      type: "integer",
      minimum: 0,
      description: "Transcripts left after the project and window filters.",
    },
    failures: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "reason"],
        properties: { file: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

const CAPABILITIES: JsonSchema = {
  type: "object",
  description:
    "What this provider's logs can answer. Reports read these rather than branching on the provider name.",
  required: [
    "tokens",
    "cacheTokens",
    "tools",
    "skills",
    "subagents",
    "hooks",
    "mcp",
    "slashCommands",
    "projects",
  ],
  properties: {
    tokens: { type: "boolean" },
    cacheTokens: { type: "boolean" },
    tools: { type: "boolean" },
    skills: { type: "boolean" },
    subagents: { type: "boolean" },
    hooks: { type: "boolean" },
    mcp: { type: "boolean" },
    slashCommands: { type: "boolean" },
    projects: { type: "boolean" },
  },
};

const ROW: JsonSchema = {
  type: "object",
  description:
    "One rollup row. Only `key` and `count` are always present; each dimension fills in the fields that mean something for it, so read a row by the `dimension` the payload declares.",
  required: ["key", "count"],
  properties: {
    key: { type: "string" },
    count: {
      type: "integer",
      minimum: 0,
      description:
        "The dimension's primary tally: requests for tokens, calls for tools, spawns for agents, runs for hooks.",
    },
    tokens: TOKENS,
    sessions: { type: "integer", minimum: 0 },
    toolCalls: { type: "integer", minimum: 0 },
    prompts: { type: "integer", minimum: 0 },
    kind: { enum: ["builtin", "mcp", "agent", "skill"] },
    server: { type: "string", description: "MCP server, for a tool named mcp__<server>__<tool>." },
    failures: { type: "integer", minimum: 0 },
    cancelled: { type: "integer", minimum: 0 },
    meanMs: { type: "integer", minimum: 0 },
    maxMs: { type: "integer", minimum: 0 },
    maxDepth: { type: "integer", minimum: 0, description: "Deepest observed subagent nesting." },
    project: { type: "string" },
    title: { type: "string" },
    gitBranch: { type: "string" },
    firstTs: { type: "string" },
    lastTs: { type: "string" },
    durationMs: { type: "integer", minimum: 0 },
    subagents: { type: "integer", minimum: 0, description: "Subagent transcripts in the session." },
    models: stringArray,
  },
};

export const usageRollupSchema: SchemaEntry = {
  id: "usage-rollup",
  uri: schemaUri("v1", "usage-rollup"),
  title: "Usage rollup",
  commands: [
    "usage tokens",
    "usage tools",
    "usage sessions",
    "usage projects",
    "usage skills",
    "usage agents",
    "usage hooks",
    "usage commands",
  ],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "usage-rollup"),
    title: "Usage rollup",
    description:
      "Emitted by every tabular `usage` subcommand with `--format json`. `rows` is what `--top` left; `totals` always covers the whole selection.",
    type: "object",
    required: ["provider", "scope", "dimension", "rows", "truncated", "totals", "scan"],
    properties: {
      provider: { type: "string" },
      scope: SCOPE,
      dimension: {
        type: "string",
        description:
          "What each row's `key` names: model, day, week, month, project, session, name, kind, server, skill, agent, hook, or command.",
      },
      rows: { type: "array", items: ROW },
      truncated: {
        type: "boolean",
        description: "True when --top clipped the listing. `totals` is unaffected.",
      },
      totals: {
        type: "object",
        required: ["rows", "count", "tokens"],
        properties: {
          rows: { type: "integer", minimum: 0, description: "Rows before --top clipped them." },
          count: { type: "integer", minimum: 0 },
          tokens: TOKENS,
        },
      },
      scan: SCAN,
    },
  },
};

export const usageSummarySchema: SchemaEntry = {
  id: "usage-summary",
  uri: schemaUri("v1", "usage-summary"),
  title: "Usage summary",
  commands: ["usage summary"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "usage-summary"),
    title: "Usage summary",
    description: "Emitted by `usage summary --format json`. Headline totals over the selection.",
    type: "object",
    required: ["provider", "scope", "summary", "scan"],
    properties: {
      provider: { type: "string" },
      scope: SCOPE,
      summary: {
        type: "object",
        required: [
          "sessions",
          "transcripts",
          "subagentTranscripts",
          "projects",
          "prompts",
          "errors",
          "compactions",
          "firstDay",
          "lastDay",
          "days",
          "tokens",
          "tokensByKind",
          "models",
          "tools",
          "features",
        ],
        properties: {
          sessions: { type: "integer", minimum: 0 },
          transcripts: { type: "integer", minimum: 0 },
          subagentTranscripts: { type: "integer", minimum: 0 },
          projects: { type: "integer", minimum: 0 },
          prompts: {
            type: "integer",
            minimum: 0,
            description:
              "Turns the user actually typed, excluding tool results and injected turns.",
          },
          errors: { type: "integer", minimum: 0, description: "Recorded API errors." },
          compactions: { type: "integer", minimum: 0 },
          firstDay: { type: ["string", "null"] },
          lastDay: { type: ["string", "null"] },
          days: { type: "integer", minimum: 0, description: "Days with any activity." },
          tokens: TOKENS,
          tokensByKind: {
            type: "object",
            description: "The same totals split by transcript kind.",
            required: ["main", "subagent"],
            properties: { main: TOKENS, subagent: TOKENS },
          },
          models: { type: "array", items: ROW, description: "Top models by token total." },
          tools: { type: "array", items: ROW, description: "Top tools by call count." },
          features: {
            type: "object",
            required: ["skills", "subagents", "hooks", "hookFailures", "slashCommands", "mcpCalls"],
            properties: {
              skills: { type: "integer", minimum: 0 },
              subagents: { type: "integer", minimum: 0 },
              hooks: { type: "integer", minimum: 0 },
              hookFailures: { type: "integer", minimum: 0 },
              slashCommands: { type: "integer", minimum: 0 },
              mcpCalls: { type: "integer", minimum: 0 },
            },
          },
        },
      },
      scan: SCAN,
    },
  },
};

export const usageProvidersSchema: SchemaEntry = {
  id: "usage-providers",
  uri: schemaUri("v1", "usage-providers"),
  title: "Usage providers",
  commands: ["usage providers"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "usage-providers"),
    title: "Usage providers",
    description:
      "Emitted by `usage providers --format json`. Every registered log source, whether it is present on this machine, and what it can report.",
    type: "object",
    required: ["providers"],
    properties: {
      providers: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "title", "source", "default", "available", "root", "capabilities"],
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            source: { type: "string", description: "Where this provider's logs come from." },
            default: { type: "boolean" },
            available: { type: "boolean" },
            root: { type: ["string", "null"], description: "Null when nothing was found." },
            capabilities: CAPABILITIES,
          },
        },
      },
    },
  },
};

export const usageIndexSchema: SchemaEntry = {
  id: "usage-index",
  uri: schemaUri("v1", "usage-index"),
  title: "Usage index status",
  commands: ["usage index"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "usage-index"),
    title: "Usage index status",
    description:
      "Emitted by `usage index --format json`. The scan cache is a private, self-invalidating store; its internal version is not part of this contract and can change without notice.",
    type: "object",
    required: ["provider", "action", "cache"],
    properties: {
      provider: { type: "string" },
      action: { enum: ["status", "rebuild", "clear"] },
      cache: {
        type: "object",
        required: ["root", "present", "shards", "entries", "bytes", "updatedAt"],
        properties: {
          root: { type: "string" },
          present: { type: "boolean" },
          shards: { type: "integer", minimum: 0 },
          entries: { type: "integer", minimum: 0, description: "Transcripts held in the cache." },
          bytes: { type: "integer", minimum: 0 },
          updatedAt: { type: ["string", "null"] },
        },
      },
      removed: { type: "integer", minimum: 0, description: "Shards deleted by --clear." },
      scan: SCAN,
    },
  },
};
