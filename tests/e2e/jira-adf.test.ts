import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");

/** The toolset path every case shares: `cairn jira adf <verb>`. */
const GROUP = ["jira", "adf"] as const;
const temporary: string[] = [];
const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(...args: string[]): Promise<Run> {
  try {
    const result = await exec("node", [cli, ...args], { env: { ...process.env, CI: "1" } });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

/**
 * Runs the CLI with `input` on its stdin.
 *
 * Spawned directly rather than through a shell. An earlier version built a
 * `printf ... | node ...` string, which cost an afternoon twice over: `printf
 * '%s'` does not interpret escapes, so multi-line input arrived as one literal
 * line and the frontmatter and list cases silently tested nothing.
 */
async function pipe(input: string, ...args: string[]): Promise<Run> {
  const child = spawn("node", [cli, ...args], { env: { ...process.env, CI: "1" } });
  child.stdin.end(input);
  return collect(child);
}

/**
 * Feeds one CLI invocation's stdout into the next, over a real OS pipe.
 *
 * The pipe is the point: a reader that hits the descriptor before the writer has
 * produced anything is exactly where a naive `readFileSync(0)` throws EAGAIN,
 * and that is the documented `curl | jq | cairn adf` workflow.
 */
async function chain(input: string, ...stages: string[][]): Promise<Run> {
  const children = stages.map((args) =>
    spawn("node", [cli, ...args], { env: { ...process.env, CI: "1" } }),
  );
  for (const [index, child] of children.entries()) {
    const next = children[index + 1];
    if (next) child.stdout.pipe(next.stdin);
  }
  children[0].stdin.end(input);
  return collect(children[children.length - 1]);
}

function collect(child: ReturnType<typeof spawn>): Promise<Run> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adf-e2e-"));
  temporary.push(root);
  return root;
}

function write(root: string, name: string, content: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
}

function validate(id: string, payload: unknown): void {
  const entry = SCHEMA_BY_ID.get(id);
  if (!entry) throw new Error(`no such schema: ${id}`);
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const check = ajv.compile(entry.schema);
  const ok = check(payload);
  if (!ok) throw new Error(`payload failed ${id}: ${JSON.stringify(check.errors?.slice(0, 3))}`);
}

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

const CLEAN = JSON.stringify({
  version: 1,
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "strong" }] }] },
  ],
});

const LOSSY = JSON.stringify({
  version: 1,
  type: "doc",
  content: [
    {
      type: "panel",
      attrs: { panelType: "info" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }],
    },
  ],
});

const WRAPPED = JSON.stringify({ fields: { description: JSON.parse(CLEAN) } });

describe("jira adf to-markdown", () => {
  it("converts a file and exits 0", async () => {
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", CLEAN));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("**hi**\n");
    expect(result.stderr).toBe("");
  });

  it("reads stdin through -", async () => {
    const result = await pipe(CLEAN, ...GROUP, "to-markdown", "-");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("**hi**\n");
  });

  it("puts the document on stdout and diagnostics on stderr", async () => {
    // The whole point of the split: redirecting the document must not capture
    // findings, and this is where every agent subcommand behaves differently.
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", LOSSY));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("> **Info**");
    expect(result.stdout).not.toContain("AD202");
    expect(result.stderr).toContain("AD202");
  });

  it("does not exit 2 for an approximation by default", async () => {
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", LOSSY));
    expect(result.exitCode).toBe(0);
  });

  it("exits 2 for an approximation under --strict", async () => {
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", LOSSY), "--strict");
    expect(result.exitCode).toBe(2);
  });

  it("writes to --output and keeps stdout empty", async () => {
    const root = workspace();
    const out = path.join(root, "out.md");
    const result = await run(
      ...GROUP,
      "to-markdown",
      write(root, "in.json", CLEAN),
      "--output",
      out,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(fs.readFileSync(out, "utf8")).toBe("**hi**\n");
  });

  it("names the field to extract when given a whole issue response", async () => {
    // The likeliest first mistake anyone makes, and the reason there is no
    // --pointer option: the message has to replace the option.
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", WRAPPED));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AD002");
    expect(result.stderr).toContain("fields.description");
    expect(result.stderr).toContain("jq");
  });

  it("reads a pipe whose writer is another cairn process", async () => {
    // Stands in for the documented `curl | jq | cairn jira adf to-markdown -`: what
    // matters is that stdin is a pipe rather than a file, and that the writer
    // has produced nothing at the moment the reader opens it.
    const result = await chain(
      "**hi**\n",
      [...GROUP, "from-markdown", "-"],
      [...GROUP, "to-markdown", "-"],
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("**hi**\n");
  });

  it("reports a missing file as an invocation error", async () => {
    const result = await run(...GROUP, "to-markdown", "/nonexistent/nope.json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AD001");
  });

  it("reports malformed JSON", async () => {
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", "{not json"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AD005");
  });

  it("emits a schema-valid payload under --format json", async () => {
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", LOSSY), "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    validate("adf-result", payload);
    expect(payload.command).toBe("to-markdown");
    expect(payload.markdown).toContain("> **Info**");
    expect(payload.diagnostics[0].code).toBe("AD202");
  });

  it("emits a schema-valid failure payload on stdout under --format json", async () => {
    const root = workspace();
    const result = await run(...GROUP, "to-markdown", write(root, "in.json", WRAPPED), "-fj");
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    validate("adf-result", payload);
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics[0].code).toBe("AD002");
  });
});

describe("jira adf from-markdown", () => {
  it("emits a bare ADF document by default", async () => {
    const result = await pipe("# T\n", ...GROUP, "from-markdown", "-");
    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document.type).toBe("doc");
    // Canonical key order, which is contract.
    expect(Object.keys(document)).toEqual(["version", "type", "content"]);
  });

  it("wraps that document under --format json rather than re-encoding it", async () => {
    const result = await pipe("# T\n", ...GROUP, "from-markdown", "-", "-fj");
    const payload = JSON.parse(result.stdout);
    validate("adf-result", payload);
    expect(payload.command).toBe("from-markdown");
    expect(payload.adf.type).toBe("doc");
  });

  it("reports dropped frontmatter on stderr", async () => {
    const result = await pipe("---\ntitle: T\n---\n\nbody\n", ...GROUP, "from-markdown", "-");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("AD309");
    expect(result.stdout).not.toContain("title: T");
  });

  it("exits 2 under --strict when something degraded", async () => {
    const result = await pipe("- x\n\n  ## H\n", ...GROUP, "from-markdown", "-", "--strict");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("AD300");
  });

  it("round trips through both commands over a pipe", async () => {
    const result = await chain(
      "# T\n\ntext\n",
      [...GROUP, "from-markdown", "-"],
      [...GROUP, "to-markdown", "-"],
    );
    expect(result.stdout).toBe("# T\n\ntext\n");
  });
});

describe("jira adf validate", () => {
  it("accepts a valid document", async () => {
    const root = workspace();
    const result = await run(...GROUP, "validate", write(root, "in.json", CLEAN));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("valid:");
  });

  it("exits 2 and names the illegal nesting", async () => {
    const root = workspace();
    const invalid = JSON.stringify({
      version: 1,
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "x" }] },
              ],
            },
          ],
        },
      ],
    });
    const result = await run(...GROUP, "validate", write(root, "in.json", invalid));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("AD110");
    expect(result.stderr).toContain("heading inside listItem");
  });

  it("catches an empty table cell, which is invalid ADF", async () => {
    const root = workspace();
    const invalid = JSON.stringify({
      version: 1,
      type: "doc",
      content: [
        {
          type: "table",
          content: [{ type: "tableRow", content: [{ type: "tableCell", content: [] }] }],
        },
      ],
    });
    const result = await run(...GROUP, "validate", write(root, "in.json", invalid));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("AD111");
  });

  it("reports an unknown node type without judging it", async () => {
    const root = workspace();
    const unknown = JSON.stringify({
      version: 1,
      type: "doc",
      content: [{ type: "quantumParagraph" }],
    });
    const relaxed = await run(...GROUP, "validate", write(root, "in.json", unknown));
    expect(relaxed.exitCode).toBe(0);
    expect(relaxed.stderr).toContain("AD100");

    const strict = await run(...GROUP, "validate", path.join(root, "in.json"), "--strict");
    expect(strict.exitCode).toBe(2);
  });
});

describe("jira adf inspect", () => {
  it("lists node and mark types with a fidelity rating", async () => {
    const root = workspace();
    const result = await run(...GROUP, "inspect", write(root, "in.json", LOSSY));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("panel");
    expect(result.stdout).toContain("approximate");
  });

  it("emits a schema-valid inventory and never exits 2", async () => {
    const root = workspace();
    const result = await run(...GROUP, "inspect", write(root, "in.json", LOSSY), "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    validate("adf-result", payload);
    expect(payload.inventory.some((entry: { type: string }) => entry.type === "panel")).toBe(true);
  });
});

describe("jira adf contract surface", () => {
  it("wraps every subcommand's payload with --envelope", async () => {
    const root = workspace();
    const file = write(root, "in.json", CLEAN);
    for (const [command, args] of [
      ["to-markdown", [file]],
      ["from-markdown", [write(root, "in.md", "# T\n")]],
      ["validate", [file]],
      ["inspect", [file]],
    ] as Array<[string, string[]]>) {
      const result = await run(...GROUP, command, ...args, "--envelope", "-fj");
      const envelope = JSON.parse(result.stdout);
      validate("envelope", envelope);
      expect(envelope.command).toBe(`jira adf ${command}`);
      expect(envelope.schema).toContain("adf-result.json");
      validate("adf-result", envelope.data);
    }
  });

  it("is described with the four subcommands, all experimental", async () => {
    const result = await run("describe", "-fj");
    const described = JSON.parse(result.stdout) as {
      commands: Array<{ id: string; stability: string; outputSchema: string | null }>;
    };
    const rows = described.commands.filter((command) => command.id.startsWith("jira adf "));
    expect(rows.map((row) => row.id).sort()).toEqual([
      "jira adf from-markdown",
      "jira adf inspect",
      "jira adf to-markdown",
      "jira adf validate",
    ]);
    for (const row of rows) {
      expect(row.stability).toBe("experimental");
      // `describe` reports the schema id; the URI appears in the envelope.
      expect(row.outputSchema).toBe("adf-result");
    }
  });

  it("publishes the adf-result schema through `schema`", async () => {
    const result = await run("schema", "adf-result");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).title).toBe("cairn jira adf result");
  });

  it("rejects an unsupported format", async () => {
    const root = workspace();
    const result = await run(
      ...GROUP,
      "to-markdown",
      write(root, "in.json", CLEAN),
      "--format",
      "sarif",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid output format");
  });
});
