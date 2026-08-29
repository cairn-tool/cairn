import fs from "node:fs";
import path from "node:path";

/**
 * A Gemini CLI log tree, built from a literal description.
 *
 * Unlike the Antigravity fixture, which has to hand-encode protobuf, Gemini's
 * format is named-field JSONL — so this builder stays a thin writer and the
 * interesting content lives in {@link GEMINI_FIXTURE}, where it can be read.
 */

export interface GeminiSessionSpec {
  /** File name within its directory, without the `.jsonl`. */
  name: string;
  /** Containing directory under `chats/`; a subagent's parent session id. */
  parent?: string;
  /** Line 1. `null` writes no header at all, which one real transcript does. */
  header: Record<string, unknown> | null;
  /** A string is written verbatim, which is how a torn line is expressed. */
  records: Array<Record<string, unknown> | string>;
}

export interface GeminiProjectSpec {
  slug: string;
  /** Written to `<slug>/.project_root`; `null` writes none. */
  projectRoot: string | null;
  logs: Array<{ sessionId: string; message: string; timestamp: string }> | null;
  sessions: GeminiSessionSpec[];
}

export function buildGeminiLogs(root: string, projects: readonly GeminiProjectSpec[]): string {
  const tmp = path.join(root, "tmp");
  // The CLI downloads helper binaries beside the projects. Discovery has to
  // skip this, so every fixture carries one.
  fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "bin", "rg"), "#!/bin/sh\n");

  for (const project of projects) {
    const base = path.join(tmp, project.slug);
    fs.mkdirSync(path.join(base, "chats"), { recursive: true });
    if (project.projectRoot !== null) {
      fs.writeFileSync(path.join(base, ".project_root"), project.projectRoot);
    }
    if (project.logs !== null) {
      fs.writeFileSync(path.join(base, "logs.json"), JSON.stringify(project.logs, null, 2));
    }
    for (const session of project.sessions) {
      const directory = session.parent
        ? path.join(base, "chats", session.parent)
        : path.join(base, "chats");
      fs.mkdirSync(directory, { recursive: true });
      const lines: string[] = [];
      if (session.header) lines.push(JSON.stringify(session.header));
      for (const record of session.records) {
        lines.push(typeof record === "string" ? record : JSON.stringify(record));
      }
      fs.writeFileSync(path.join(directory, `${session.name}.jsonl`), lines.join("\n") + "\n");
    }
  }
  return root;
}

const MAIN_SESSION = "aaaa1111-2222-3333-4444-555566667777";

/** Identical on every copy of the repeated record, which is the point. */
const REPEATED_TOKENS = {
  input: 1000,
  output: 50,
  cached: 400,
  thoughts: 20,
  tool: 0,
  total: 1070,
};

const SKILL_CALL = {
  id: "call-skill",
  name: "activate_skill",
  args: { name: "docs-lint" },
  status: "success",
};
const AGENT_CALL = {
  id: "call-agent",
  name: "invoke_agent",
  args: { agent_name: "writer" },
  agentId: "sub001",
  status: "success",
};

export const GEMINI_FIXTURE: readonly GeminiProjectSpec[] = [
  {
    slug: "alpha",
    projectRoot: "/work/alpha",
    logs: [
      { sessionId: MAIN_SESSION, message: "/deploy prod", timestamp: "2026-08-01T10:30:00.000Z" },
      // Not a command: an ordinary typed prompt, which must not be counted.
      { sessionId: MAIN_SESSION, message: "carry on", timestamp: "2026-08-01T10:31:00.000Z" },
      // A different UTC day from every token record, so the command has to open
      // its own bucket on both the aggregate and the folded side.
      {
        sessionId: MAIN_SESSION,
        message: "/deploy staging",
        timestamp: "2026-08-02T09:00:00.000Z",
      },
      // `/clear` keeps a session id in the history after its transcript is
      // gone. There is no aggregate to attach this to and it is dropped.
      { sessionId: "no-such-session", message: "/orphan", timestamp: "2026-08-01T10:32:00.000Z" },
    ],
    sessions: [
      {
        name: "session-2026-08-01T10-00-aaaa1111",
        header: {
          sessionId: MAIN_SESSION,
          projectHash: "0".repeat(64),
          startTime: "2026-08-01T10:00:00.000Z",
          lastUpdated: "2026-08-01T10:20:00.000Z",
          kind: "main",
        },
        records: [
          { $set: { lastUpdated: "2026-08-01T10:01:00.000Z" } },
          // One assistant turn, written three times under one id. The tokens
          // are identical on every copy; the tool list grows. Counting copies
          // triples both figures.
          {
            id: "r1",
            timestamp: "2026-08-01T10:02:00.000Z",
            type: "gemini",
            model: "gemini-3.1-pro-preview",
            tokens: REPEATED_TOKENS,
            toolCalls: [],
          },
          { $set: { summary: "a title, not a context reset" } },
          {
            id: "r1",
            timestamp: "2026-08-01T10:02:00.000Z",
            type: "gemini",
            model: "gemini-3.1-pro-preview",
            tokens: REPEATED_TOKENS,
            toolCalls: [SKILL_CALL],
          },
          {
            id: "r1",
            timestamp: "2026-08-01T10:02:00.000Z",
            type: "gemini",
            model: "gemini-3.1-pro-preview",
            tokens: REPEATED_TOKENS,
            toolCalls: [SKILL_CALL, AGENT_CALL],
          },
          // Fails `total === input + output + thoughts`. It contributes no
          // tokens, and its tool call is still counted.
          {
            id: "r2",
            timestamp: "2026-08-01T10:03:00.000Z",
            type: "gemini",
            model: "gemini-3.1-pro-preview",
            tokens: { input: 10, output: 5, cached: 0, thoughts: 0, tool: 0, total: 999 },
            toolCalls: [{ id: "call-read", name: "read_file", args: {}, status: "error" }],
          },
          { id: "u1", timestamp: "2026-08-01T10:04:00.000Z", type: "user", content: "hello" },
          "{ not json",
        ],
      },
      {
        // No header line at all, which one transcript in a real corpus has.
        name: "session-2026-08-01T12-00-bbbb2222",
        header: null,
        records: [
          {
            id: "r3",
            timestamp: "2026-08-01T12:00:00.000Z",
            type: "gemini",
            model: "gemini-3-flash-preview",
            tokens: { input: 200, output: 10, cached: 0, thoughts: 5, tool: 0, total: 215 },
            toolCalls: [],
          },
        ],
      },
      {
        name: "sub001",
        parent: MAIN_SESSION,
        header: {
          sessionId: "sub001",
          projectHash: "0".repeat(64),
          startTime: "2026-08-01T10:02:30.000Z",
          lastUpdated: "2026-08-01T10:02:45.000Z",
          kind: "subagent",
          directories: ["/work/alpha"],
        },
        records: [
          // The spawn instruction the parent injected. It is not a human turn
          // and must not be counted as a prompt.
          { id: "u2", timestamp: "2026-08-01T10:02:31.000Z", type: "user", content: "write it" },
          {
            id: "r4",
            timestamp: "2026-08-01T10:02:40.000Z",
            type: "gemini",
            model: "gemini-3.1-pro-preview",
            tokens: { input: 500, output: 100, cached: 100, thoughts: 10, tool: 0, total: 610 },
            toolCalls: [{ id: "call-write", name: "write_file", args: {}, status: "success" }],
          },
        ],
      },
    ],
  },
];
