import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Builds an Antigravity log root.
 *
 * The SQLite half of Antigravity's store is protobuf with no published schema,
 * so the fixture is *generated* from the same field numbers the provider reads
 * rather than committed as an opaque binary. That way the shape a test asserts
 * against is visible in source, and changing the provider's field numbers
 * without changing these fails loudly.
 */

/** Encodes a varint. */
function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function tag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire);
}

/** A varint-typed field. */
export function pbInt(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

/** A length-delimited field: a string or a nested message. */
export function pbBytes(field: number, value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

export function pbMessage(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

/** A `google.protobuf.Timestamp`. */
export function pbTimestamp(field: number, iso: string): Buffer {
  const millis = Date.parse(iso);
  return pbBytes(
    field,
    pbMessage(pbInt(1, Math.floor(millis / 1000)), pbInt(2, (millis % 1000) * 1_000_000)),
  );
}

export interface UsageSpec {
  at: string;
  prompt: number;
  thinking: number;
  output: number;
  /** Breaks the `completion == thinking + output` guard on purpose. */
  corruptCompletion?: boolean;
}

export interface ConversationSpec {
  id: string;
  workspace: string;
  branch?: string;
  title?: string;
  agent?: string;
  parent?: string;
  model?: string;
  usage: UsageSpec[];
  /** Records for `brain/<id>/.system_generated/logs/transcript.jsonl`. */
  transcript: Array<Record<string, unknown> | string>;
}

/** The usage message the provider reads, at step body field 9. */
function usageMessage(spec: UsageSpec): Buffer {
  const completion = spec.corruptCompletion
    ? spec.thinking + spec.output + 1
    : spec.thinking + spec.output;
  return pbMessage(
    pbInt(1, 1016),
    pbInt(2, 500),
    pbInt(3, completion),
    pbInt(5, spec.prompt),
    pbInt(9, spec.thinking),
    pbInt(10, spec.output),
  );
}

function stepPayload(spec: UsageSpec): Buffer {
  return pbBytes(5, pbMessage(pbTimestamp(1, spec.at), pbBytes(9, usageMessage(spec))));
}

function metadataBlob(spec: ConversationSpec): Buffer {
  const workspace = pbMessage(
    pbBytes(1, `file://${spec.workspace}`),
    pbBytes(2, `file://${spec.workspace}`),
    pbBytes(4, spec.branch ?? "main"),
  );
  const parts = [
    pbBytes(1, workspace),
    pbTimestamp(2, spec.usage[0]?.at ?? "2026-08-01T00:00:00Z"),
  ];
  if (spec.agent) parts.push(pbBytes(4, pbMessage(pbBytes(1, spec.agent))));
  if (spec.parent) parts.push(pbBytes(5, spec.parent));
  if (spec.agent || spec.title) {
    parts.push(pbBytes(8, pbMessage(pbBytes(1, spec.agent ?? ""), pbBytes(2, spec.title ?? ""))));
  }
  return pbMessage(...parts);
}

export function buildAntigravityLogs(root: string, conversations: ConversationSpec[]): string {
  const require = createRequire(import.meta.url);
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...values: unknown[]): void };
      close(): void;
    };
  };
  process.emitWarning = emit;

  fs.mkdirSync(path.join(root, "conversations"), { recursive: true });
  const history: string[] = [];

  for (const spec of conversations) {
    const db = new DatabaseSync(path.join(root, "conversations", `${spec.id}.db`));
    db.exec(
      "CREATE TABLE steps (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, `step_payload` blob, PRIMARY KEY (`idx`));" +
        "CREATE TABLE gen_metadata (`idx` integer, `data` blob, PRIMARY KEY (`idx`));" +
        'CREATE TABLE trajectory_metadata_blob (`id` text DEFAULT "main", `data` blob, PRIMARY KEY (`id`));',
    );
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run(
      "main",
      metadataBlob(spec),
    );
    // The generation record, read only for the model strings.
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(
      0,
      pbBytes(1, pbMessage(pbBytes(19, spec.model ?? "gemini-pro-default"))),
    );
    spec.usage.forEach((usage, index) => {
      db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(
        index,
        15,
        stepPayload(usage),
      );
    });
    // A non-generation step, which must contribute no tokens.
    db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(
      spec.usage.length,
      5,
      Buffer.alloc(0),
    );
    db.close();

    const logs = path.join(root, "brain", spec.id, ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "transcript.jsonl"),
      spec.transcript
        .map((record) => (typeof record === "string" ? record : JSON.stringify(record)))
        .join("\n") + "\n",
    );
    history.push(
      JSON.stringify({
        display: "/skills",
        timestamp: Date.parse(spec.usage[0]?.at ?? "2026-08-01T00:00:00Z"),
        workspace: spec.workspace,
        conversationId: spec.id,
        type: "slash_command",
      }),
    );
  }

  fs.writeFileSync(path.join(root, "history.jsonl"), history.join("\n") + "\n");
  return root;
}

/** The corpus every suite shares: one parent and one subagent trajectory. */
export const ANTIGRAVITY_FIXTURE: ConversationSpec[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    workspace: "/tmp/agproj",
    branch: "main",
    title: "Parent run",
    usage: [
      { at: "2026-08-01T10:00:00Z", prompt: 1000, thinking: 40, output: 60 },
      { at: "2026-08-02T10:00:00Z", prompt: 900, thinking: 10, output: 20 },
    ],
    transcript: [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-08-01T10:00:00Z",
        content: "do the thing",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-08-01T10:00:01Z",
        thinking: "considering",
        tool_calls: [{ name: "write_to_file", args: { TargetFile: '"/tmp/agproj/x.md"' } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-08-01T10:00:02Z",
        tool_calls: [{ name: "invoke_subagent", args: {} }],
      },
      {
        step_index: 3,
        source: "SYSTEM",
        type: "ERROR_MESSAGE",
        status: "DONE",
        created_at: "2026-08-01T10:00:03Z",
        error: "model output error",
      },
      {
        step_index: 4,
        source: "SYSTEM",
        type: "CHECKPOINT",
        status: "DONE",
        created_at: "2026-08-02T10:00:00Z",
        content: "{{ CHECKPOINT 0 }}",
      },
      // About one line in a thousand is torn by an interleaved append.
      '{"step_indexcontent": torn',
    ],
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    workspace: "/tmp/agproj",
    agent: "docs-generate-writer",
    title: "Writer",
    parent: "11111111-1111-1111-1111-111111111111",
    usage: [{ at: "2026-08-01T11:00:00Z", prompt: 500, thinking: 5, output: 15 }],
    transcript: [
      {
        step_index: 0,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-08-01T11:00:00Z",
        tool_calls: [{ name: "send_message", args: {} }],
      },
    ],
  },
];
