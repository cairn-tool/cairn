import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { DayBucket, FileAggregate, ParsedFile, TokenTotals, UsageEvent } from "../events.js";
import { addTokens, emptyBucket, emptyTokens, utcDay } from "../events.js";
import type {
  DiscoverOptions,
  ProviderEnvironment,
  TranscriptFile,
  UsageProvider,
} from "./types.js";

/**
 * Google Gemini CLI chat transcripts.
 *
 * ```
 * tmp/<slug>/chats/session-<local stamp>-<short id>.jsonl   main
 * tmp/<slug>/chats/<parent session uuid>/<short id>.jsonl   subagent
 * tmp/<slug>/.project_root                                  the absolute project root
 * tmp/<slug>/logs.json                                      prompts and slash commands
 * ```
 *
 * **This provider shares `~/.gemini` with `antigravity` and must not collide
 * with it.** That one roots at `~/.gemini/antigravity-cli`; this one roots at
 * `~/.gemini` and guards on `tmp/`, so neither can claim the other's tree.
 *
 * Line 1 is normally a header — `{sessionId, projectHash, startTime,
 * lastUpdated, kind}`, plus `directories` on a subagent — but not always: at
 * least one file in a real corpus begins with an ordinary record, so the header
 * is detected rather than assumed. Later lines are either
 * `{id, timestamp, type, content, toolCalls?, model, tokens?}` or a `$set`
 * patch record.
 *
 * **It is the only provider that has to undo two distortions at once**, and a
 * third on top:
 *
 * 1. `tokens.cached` is contained *inside* `tokens.input`, as Codex's is, so
 *    the cached part is subtracted out and reported as a cache read. Left
 *    merged, input reads several times high.
 * 2. `tokens.input` is a **per-request context size and not a running total**,
 *    as Antigravity's is — it falls whenever context is trimmed, so it is
 *    summed. Differencing it produces nonsense.
 * 3. One assistant turn is written **two to five times under a single `id`**,
 *    each copy carrying identical `tokens`. Counting every copy roughly doubles
 *    every figure, so tokens are deduplicated on `id`.
 *
 * `total === input + output + thoughts` holds on every record of a real corpus
 * and is used as a validity guard. Unlike Antigravity's — where a wholesale
 * protobuf renumbering would poison every field at once, so the whole file's
 * token column is abandoned — these fields are *named*, so a record that fails
 * the guard is only ever one bad record. It contributes no tokens and the rest
 * of the file is kept.
 */

/** The discovery root under the Gemini home; also what `root()` guards on. */
const TMP = "tmp";
const CHATS = "chats";
const PROJECT_ROOT = ".project_root";
const LOGS = "logs.json";

/**
 * The guard's upper bound on one request's context.
 *
 * Comfortably above any real Gemini context window, and low enough that a
 * misread field is caught rather than summed into the totals.
 */
const MAX_CONTEXT_TOKENS = 4_000_000;

interface RawToolCall {
  id?: unknown;
  name?: unknown;
  args?: Record<string, unknown>;
  status?: unknown;
  agentId?: unknown;
}

interface RawRecord {
  // Header fields, present on line 1 of almost every file.
  sessionId?: unknown;
  startTime?: unknown;
  kind?: unknown;
  directories?: unknown;
  // Record fields.
  id?: unknown;
  timestamp?: unknown;
  type?: unknown;
  toolCalls?: unknown;
  model?: unknown;
  tokens?: Record<string, unknown>;
  $set?: Record<string, unknown>;
}

/** A finite number, or null when the field is absent or the wrong shape. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Normalizes one record's `tokens`, or returns null when it fails the guard.
 *
 * `cached` is subtracted out of `input` because Gemini counts a cache read
 * inside its input figure, and reported separately. There is no cache-*write*
 * counter anywhere on disk, so `cacheWrite` is always zero — the same shape
 * Codex reports for a request that wrote no cache.
 */
function readUsage(raw: Record<string, unknown>): TokenTotals | null {
  const input = num(raw.input);
  const output = num(raw.output);
  const thoughts = num(raw.thoughts);
  const cached = num(raw.cached);
  const total = num(raw.total);
  if (input === null || output === null || thoughts === null || total === null) return null;
  if (cached === null || cached < 0 || cached > input) return null;
  if (input < 0 || output < 0 || thoughts < 0) return null;
  if (input > MAX_CONTEXT_TOKENS) return null;
  if (total !== input + output + thoughts) return null;
  return {
    input: input - cached,
    output,
    cacheRead: cached,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    thinking: thoughts,
    webSearch: 0,
    webFetch: 0,
    requests: 1,
  };
}

interface ParseState {
  aggregate: FileAggregate;
  events: UsageEvent[];
  /** Timestamp of the record being applied, which every event is stamped with. */
  ts: string;
  /** Response ids already counted; see distortion 3 in the module comment. */
  tokenIds: Set<string>;
  /**
   * The last `toolCalls` seen for each response id, flushed at end of file.
   *
   * Tool calls need their own deduplication and cannot ride on the token one:
   * a repeated record carries identical tokens but a **growing** tool list, and
   * some records carry tool calls with no tokens at all. Repeats go empty→full
   * and full→full, and a later list is sometimes longer than the earlier one,
   * so the rule is last-wins — which is not knowable until the file ends.
   */
  pendingTools: Map<string, { ts: string; calls: RawToolCall[] }>;
}

function emit(state: ParseState, event: Omit<UsageEvent, "ts">): void {
  state.events.push({ ts: state.ts, ...event });
}

function bucketFor(state: ParseState, timestamp: string | undefined): DayBucket | null {
  const day = timestamp ? utcDay(timestamp) : null;
  if (!day) return null;
  const aggregate = state.aggregate;
  if (!aggregate.firstTs || timestamp! < aggregate.firstTs) aggregate.firstTs = timestamp!;
  if (!aggregate.lastTs || timestamp! > aggregate.lastTs) aggregate.lastTs = timestamp!;
  return (aggregate.days[day] ??= emptyBucket());
}

/**
 * Counts one flushed tool call.
 *
 * The name is kept exactly as Gemini wrote it. `invoke_agent` and
 * `activate_skill` are this assistant's own builtins and are counted as such in
 * `tools`, while also filling `agents` and `skills` — the same split
 * `claude-code.ts` makes for `Agent` and `Skill`, and `codex.ts` for
 * `spawn_agent`. Renaming them to Claude Code's vocabulary would print a tool
 * that does not appear in the transcript.
 */
function applyToolCall(state: ParseState, bucket: DayBucket, call: RawToolCall): void {
  const name = text(call.name);
  if (!name) return;
  bucket.tools[name] = (bucket.tools[name] ?? 0) + 1;
  emit(state, { kind: "tool_use", tool: name });

  if (name === "invoke_agent") {
    const role = text(call.args?.agent_name) ?? "(unrecorded)";
    const totals = (bucket.agents[role] ??= { count: 0, maxDepth: 0 });
    totals.count += 1;
    emit(state, { kind: "agent", name: role });
  } else if (name === "activate_skill") {
    const skill = text(call.args?.name);
    if (skill) {
      bucket.skills[skill] = (bucket.skills[skill] ?? 0) + 1;
      emit(state, { kind: "skill", name: skill });
    }
  }

  // `cancelled` is deliberately not counted: `DayBucket` has no cancelled
  // counter outside `hooks`, and folding one into `errors` would report a
  // user's interruption as a failure.
  if (text(call.status) === "error") {
    bucket.errors += 1;
    emit(state, { kind: "error" });
  }
}

function flushTools(state: ParseState): void {
  for (const pending of state.pendingTools.values()) {
    const bucket = bucketFor(state, pending.ts);
    if (!bucket) continue;
    state.ts = pending.ts;
    for (const call of pending.calls) applyToolCall(state, bucket, call);
  }
  state.pendingTools.clear();
}

function applyRecord(state: ParseState, record: RawRecord): void {
  // A `$set` patch never carries tokens or tool calls — only `lastUpdated`,
  // `summary` (the session title, not a context reset), and `memoryScratchpad`.
  // Its timestamp would otherwise open a spurious day bucket.
  if (record.$set) return;

  const timestamp = text(record.timestamp);
  const bucket = bucketFor(state, timestamp ?? undefined);
  if (!bucket) return;
  state.ts = timestamp!;

  const id = text(record.id);

  if (record.tokens && id && !state.tokenIds.has(id)) {
    state.tokenIds.add(id);
    const tokens = readUsage(record.tokens);
    if (tokens) {
      const model = text(record.model) ?? "(unknown)";
      addTokens((bucket.models[model] ??= emptyTokens()), tokens);
      emit(state, { kind: "response", model, tokens });
    }
  }

  if (Array.isArray(record.toolCalls) && id) {
    state.pendingTools.set(id, { ts: timestamp!, calls: record.toolCalls as RawToolCall[] });
  }

  // A subagent transcript's `user` record is the spawn instruction its parent
  // injected, not a human turn. On a real corpus those outnumber real prompts
  // fourteen to one, so counting them would make the prompt figure meaningless.
  if (record.type === "user" && state.aggregate.kind === "main") {
    bucket.prompts += 1;
    emit(state, { kind: "prompt" });
  }
}

/** Applies line 1 when it is a header rather than an ordinary record. */
function applyHeader(aggregate: FileAggregate, record: RawRecord): void {
  const session = text(record.sessionId);
  if (session) aggregate.sessionId = session;
  if (Array.isArray(record.directories)) {
    const first = text(record.directories[0]);
    if (first) aggregate.project = first;
  }
}

function isHeader(record: RawRecord): boolean {
  return typeof record.sessionId === "string" && record.type === undefined;
}

function listDirectory(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statOf(file: string): fs.Stats | null {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

/**
 * The absolute project root for one slug directory, memoized.
 *
 * `.project_root` is exact where Claude Code's directory slug is lossy, so
 * there is no need to reconstruct anything. `projectHash` in the header is a
 * sha256 of this same path — a cross-check, not a source, since a hash cannot
 * be read back — and `~/.gemini/projects.json` duplicates it from outside the
 * shard, so neither is used.
 */
const projectRoots = new Map<string, string>();

function readProjectRoot(shardDirectory: string): string {
  const cached = projectRoots.get(shardDirectory);
  if (cached !== undefined) return cached;
  let value = "";
  try {
    value = fs.readFileSync(path.join(shardDirectory, PROJECT_ROOT), "utf-8").trim();
  } catch {
    // No `.project_root`: the project is left unattributed rather than guessed
    // at from the slug, which is lossy.
  }
  projectRoots.set(shardDirectory, value);
  return value;
}

interface LoggedCommand {
  ts: string;
  name: string;
}

/**
 * Slash commands for one slug directory, memoized, keyed by session id.
 *
 * The transcript keeps only the *expanded* prompt: `/opplan-convert foo`
 * reaches the chat as `foo`, so the command's name survives nowhere but
 * `logs.json`. Each entry carries its own timestamp, so a command lands on the
 * day it was used rather than on the session's first day.
 *
 * Two limits worth knowing, both inherent rather than defects. A cached
 * aggregate keys on the *chat file's* size and mtime, so a command written
 * after that file last changed is not seen until it changes again. And
 * `logs.json` outlives the transcripts — `/clear` keeps the session id while
 * truncating the chat — so commands belonging to a session with no surviving
 * transcript have no aggregate to attach to and are dropped.
 */
const projectCommands = new Map<string, Map<string, LoggedCommand[]>>();

function readProjectCommands(shardDirectory: string): Map<string, LoggedCommand[]> {
  const cached = projectCommands.get(shardDirectory);
  if (cached) return cached;
  const found = new Map<string, LoggedCommand[]>();
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(shardDirectory, LOGS), "utf-8"),
    ) as unknown[];
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const record = entry as { sessionId?: unknown; message?: unknown; timestamp?: unknown };
      const session = text(record.sessionId);
      const message = text(record.message);
      const ts = text(record.timestamp);
      if (!session || !message || !ts || !message.startsWith("/")) continue;
      const name = message.trim().split(/\s+/)[0];
      if (!name || name === "/") continue;
      const list = found.get(session) ?? [];
      list.push({ ts, name });
      found.set(session, list);
    }
  } catch {
    // No history, or a torn file. Commands are one counter among many.
  }
  projectCommands.set(shardDirectory, found);
  return found;
}

export const geminiCliProvider: UsageProvider = {
  name: "gemini-cli",
  title: "Gemini CLI",
  // No environment override exists: the CLI was checked for one and none is
  // honoured for the data root, so `--logs` is the only way to point it elsewhere.
  source: "Chat transcripts under ~/.gemini/tmp (no environment override; use --logs)",
  capabilities: {
    tokens: true,
    // `cached` is a real, measured cache read, contained inside `input` and
    // subtracted back out. No cache-*write* figure exists anywhere on disk, so
    // that counter is always zero.
    cacheTokens: true,
    tools: true,
    // `activate_skill` names the skill in `args.name`.
    skills: true,
    // Subagent transcripts nest one level under `chats/`, and outnumber main
    // transcripts by more than an order of magnitude.
    subagents: true,
    // Hooks are configured in ~/.gemini/settings.json, but no execution of one
    // is written to any transcript record.
    hooks: false,
    // A tool call records a bare name and nothing else, so an MCP tool cannot
    // be told from a builtin and there is no server to attribute it to.
    mcp: false,
    // From logs.json, which is the only place a command is named.
    slashCommands: true,
    projects: true,
  },

  root(context: ProviderEnvironment): string | null {
    const candidate = context.override?.trim() || path.join(context.home, ".gemini");
    try {
      return fs.statSync(path.join(candidate, TMP)).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  },

  discover(root: string, options: DiscoverOptions): TranscriptFile[] {
    const tmp = path.join(root, TMP);
    const found: TranscriptFile[] = [];

    const accept = (
      file: string,
      shard: string,
      kind: TranscriptFile["kind"],
      stats: fs.Stats,
    ): void => {
      if (options.modifiedSince !== undefined && stats.mtimeMs < options.modifiedSince) return;
      found.push({
        file,
        relative: path.relative(tmp, file),
        shard,
        kind,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    };

    for (const slug of listDirectory(tmp)) {
      if (!slug.isDirectory()) continue;
      // Requiring a `chats/` directory is what keeps `tmp/bin/` out: the CLI
      // downloads helper binaries there, beside the projects.
      const chats = path.join(tmp, slug.name, CHATS);
      for (const entry of listDirectory(chats)) {
        const full = path.join(chats, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const stats = statOf(full);
          if (stats) accept(full, slug.name, "main", stats);
          continue;
        }
        if (!entry.isDirectory() || !options.subagents) continue;
        for (const agent of listDirectory(full)) {
          if (!agent.isFile() || !agent.name.endsWith(".jsonl")) continue;
          const agentFile = path.join(full, agent.name);
          const stats = statOf(agentFile);
          if (stats) accept(agentFile, slug.name, "subagent", stats);
        }
      }
    }

    // Byte comparison, never localeCompare: the order must not depend on the
    // ICU build of the machine that ran the scan.
    found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return found;
  },

  async read(file: TranscriptFile): Promise<FileAggregate> {
    return (await geminiCliProvider.parse(file)).aggregate;
  },

  async parse(file: TranscriptFile): Promise<ParsedFile> {
    const subagent = file.kind === "subagent";
    // A subagent's parent is its containing directory, exactly as it is for
    // Claude Code, so neither id needs reading out of the file.
    const sessionId = path.basename(file.file, ".jsonl");
    const shardDirectory = subagent
      ? path.dirname(path.dirname(path.dirname(file.file)))
      : path.dirname(path.dirname(file.file));

    const aggregate: FileAggregate = {
      file: file.file,
      size: file.size,
      mtimeMs: file.mtimeMs,
      provider: geminiCliProvider.name,
      sessionId,
      kind: file.kind,
      project: readProjectRoot(shardDirectory),
      firstTs: "",
      lastTs: "",
      days: {},
      malformedLines: 0,
    };
    if (subagent) {
      aggregate.parentSessionId = path.basename(path.dirname(file.file));
      // `agentType` is deliberately left unset. A subagent transcript records
      // no role of its own; the role lives in the parent's `invoke_agent` call,
      // which a single-transcript parse cannot reach. The spawn counts and
      // names are still exact, because the parent fills `agents` from that same
      // call — this only means `usage agents --by role` has nothing extra to
      // learn from the child. Claude Code has the same gap when a subagent's
      // `.meta.json` is missing.
      aggregate.agentId = sessionId;
    }

    const state: ParseState = {
      aggregate,
      events: [],
      ts: "",
      tokenIds: new Set(),
      pendingTools: new Map(),
    };

    const lines = readline.createInterface({
      input: createReadStream(file.file, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let first = true;
    for await (const line of lines) {
      if (!line) continue;
      let record: RawRecord;
      try {
        record = JSON.parse(line) as RawRecord;
      } catch {
        aggregate.malformedLines += 1;
        continue;
      }
      if (!record || typeof record !== "object") continue;
      if (first) {
        first = false;
        // Not every file has one: at least one transcript in a real corpus
        // begins with an ordinary record, so the header is detected rather
        // than assumed and a file without one parses normally.
        if (isHeader(record)) {
          applyHeader(aggregate, record);
          continue;
        }
      }
      applyRecord(state, record);
    }

    flushTools(state);

    if (!subagent) {
      for (const command of readProjectCommands(shardDirectory).get(aggregate.sessionId) ?? []) {
        const bucket = bucketFor(state, command.ts);
        if (!bucket) continue;
        state.ts = command.ts;
        bucket.commands[command.name] = (bucket.commands[command.name] ?? 0) + 1;
        emit(state, { kind: "command", name: command.name });
      }
    }

    return { aggregate, events: state.events };
  },
};
