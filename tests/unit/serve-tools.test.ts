import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../../src/config.js";
import { initializeRuntime, resetRuntime } from "../../src/runtime.js";
import { SERVE_TOOLS, TOOL_BY_NAME, type ServeContext } from "../../src/serve/tools.js";
import { callTool, compileValidators, toolManifest } from "../../src/serve/server.js";
import { confine, PathRejected, resolveRoot } from "../../src/serve/paths.js";
import { scrub } from "../../src/serve/errors.js";

let tmpDir: string;
let root: string;
let context: ServeContext;
const validators = compileValidators();

function write(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Runs a tool and returns its parsed payload, failing if it reported an error. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await callTool(name, args, context, validators);
  const text = (result.content as [{ text: string }])[0].text;
  if (result.isError) throw new Error(`tool reported: ${text}`);
  return JSON.parse(text);
}

/** Runs a tool expected to fail, returning the scrubbed message. */
async function failure(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await callTool(name, args, context, validators);
  expect(result.isError, `${name} was expected to fail`).toBe(true);
  return (result.content as [{ text: string }])[0].text;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-tools-"));
  write(
    "index.md",
    [
      "---",
      "title: Index",
      "status: published",
      "owner: docs",
      "---",
      "",
      "# Index",
      "",
      "See [guide](guide.md) and [missing](nope.md).",
      "",
      "## Tasks",
      "",
      "- [x] Done thing",
      "- [ ] Pending thing",
      "",
      "## Code",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
    ].join("\n"),
  );
  write(
    "guide.md",
    ["# Guide", "", "Back to [index](index.md).", "", "## Details", "", "Body text.", ""].join(
      "\n",
    ),
  );
  write("nested/deep.md", ["# Deep", "", "Links to [guide](../guide.md).", ""].join("\n"));

  // Resolved through symlinks so macOS's /tmp -> /private/tmp does not read as
  // an escape from the served root.
  root = resolveRoot(tmpDir);
  const config = loadConfig({ disabled: true }, root);
  const { workspace } = initializeRuntime(config, { persistIndex: false, maxDocuments: 64 });
  context = { workspace, config, root, concurrency: 2 };
});

afterEach(() => {
  resetRuntime();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tool manifest", () => {
  it("advertises every tool with a usable object schema", () => {
    const manifest = toolManifest();
    expect(manifest).toHaveLength(SERVE_TOOLS.length);
    for (const tool of manifest) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
      // Compiled at startup, so a malformed schema fails the server rather than
      // a request.
      expect(validators.get(tool.name), tool.name).toBeTruthy();
    }
  });

  it("names each tool exactly once", () => {
    expect(TOOL_BY_NAME.size).toBe(SERVE_TOOLS.length);
  });

  // SERVE_TOOLS is a hand-written table with nothing stopping an addition, and
  // `scripts run` executes arbitrary commands. Exposing it over MCP would hand a
  // host process execution through a server documented as read-only.
  it("exposes no tool that runs a script", () => {
    const executing = SERVE_TOOLS.filter((tool) =>
      /scripts?[_-]?run|run[_-]?scripts?/.test(tool.name),
    );
    expect(executing.map((tool) => tool.name)).toEqual([]);
  });
});

describe("read-only guarantee", () => {
  it("leaves the workspace byte-identical after exercising every tool", async () => {
    const before = fs
      .readdirSync(tmpDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return `${path.relative(tmpDir, file)}:${fs.readFileSync(file, "utf-8")}`;
      })
      .sort();

    await call("list_documents");
    await call("get_section", { file: "guide.md", heading: "Details" });
    await call("query_workspace", { kind: "documents" });
    await call("build_context", { seeds: ["index.md"] });
    await call("inspect_graph");
    await call("audit_markdown");
    await call("get_outline", { file: "index.md" });
    await call("get_frontmatter", { file: "index.md" });
    await call("list_tasks", { file: "index.md" });
    await call("list_code_blocks", { file: "index.md" });
    await call("find_references", { file: "guide.md" });

    const after = fs
      .readdirSync(tmpDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return `${path.relative(tmpDir, file)}:${fs.readFileSync(file, "utf-8")}`;
      })
      .sort();

    expect(after).toEqual(before);
  });
});

describe("path confinement", () => {
  it("rejects a traversal above the root", () => {
    expect(() => confine(root, "../escape.md")).toThrow(PathRejected);
    expect(() => confine(root, "nested/../../escape.md")).toThrow(PathRejected);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => confine(root, "/etc/passwd")).toThrow(PathRejected);
  });

  it("accepts paths at and below the root", () => {
    expect(confine(root, ".")).toBe(root);
    expect(confine(root, "guide.md")).toBe(path.join(root, "guide.md"));
    expect(confine(root, "nested/deep.md")).toBe(path.join(root, "nested", "deep.md"));
  });

  it("rejects a symlink that escapes the root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "serve-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n");
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(tmpDir, "link.md"));
      // Lexically this sits inside the root; only resolving it reveals otherwise.
      expect(() => confine(root, "link.md")).toThrow(PathRejected);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps an escaping symlink out of the document listing", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "serve-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n");
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(tmpDir, "link.md"));
      const listed = (await call("list_documents")) as { files: string[] };
      expect(listed.files).not.toContain("link.md");
      expect(listed.files).toContain("guide.md");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a path of "-" rather than reading the protocol channel', async () => {
    // On a stdio server fd 0 is the JSON-RPC stream; reading it would deadlock.
    expect(() => confine(root, "-")).toThrow(PathRejected);
    expect(await failure("get_outline", { file: "-" })).toContain('"-" is not available');
  });

  it("never echoes an absolute path back to the client", async () => {
    for (const attempt of ["/etc/passwd", "../../secret.md"]) {
      const message = await failure("get_section", { file: attempt, heading: "x" });
      expect(message).not.toContain("/etc");
      expect(message).not.toContain(tmpDir);
      expect(message).not.toContain(root);
    }
  });
});

describe("scrub", () => {
  it("makes in-root paths relative and redacts the rest", () => {
    expect(scrub(`File not found: ${root}/guide.md`, root)).toBe("File not found: guide.md");
    expect(scrub(`Denied: /etc/passwd`, root)).toBe("Denied: <path outside root>");
  });

  it("leaves a message with no paths alone", () => {
    expect(scrub("Heading not found: Details", root)).toBe("Heading not found: Details");
  });
});

describe("argument validation", () => {
  it("raises a protocol error for an unknown tool", async () => {
    await expect(callTool("nope", {}, context, validators)).rejects.toBeInstanceOf(McpError);
  });

  it("raises a protocol error for a missing required argument", async () => {
    await expect(callTool("get_outline", {}, context, validators)).rejects.toBeInstanceOf(McpError);
  });

  it("raises a protocol error for an out-of-range or unknown enum value", async () => {
    await expect(
      callTool("get_outline", { file: "index.md", maxDepth: 99 }, context, validators),
    ).rejects.toBeInstanceOf(McpError);
    await expect(
      callTool("query_workspace", { kind: "not-an-entity" }, context, validators),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("reports a workspace failure as tool content, not a protocol error", async () => {
    // The model can correct these; a JSON-RPC error would read as a client bug.
    expect(await failure("get_section", { file: "guide.md", heading: "Nope" })).toContain(
      "Heading not found",
    );
    expect(await failure("get_outline", { file: "absent.md" })).toContain("File not found");
  });
});

describe("tools", () => {
  it("lists documents relative to the root", async () => {
    const result = (await call("list_documents")) as { count: number; files: string[] };
    expect(result.files).toEqual(["guide.md", "index.md", "nested/deep.md"]);
    expect(result.count).toBe(3);
  });

  it("lists documents under a subdirectory", async () => {
    const result = (await call("list_documents", { directory: "nested" })) as { files: string[] };
    expect(result.files).toEqual(["nested/deep.md"]);
  });

  it("extracts a section with its line range", async () => {
    const result = (await call("get_section", { file: "guide.md", heading: "Details" })) as {
      heading: string;
      slug: string;
      content: string;
      startLine: number;
    };
    expect(result.heading).toBe("Details");
    expect(result.slug).toBe("details");
    expect(result.content).toContain("Body text.");
    expect(result.startLine).toBe(5);
  });

  it("queries documents with a frontmatter predicate", async () => {
    const result = (await call("query_workspace", {
      kind: "documents",
      where: ["frontmatter.status=published"],
      select: ["file"],
    })) as { results: { file: string }[]; count: number; fields: string[] };
    expect(result.count).toBe(1);
    expect(result.fields).toEqual(["file"]);
    expect(result.results[0].file).toBe("index.md");
  });

  it("emits the same query envelope md query does, grouping included", async () => {
    const grouped = (await call("query_workspace", {
      kind: "documents",
      select: ["file"],
      groupBy: "file",
    })) as Record<string, unknown>;
    // `summary` appears only when grouping, exactly as the command does it.
    expect(Object.keys(grouped)).toEqual([
      "kind",
      "directory",
      "count",
      "results",
      "fields",
      "groupBy",
      "summary",
    ]);
    expect(grouped.summary).toMatchObject({ matched: 3, groups: 3 });

    const flat = (await call("query_workspace", { kind: "documents" })) as Record<string, unknown>;
    expect(Object.keys(flat)).toEqual(["kind", "directory", "count", "results", "fields"]);
  });

  it("builds a context pack that traverses to a linked document", async () => {
    const pack = (await call("build_context", { seeds: ["index.md"], depth: 1 })) as {
      files: string[];
      totals: { files: number };
      broken: { target: string }[];
    };
    expect(pack.files).toContain("index.md");
    expect(pack.files).toContain("guide.md");
    expect(pack.broken.map((edge) => edge.target)).toContain("nope.md");
  });

  it("honors a context budget by truncating rather than reordering", async () => {
    const pack = (await call("build_context", {
      seeds: ["index.md"],
      depth: 1,
      budgetBytes: 40,
    })) as { budget: { truncated: boolean; limitBytes: number }; omitted: unknown[] };
    expect(pack.budget.limitBytes).toBe(40);
    expect(pack.budget.truncated).toBe(true);
    expect(pack.omitted.length).toBeGreaterThan(0);
  });

  it("reports the reference graph including broken targets", async () => {
    const graph = (await call("inspect_graph")) as {
      files: number;
      broken: { source: string; target: string }[];
      edges: { source: string; target: string }[];
    };
    expect(graph.files).toBe(3);
    expect(graph.broken).toHaveLength(1);
    expect(graph.broken[0]).toMatchObject({ source: "index.md", target: "nope.md" });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: "index.md", target: "guide.md" }),
    );
  });

  it("audits documents and finds the broken reference", async () => {
    const audit = (await call("audit_markdown", { references: true })) as {
      checked: number;
      issues: { file: string; message: string }[];
    };
    expect(audit.checked).toBe(3);
    expect(audit.issues.some((issue) => issue.file === "index.md")).toBe(true);
    // Paths in findings are root-relative like every other payload.
    for (const issue of audit.issues) expect(path.isAbsolute(issue.file)).toBe(false);
  });

  it("returns a nested outline honoring maxDepth", async () => {
    const full = (await call("get_outline", { file: "guide.md" })) as {
      outline: { text: string; children: { text: string }[] }[];
    };
    expect(full.outline).toHaveLength(1);
    expect(full.outline[0].text).toBe("Guide");
    expect(full.outline[0].children.map((child) => child.text)).toEqual(["Details"]);

    const shallow = (await call("get_outline", { file: "guide.md", maxDepth: 1 })) as {
      outline: { children: unknown[] }[];
    };
    expect(shallow.outline[0].children).toHaveLength(0);
  });

  it("reproduces md outline's treatment of frontmatter", async () => {
    // The tool and the command share one parser, so they cannot disagree — which
    // is the property worth pinning. Both now skip the frontmatter block; before
    // the parser became frontmatter-aware both reported it as a setext h2 whose
    // text was the raw YAML.
    const result = (await call("get_outline", { file: "index.md" })) as {
      outline: { text: string; depth: number }[];
    };
    expect(result.outline.map((node) => node.depth)).toEqual([1]);
    expect(result.outline[0].text).toBe("Index");
  });

  it("reads frontmatter whole and by key", async () => {
    const whole = (await call("get_frontmatter", { file: "index.md" })) as {
      frontmatter: Record<string, unknown>;
    };
    expect(whole.frontmatter).toMatchObject({ title: "Index", status: "published" });

    const single = (await call("get_frontmatter", { file: "index.md", key: "owner" })) as {
      value: unknown;
    };
    expect(single.value).toBe("docs");

    expect(await failure("get_frontmatter", { file: "index.md", key: "absent" })).toContain(
      "Key not found",
    );
  });

  it("reports a document with no frontmatter without failing", async () => {
    const result = (await call("get_frontmatter", { file: "guide.md" })) as {
      status: string;
      frontmatter: unknown;
    };
    expect(result.status).toBe("missing");
    expect(result.frontmatter).toBeNull();
  });

  it("lists tasks and filters by status", async () => {
    const all = (await call("list_tasks", { file: "index.md" })) as { total: number };
    expect(all).toMatchObject({ total: 2, done: 1, pending: 1 });

    const pending = (await call("list_tasks", { file: "index.md", status: "pending" })) as {
      tasks: { text: string }[];
    };
    expect(pending.tasks).toHaveLength(1);
    expect(pending.tasks[0].text).toBe("Pending thing");
  });

  it("lists code blocks, with contents only when asked", async () => {
    const without = (await call("list_code_blocks", { file: "index.md" })) as {
      blocks: Record<string, unknown>[];
    };
    expect(without.blocks).toHaveLength(1);
    expect(without.blocks[0]).toMatchObject({ lang: "ts" });
    expect(without.blocks[0].content).toBeUndefined();

    const withContent = (await call("list_code_blocks", {
      file: "index.md",
      content: true,
      lang: "ts",
    })) as { blocks: { content: string }[] };
    expect(withContent.blocks[0].content).toBe("const x = 1;");
  });

  it("finds inbound references to a document", async () => {
    const result = (await call("find_references", { file: "guide.md" })) as {
      count: number;
      references: { sourceFile: string; line: number }[];
    };
    expect(result.count).toBe(2);
    expect(result.references.map((reference) => reference.sourceFile).sort()).toEqual([
      "index.md",
      "nested/deep.md",
    ]);
    for (const reference of result.references) {
      expect(path.isAbsolute(reference.sourceFile)).toBe(false);
    }
  });
});
