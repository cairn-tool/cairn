import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporary: string[] = [];

interface Frame {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Session {
  frames: Frame[];
  stderr: string;
  exitCode: number;
}

/**
 * Drives a real server over stdio and collects its replies.
 *
 * The handshake is mandatory — the SDK rejects requests that arrive before
 * `notifications/initialized`. The child is killed in a `finally` so a server
 * that fails to exit cannot leak across the rest of the suite.
 */
async function session(args: string[], requests: unknown[]): Promise<Session> {
  const child = spawn("node", [cli, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
  });
  try {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));

    const handshake = [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    const lines = [...handshake, ...requests].map((frame) => JSON.stringify(frame)).join("\n");
    child.stdin.write(`${lines}\n`);
    child.stdin.end();

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 0));
    });

    return {
      frames: stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Frame),
      stderr,
      exitCode,
    };
  } finally {
    child.kill("SIGTERM");
  }
}

/** A request frame for one tool call. */
function toolCall(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function payloadOf(frame: Frame | undefined): unknown {
  const content = (frame?.result as { content?: [{ text: string }] } | undefined)?.content;
  if (!content) throw new Error(`frame carried no content: ${JSON.stringify(frame)}`);
  return JSON.parse(content[0].text);
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-e2e-"));
  temporary.push(root);
  fs.writeFileSync(
    path.join(root, "index.md"),
    ["# Index", "", "See [guide](guide.md) and [gone](missing.md).", ""].join("\n"),
  );
  fs.writeFileSync(path.join(root, "guide.md"), ["# Guide", "", "Body.", ""].join("\n"));
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("serve mcp", () => {
  it("completes the handshake and advertises every tool", async () => {
    const root = workspace();
    const { frames, exitCode } = await session(
      ["serve", "mcp", "--root", root],
      [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }],
    );

    expect(exitCode).toBe(0);
    const initialize = frames.find((frame) => frame.id === 0);
    expect(initialize?.result?.protocolVersion).toBeTruthy();
    expect(initialize?.result?.capabilities).toHaveProperty("tools");

    const tools = (frames.find((frame) => frame.id === 1)?.result as { tools: { name: string }[] })
      .tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "audit_markdown",
      "build_context",
      "convert_pdf_to_markdown",
      "find_references",
      "get_frontmatter",
      "get_outline",
      "get_pdf_outline",
      "get_section",
      "inspect_graph",
      "inspect_pdf",
      "list_code_blocks",
      "list_documents",
      "list_pdf_attachments",
      "list_pdf_form_fields",
      "list_tasks",
      "query_workspace",
      "read_pdf_text",
    ]);
  });

  it("answers a tool call and exits cleanly when the client disconnects", async () => {
    const root = workspace();
    const { frames, exitCode } = await session(
      ["serve", "mcp", "--root", root],
      [
        toolCall(1, "list_documents"),
        toolCall(2, "get_section", { file: "guide.md", heading: "Guide" }),
      ],
    );

    expect(exitCode).toBe(0);
    // Every request is answered: shutdown drains in-flight calls rather than
    // dropping them when stdin reaches EOF.
    expect(frames.filter((frame) => frame.id !== undefined && frame.id > 0)).toHaveLength(2);

    expect(payloadOf(frames.find((frame) => frame.id === 1))).toMatchObject({
      directory: ".",
      count: 2,
      files: ["guide.md", "index.md"],
    });
    expect(payloadOf(frames.find((frame) => frame.id === 2))).toMatchObject({
      file: "guide.md",
      heading: "Guide",
    });
  });

  it("agrees with the equivalent md command over the same workspace", async () => {
    const root = workspace();
    const { stdout } = await exec(
      "node",
      [cli, "md", "graph", root, "-fj", "--paths", "relative"],
      {
        env: { ...process.env, CI: "1" },
      },
    ).catch((error: { stdout?: string; stderr?: string }) => ({
      // `md graph` exits 2 on a broken target and routes the payload to stderr.
      stdout: error.stdout || error.stderr || "",
    }));
    const command = JSON.parse(stdout) as { files: number; broken: { target: string }[] };

    const { frames } = await session(
      ["serve", "mcp", "--root", root],
      [toolCall(1, "inspect_graph")],
    );
    const tool = payloadOf(frames.find((frame) => frame.id === 1)) as {
      files: number;
      broken: { target: string }[];
    };

    expect(tool.files).toBe(command.files);
    expect(tool.broken.map((edge) => edge.target)).toEqual(
      command.broken.map((edge) => edge.target),
    );
  });

  it("confines paths to the root without disclosing them", async () => {
    const root = workspace();
    const { frames } = await session(
      ["serve", "mcp", "--root", root],
      [
        toolCall(1, "get_section", { file: "../escape.md", heading: "x" }),
        toolCall(2, "get_section", { file: "/etc/passwd", heading: "x" }),
      ],
    );

    for (const id of [1, 2]) {
      const frame = frames.find((candidate) => candidate.id === id);
      expect(frame?.result?.isError, `call ${id} should be an error`).toBe(true);
      const text = (frame?.result as { content: [{ text: string }] }).content[0].text;
      expect(text).toContain("outside the served root");
      expect(text).not.toContain("/etc");
      expect(text).not.toContain(root);
    }
  });

  it("rejects an unknown tool as a protocol error", async () => {
    const root = workspace();
    const { frames } = await session(
      ["serve", "mcp", "--root", root],
      [toolCall(1, "no_such_tool")],
    );
    const frame = frames.find((candidate) => candidate.id === 1);
    expect(frame?.error?.code).toBe(-32602);
    expect(frame?.error?.message).toContain("Unknown tool");
  });

  it("keeps stdout free of anything but JSON-RPC frames", async () => {
    const root = workspace();
    const { frames } = await session(
      ["serve", "mcp", "--root", root],
      [toolCall(1, "list_documents")],
    );
    // Parsing every line already proves it; assert the shape too, since a stray
    // write to stdout would corrupt a real client's parse.
    for (const frame of frames) expect(frame).toHaveProperty("id");
  });

  it("exits 1 on an unknown protocol and on an unreadable root", async () => {
    const unknown = await session(["serve", "tcp"], []);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown protocol");

    const missing = await session(
      ["serve", "mcp", "--root", path.join(os.tmpdir(), "absent-xyz")],
      [],
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Root directory not found");
  });

  it("is declared in describe and reports no output format", async () => {
    const { stdout } = await exec("node", [cli, "describe", "serve", "-fj"], {
      env: { ...process.env, CI: "1" },
    });
    const described = JSON.parse(stdout) as {
      commands: { id: string; stability: string; formats: unknown; writes: boolean }[];
    };
    const serve = described.commands.find((command) => command.id === "serve");
    expect(serve).toBeTruthy();
    expect(serve?.stability).toBe("experimental");
    expect(serve?.writes).toBe(false);
    // stdout is the JSON-RPC channel, so there is no format to select.
    expect(serve?.formats).toBeNull();
  });
});
