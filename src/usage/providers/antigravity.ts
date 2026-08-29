import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { DayBucket, FileAggregate, ParsedFile, UsageEvent } from "../events.js";
import { emptyBucket, emptyTokens, utcDay } from "../events.js";
import type { SqliteDatabase, SqliteRow } from "../../sqlite.js";
import { loadSqlite } from "../../sqlite.js";
import { decode, int, str, sub, timestamp } from "./protobuf.js";
import type {
  DiscoverOptions,
  ProviderEnvironment,
  TranscriptFile,
  UsageProvider,
} from "./types.js";

/**
 * Google Antigravity CLI trajectories.
 *
 * Antigravity splits one conversation across two stores, joined by an id that is
 * simultaneously the SQLite filename stem, the brain directory name, and
 * `history.jsonl`'s `conversationId` (verified: 501 of 501 match):
 *
 * ```
 * conversations/<id>.db                                  tokens, model, identity
 * brain/<id>/.system_generated/logs/transcript.jsonl      tools, timeline, prompts
 * history.jsonl                                           slash commands
 * ```
 *
 * The JSONL carries named fields Google cannot silently renumber, and is the
 * source for everything it can answer. The SQLite half is protobuf with no
 * published schema — field numbers only — so it is read behind a validity guard
 * and supplies only what exists nowhere else. If that guard ever fails, the
 * token column is lost and the rest of the provider keeps working.
 *
 * The IDE's own store (`~/.gemini/antigravity/conversations/*.pb`) is encrypted
 * at rest and is deliberately not attempted.
 */

const CONVERSATIONS = "conversations";
const BRAIN = "brain";
const HISTORY = "history.jsonl";
const TRANSCRIPT = path.join(".system_generated", "logs", "transcript.jsonl");

/** LLM generation steps; the only ones carrying a usage message. */
const STEP_LLM_GENERATION = 15;

/** Within a step payload: the wrapper message, its timestamp, and its usage. */
const STEP_BODY = 5;
const STEP_TIMESTAMP = 1;
const STEP_USAGE = 9;

/**
 * Guards against a silent renumbering of the usage message.
 *
 * `completion == thinking + output` held in every record inspected, and the
 * largest prompt seen anywhere was 118,471. A field that stops satisfying both
 * is not the field we think it is, and emitting its value as a token count
 * would be worse than emitting nothing.
 */
const MAX_PROMPT_TOKENS = 2_000_000;

// Usage message field numbers, from `--decode_raw` against real trajectories.
const USAGE_COMPLETION = 3;
const USAGE_PROMPT = 5;
const USAGE_THINKING = 9;
const USAGE_OUTPUT = 10;

interface Identity {
  project: string;
  gitBranch?: string;
  title?: string;
  agentType?: string;
  parent?: string;
  startedAt: string | null;
}

function fileUriToPath(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("file://") ? decodeURIComponent(value.slice("file://".length)) : value;
}

/**
 * Reads the trajectory header.
 *
 * Unlike the usage message these are string fields, which validate themselves —
 * a workspace is a `file://` URI or it is not one — so they need no numeric
 * guard.
 */
function readIdentity(db: SqliteDatabase): Identity {
  const identity: Identity = { project: "", startedAt: null };
  let row: SqliteRow | undefined;
  try {
    row = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").get();
  } catch {
    return identity;
  }
  const blob = row?.data;
  if (!(blob instanceof Uint8Array)) return identity;
  const root = decode(Buffer.from(blob));

  const workspace = sub(root, 1);
  if (workspace) {
    identity.project = fileUriToPath(str(workspace, 1));
    identity.gitBranch = str(workspace, 4);
  }
  identity.startedAt = timestamp(sub(root, 2));
  identity.agentType = str(sub(root, 4) ?? {}, 1) ?? str(sub(root, 8) ?? {}, 1);
  identity.title = str(sub(root, 8) ?? {}, 2);
  identity.parent = str(root, 5);
  return identity;
}

interface UsageRow {
  day: string;
  at: string;
  prompt: number;
  thinking: number;
  output: number;
}

/**
 * Reads per-request usage, or null when the guard fails.
 *
 * Prompt tokens are **per-request context size, not a running total** — they
 * were measured falling 1,479 times across the corpus as context is trimmed —
 * so these are summed, never differenced. What that sums to is context
 * processed, which re-counts a prompt prefix once per turn; it is reported as
 * input because no cache breakdown exists to separate the two.
 */
function readUsage(db: SqliteDatabase): UsageRow[] | null {
  let rows: SqliteRow[];
  try {
    rows = db
      .prepare(`SELECT step_payload FROM steps WHERE step_type = ${STEP_LLM_GENERATION}`)
      .all();
  } catch {
    return null;
  }

  const usage: UsageRow[] = [];
  for (const row of rows) {
    const blob = row.step_payload;
    if (!(blob instanceof Uint8Array)) continue;
    const step = sub(decode(Buffer.from(blob)), STEP_BODY);
    if (!step) continue;
    const message = sub(step, STEP_USAGE);
    if (!message) continue;

    const completion = int(message, USAGE_COMPLETION);
    const prompt = int(message, USAGE_PROMPT);
    const thinking = int(message, USAGE_THINKING);
    const output = int(message, USAGE_OUTPUT);

    // The guard. A renumbering breaks one of these long before it produces a
    // plausible-looking wrong answer.
    if (completion !== thinking + output) return null;
    if (prompt < 0 || prompt > MAX_PROMPT_TOKENS) return null;

    const at = timestamp(sub(step, STEP_TIMESTAMP));
    const day = at ? utcDay(at) : null;
    if (!at || !day) continue;
    usage.push({ day, at, prompt, thinking, output });
  }
  return usage;
}

/** The model family, which does not vary within a trajectory. */
function readModel(db: SqliteDatabase): string {
  try {
    const row = db.prepare("SELECT data FROM gen_metadata ORDER BY idx LIMIT 1").get();
    const blob = row?.data;
    if (!(blob instanceof Uint8Array)) return "(unknown)";
    const generation = sub(decode(Buffer.from(blob)), 1);
    if (!generation) return "(unknown)";
    return str(generation, 19) ?? str(generation, 21) ?? "(unknown)";
  } catch {
    return "(unknown)";
  }
}

interface TranscriptRecord {
  type?: string;
  source?: string;
  status?: string;
  created_at?: string;
  error?: string;
  tool_calls?: Array<{ name?: string }>;
}

function bucketOf(aggregate: FileAggregate, at: string): DayBucket | null {
  const day = utcDay(at);
  if (!day) return null;
  if (!aggregate.firstTs || at < aggregate.firstTs) aggregate.firstTs = at;
  if (!aggregate.lastTs || at > aggregate.lastTs) aggregate.lastTs = at;
  return (aggregate.days[day] ??= emptyBucket());
}

/**
 * Reads the JSONL transcript for tools, prompts, and errors.
 *
 * `transcript.jsonl` rather than `transcript_full.jsonl`: the two share a
 * schema and differ only in whether long strings are truncated, so the short
 * one carries every structural fact at roughly two thirds the bytes.
 *
 * About one line in a thousand is torn by an interleaved append and will not
 * parse. Those are counted, never fatal.
 */
async function readTranscript(
  file: string,
  aggregate: FileAggregate,
  events: UsageEvent[],
): Promise<void> {
  let lines: readline.Interface;
  try {
    if (!fs.statSync(file).isFile()) return;
    lines = readline.createInterface({
      input: createReadStream(file, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
  } catch {
    return;
  }

  for await (const line of lines) {
    if (!line) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      aggregate.malformedLines += 1;
      continue;
    }
    if (!record || typeof record !== "object" || !record.created_at) continue;
    const bucket = bucketOf(aggregate, record.created_at);
    if (!bucket) continue;

    const at = record.created_at;
    for (const call of record.tool_calls ?? []) {
      const name = call?.name;
      if (typeof name === "string" && name) {
        bucket.tools[name] = (bucket.tools[name] ?? 0) + 1;
        events.push({ ts: at, kind: "tool_use", tool: name });
      }
    }
    if (record.type === "USER_INPUT" && record.source === "USER_EXPLICIT") {
      bucket.prompts += 1;
      events.push({ ts: at, kind: "prompt" });
    }
    if (record.type === "ERROR_MESSAGE" || record.status === "ERROR") {
      bucket.errors += 1;
      events.push({ ts: at, kind: "error" });
    }
    if (record.type === "CHECKPOINT") {
      bucket.compactions += 1;
      events.push({ ts: at, kind: "compaction" });
    }
  }
}

/**
 * Slash commands, read once per root.
 *
 * `history.jsonl` is a single small file at the log root rather than something
 * per conversation, so it is memoized. A conversation's cached aggregate keys on
 * its database, which means a slash command recorded after that database last
 * changed will not appear until it does — an acceptable trade for not re-reading
 * the file five hundred times.
 */
const historyCache = new Map<string, Map<string, Record<string, number>>>();

function readHistory(root: string): Map<string, Record<string, number>> {
  const cached = historyCache.get(root);
  if (cached) return cached;
  const byConversation = new Map<string, Record<string, number>>();
  try {
    for (const line of fs.readFileSync(path.join(root, HISTORY), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let row: { type?: string; display?: string; conversationId?: string };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (row.type !== "slash_command" || !row.conversationId || !row.display) continue;
      const commands = byConversation.get(row.conversationId) ?? {};
      const name = row.display.trim().split(/\s+/)[0];
      commands[name] = (commands[name] ?? 0) + 1;
      byConversation.set(row.conversationId, commands);
    }
  } catch {
    // No history file is simply no slash commands.
  }
  historyCache.set(root, byConversation);
  return byConversation;
}

export const antigravityProvider: UsageProvider = {
  name: "antigravity",
  title: "Antigravity CLI",
  source: "Trajectories under ~/.gemini/antigravity-cli (CLI only; the IDE store is encrypted)",
  capabilities: {
    tokens: true,
    // No cache-read or cache-write breakdown exists anywhere on disk.
    cacheTokens: false,
    tools: true,
    // Skills are configured but no per-invocation record is written.
    skills: false,
    subagents: true,
    // A stop hook appears only as prose inside a system message. Counting a
    // substring of free text is a guess, not a measurement.
    hooks: false,
    // No MCP tool has ever fired here, and a tool name carries no server.
    mcp: false,
    slashCommands: true,
    projects: true,
  },

  root(context: ProviderEnvironment): string | null {
    const candidate =
      context.override?.trim() || path.join(context.home, ".gemini", "antigravity-cli");
    try {
      return fs.statSync(path.join(candidate, CONVERSATIONS)).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  },

  discover(root: string, options: DiscoverOptions): TranscriptFile[] {
    const directory = path.join(root, CONVERSATIONS);
    const found: TranscriptFile[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return found;
    }

    for (const entry of entries) {
      // `-wal` and `-shm` are live-write sidecars, not trajectories.
      if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
      const file = path.join(directory, entry.name);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(file);
      } catch {
        continue;
      }
      if (options.modifiedSince !== undefined && stats.mtimeMs < options.modifiedSince) continue;
      found.push({
        file,
        relative: entry.name,
        shard: CONVERSATIONS,
        // Whether a trajectory is a subagent is recorded inside it, so `read`
        // sets the real value and the scan filters on that.
        kind: "main",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }

    found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return found;
  },

  async read(file: TranscriptFile): Promise<FileAggregate> {
    return (await antigravityProvider.parse(file)).aggregate;
  },

  async parse(file: TranscriptFile): Promise<ParsedFile> {
    const id = path.basename(file.file, ".db");
    const root = path.dirname(path.dirname(file.file));

    const aggregate: FileAggregate = {
      file: file.file,
      size: file.size,
      mtimeMs: file.mtimeMs,
      provider: antigravityProvider.name,
      sessionId: id,
      kind: "main",
      project: "",
      firstTs: "",
      lastTs: "",
      days: {},
      malformedLines: 0,
    };

    const events: UsageEvent[] = [];
    const sqlite = loadSqlite();
    if (sqlite) {
      let db: SqliteDatabase | undefined;
      try {
        // Read-only: two databases carry live `-wal` sidecars.
        db = new sqlite.DatabaseSync(file.file, { readOnly: true });
        const identity = readIdentity(db);
        aggregate.project = identity.project;
        if (identity.gitBranch) aggregate.gitBranch = identity.gitBranch;
        if (identity.title) aggregate.title = identity.title;
        if (identity.parent && identity.parent !== id) {
          aggregate.kind = "subagent";
          aggregate.parentSessionId = identity.parent;
          if (identity.agentType) {
            aggregate.agentType = identity.agentType;
            aggregate.agentPath = identity.agentType;
          }
        }

        const usage = readUsage(db);
        if (usage) {
          const model = readModel(db);
          for (const row of usage) {
            const bucket = bucketOf(aggregate, row.at);
            if (!bucket) continue;
            const totals = (bucket.models[model] ??= emptyTokens());
            totals.input += row.prompt;
            totals.output += row.output;
            totals.thinking += row.thinking;
            totals.requests += 1;
            events.push({
              ts: row.at,
              kind: "response",
              model,
              tokens: {
                ...emptyTokens(),
                input: row.prompt,
                output: row.output,
                thinking: row.thinking,
                requests: 1,
              },
            });
          }
        }
      } catch {
        // An unreadable database costs the token column, not the trajectory.
      } finally {
        try {
          db?.close();
        } catch {
          // Closing a database that never opened is not an error worth raising.
        }
      }
    }

    await readTranscript(path.join(root, BRAIN, id, TRANSCRIPT), aggregate, events);

    const commands = readHistory(root).get(id);
    if (commands && aggregate.firstTs) {
      const day = utcDay(aggregate.firstTs);
      if (day) {
        const bucket = (aggregate.days[day] ??= emptyBucket());
        for (const [name, uses] of Object.entries(commands)) {
          bucket.commands[name] = (bucket.commands[name] ?? 0) + uses;
          // `history.jsonl` records no per-use timestamp, so every use is
          // stamped with the conversation's first — the same day the bucket
          // above files it under.
          for (let use = 0; use < uses; use++) {
            events.push({ ts: aggregate.firstTs, kind: "command", name });
          }
        }
      }
    }

    return { aggregate, events };
  },
};
