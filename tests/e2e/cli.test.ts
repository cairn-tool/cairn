import { describe, it, expect } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "..", "..", "dist", "cli.js");
const fixturesDir = path.join(__dirname, "..", "fixtures");

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await exec("node", [cliPath, ...args]);
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.code };
  }
}

async function runCliIn(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await exec("node", [cliPath, ...args], { cwd });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.code };
  }
}

async function runCliInWithWorkspaceCache(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(cwd, ".test-cache"),
    XDG_DATA_HOME: path.join(cwd, ".test-data"),
  };
  try {
    const { stdout, stderr } = await exec("node", [cliPath, ...args], { cwd, env });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.code };
  }
}

describe("CLI e2e", () => {
  it("shows help with no arguments", async () => {
    const { stdout, exitCode } = await runCli("help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cairn");
    expect(stdout).toContain("md");
  });

  it("reports a version from package.json", async () => {
    const { stdout, exitCode } = await runCli("--version");
    expect(exitCode).toBe(0);
    // semantic-release owns this value; pre-release it is 0.0.0-development
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("lists check-update in help but hides the internal refresh command", async () => {
    const { stdout, exitCode } = await runCli("help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("check-update");
    expect(stdout).not.toContain("__refresh-update-cache");
  });

  it("documents check-update exit codes", async () => {
    const { stdout, exitCode } = await runCli("check-update", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("newer version");
    expect(stdout).toContain("--format");
  });

  // The notifier writes to stderr, which for `md lint` carries the issue payload
  // (JSON included). A notice leaking into a non-interactive run would corrupt it.
  it("never emits an update notice when stdio is not a TTY", async () => {
    const { stderr, stdout } = await runCli(
      "md",
      "lint",
      path.join(fixturesDir, "broken-katex.md"),
    );
    expect(stderr).not.toContain("Update available");
    expect(stdout).not.toContain("Update available");
  });

  it("shows md lint help with --help", async () => {
    const { stdout, exitCode } = await runCli("md", "lint", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Run all checks on a single markdown file");
    expect(stdout).toContain("--format");
  });

  it("exits 0 for clean file", async () => {
    const { exitCode, stdout } = await runCli("md", "lint", path.join(fixturesDir, "clean.md"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No issues found");
  });

  it("exits 2 for file with errors", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "lint",
      path.join(fixturesDir, "broken-katex.md"),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("katex");
  });

  it("outputs valid JSON with --format=json", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "lint",
      path.join(fixturesDir, "broken-katex.md"),
      "--format=json",
    );
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stderr);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("file");
    expect(parsed[0]).toHaveProperty("line");
    expect(parsed[0]).toHaveProperty("checker");
    expect(parsed[0]).toHaveProperty("message");
  });

  it("outputs ANSI with -fh shorthand", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "lint",
      path.join(fixturesDir, "broken-katex.md"),
      "-fh",
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("\x1b[");
  });

  it("lint-dir aggregates issues across files", async () => {
    const { exitCode, stderr } = await runCli("md", "lint-dir", fixturesDir);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("total issue(s) across");
  });

  it("lint-dir --summary shows one line per file", async () => {
    const { exitCode, stderr } = await runCli("md", "lint-dir", fixturesDir, "--summary");
    expect(exitCode).toBe(2);
    // Should contain pass/fail markers and file paths
    expect(stderr).toContain("✖");
    expect(stderr).toContain("issue(s)");
    expect(stderr).toContain("passed");
    expect(stderr).toContain("failed");
  });

  it("lint-dir --summary outputs valid JSON", async () => {
    const { exitCode, stderr } = await runCli("md", "lint-dir", fixturesDir, "--summary", "-fj");
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stderr);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("file");
    expect(parsed[0]).toHaveProperty("issues");
    expect(parsed[0]).toHaveProperty("ok");
  });

  it("lint-dir --summary exits 0 for clean directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-summary-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "clean.md"), "# Clean\n\nNo issues here.\n");
      const { exitCode, stdout } = await runCli("md", "lint-dir", tmpDir, "--summary");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("✔");
      expect(stdout).toContain("1 file(s)");
      expect(stdout).toContain("0 total issue(s)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lint-dir exits 0 with no-files message for empty dir", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-"));
    try {
      const { exitCode, stdout } = await runCli("md", "lint-dir", emptyDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("No .md files found");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("lint-dir accepts GitHub anchors for headings containing inline code", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-code-anchor-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "README.md"),
        "# Index\n\n[Jump](#the-foo-trait)\n\n### The `Foo` trait\n",
      );
      const { exitCode, stdout } = await runCli("md", "lint-dir", tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("No issues found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 1 for unknown command", async () => {
    const { exitCode, stderr } = await runCli("unknown-cmd");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });

  // md refs tests
  it("refs lists references from a file", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "refs",
      path.join(fixturesDir, "refs-source.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("refs-to-target.md");
    expect(stdout).toContain("[exists]");
  });

  it("refs exits 2 when references are missing", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "refs",
      path.join(fixturesDir, "broken-refs.md"),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("MISSING");
  });

  it("refs includes external URLs with --external flag", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "refs",
      path.join(fixturesDir, "refs-source.md"),
      "--external",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("https://example.com");
  });

  it("refs includes anchors with --anchors flag", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "refs",
      path.join(fixturesDir, "refs-source.md"),
      "--anchors",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("#refs-source");
  });

  it("refs outputs valid JSON with --format=json", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "refs",
      path.join(fixturesDir, "refs-source.md"),
      "--format=json",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("target");
    expect(parsed[0]).toHaveProperty("exists");
  });

  // md refs-to tests
  it("refs-to finds references to a target file", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "refs-to",
      path.join(fixturesDir, "refs-to-target.md"),
      fixturesDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("refs-source.md");
    expect(stdout).toContain("reference(s) to");
  });

  it("refs-to reports no references for unreferenced file", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "refs-to",
      path.join(fixturesDir, "broken-mermaid.md"),
      fixturesDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No references found");
  });

  it("refs-to outputs valid JSON with --format=json", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "refs-to",
      path.join(fixturesDir, "refs-to-target.md"),
      fixturesDir,
      "--format=json",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("sourceFile");
    expect(parsed[0]).toHaveProperty("line");
  });

  // md headers tests
  it("headers extracts headings with line numbers", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "headers",
      path.join(fixturesDir, "valid-all-features.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("heading(s)");
    expect(stdout).toContain("# Valid All Features");
    expect(stdout).toContain("## Math");
  });

  it("headers respects --max-depth", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "headers",
      path.join(fixturesDir, "valid-all-features.md"),
      "--max-depth",
      "1",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("1 heading(s)");
    expect(stdout).toContain("# Valid All Features");
    expect(stdout).not.toContain("## Math");
  });

  it("headers outputs valid JSON with --format=json", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "headers",
      path.join(fixturesDir, "valid-all-features.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("depth");
    expect(parsed[0]).toHaveProperty("text");
    expect(parsed[0]).toHaveProperty("slug");
    expect(parsed[0]).toHaveProperty("line");
  });

  // md outline tests
  it("outline shows indented heading tree", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "outline",
      path.join(fixturesDir, "valid-all-features.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Valid All Features");
    expect(stdout).toContain("  Math");
  });

  it("outline outputs nested JSON tree", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "outline",
      path.join(fixturesDir, "valid-all-features.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("children");
    expect(parsed[0].children.length).toBeGreaterThan(0);
  });

  // md toc tests
  it("toc generates markdown table of contents", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "toc",
      path.join(fixturesDir, "valid-all-features.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("- [Valid All Features](#valid-all-features)");
    expect(stdout).toContain("  - [Math](#math)");
  });

  it("toc respects --min-depth and --ordered", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "toc",
      path.join(fixturesDir, "valid-all-features.md"),
      "--min-depth",
      "2",
      "--ordered",
    );
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Valid All Features");
    expect(stdout).toContain("1. [Math](#math)");
  });

  it("toc includes inline code in heading labels and anchors", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-code-toc-"));
    try {
      const file = path.join(tmpDir, "README.md");
      fs.writeFileSync(file, "# The `Foo` trait\n");
      const { exitCode, stdout } = await runCli("md", "toc", file);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("- [The Foo trait](#the-foo-trait)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // md stats tests
  it("stats shows document statistics", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "stats",
      path.join(fixturesDir, "valid-all-features.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Words:");
    expect(stdout).toContain("Headings:");
    expect(stdout).toContain("Links:");
    expect(stdout).toContain("Code blocks:");
  });

  it("stats outputs valid JSON", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "stats",
      path.join(fixturesDir, "valid-all-features.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("wordCount");
    expect(parsed).toHaveProperty("headings");
    expect(parsed).toHaveProperty("links");
    expect(parsed).toHaveProperty("codeBlocks");
  });

  // md code-blocks tests
  it("code-blocks lists code blocks", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "code-blocks",
      path.join(fixturesDir, "valid-all-features.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("code block(s)");
    expect(stdout).toContain("mermaid");
  });

  it("code-blocks filters by --lang", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "code-blocks",
      path.join(fixturesDir, "valid-all-features.md"),
      "--lang",
      "nonexistent",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No code blocks found");
  });

  // md structure tests
  it("structure shows document skeleton", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "structure",
      path.join(fixturesDir, "valid-all-features.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# Valid All Features");
    expect(stdout).toContain("mermaid");
  });

  it("structure outputs valid JSON", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "structure",
      path.join(fixturesDir, "valid-all-features.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("type");
    expect(parsed[0]).toHaveProperty("line");
    expect(parsed[0]).toHaveProperty("detail");
  });

  // md links tests
  it("links lists links grouped by type", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "links",
      path.join(fixturesDir, "valid-all-features.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("link(s)");
  });

  it("links outputs valid JSON", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "links",
      path.join(fixturesDir, "valid-all-features.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  // md section tests
  it("section extracts section content", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "section",
      path.join(fixturesDir, "with-sections.md"),
      "Usage",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("Use the CLI like this");
  });

  it("section extracts with --raw", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "section",
      path.join(fixturesDir, "with-sections.md"),
      "Usage",
      "--raw",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("## Usage");
    expect(stdout).toContain("Use the CLI like this");
    // Should not contain wrapper text
    expect(stdout).not.toContain("Section ");
  });

  it("section exits 1 for missing heading", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "section",
      path.join(fixturesDir, "with-sections.md"),
      "Nonexistent",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Heading not found");
  });

  it("section outputs valid JSON", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "section",
      path.join(fixturesDir, "with-sections.md"),
      "Getting Started",
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("heading", "Getting Started");
    expect(parsed).toHaveProperty("slug", "getting-started");
    expect(parsed).toHaveProperty("depth", 2);
    expect(parsed).toHaveProperty("content");
    expect(parsed.content).toContain("Prerequisites");
  });

  it("section respects --no-children", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "section",
      path.join(fixturesDir, "with-sections.md"),
      "Getting Started",
      "--no-children",
      "--raw",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("getting started section");
    expect(stdout).not.toContain("Prerequisites");
  });

  it("section matches by slug", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "section",
      path.join(fixturesDir, "with-sections.md"),
      "getting-started",
      "--raw",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Getting Started");
  });

  // md frontmatter tests
  it("frontmatter displays parsed frontmatter", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "frontmatter",
      path.join(fixturesDir, "with-frontmatter.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Frontmatter in");
    expect(stdout).toContain("title");
    expect(stdout).toContain("My Document");
  });

  it("frontmatter outputs valid JSON", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "frontmatter",
      path.join(fixturesDir, "with-frontmatter.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.title).toBe("My Document");
    expect(parsed.author.name).toBe("Jane Doe");
    expect(parsed.tags).toEqual(["markdown", "tools"]);
  });

  it("frontmatter extracts specific key", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "frontmatter",
      path.join(fixturesDir, "with-frontmatter.md"),
      "--key",
      "author.name",
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("Jane Doe");
  });

  it("frontmatter exits 1 for missing key", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "frontmatter",
      path.join(fixturesDir, "with-frontmatter.md"),
      "--key",
      "nonexistent.path",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Key not found");
  });

  it("frontmatter handles file without frontmatter", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "frontmatter",
      path.join(fixturesDir, "clean.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No frontmatter");
  });

  // md tasks tests
  it("tasks lists task items", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tasks",
      path.join(fixturesDir, "with-tasks.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("task(s)");
    expect(stdout).toContain("[x]");
    expect(stdout).toContain("[ ]");
  });

  it("tasks filters by --status done", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tasks",
      path.join(fixturesDir, "with-tasks.md"),
      "--status",
      "done",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[x]");
    expect(stdout).not.toContain("[ ]");
  });

  it("tasks filters by --status pending", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tasks",
      path.join(fixturesDir, "with-tasks.md"),
      "--status",
      "pending",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[ ]");
    expect(stdout).not.toContain("[x]");
  });

  it("tasks shows summary with --summary", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tasks",
      path.join(fixturesDir, "with-tasks.md"),
      "--summary",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("done");
    expect(stdout).toContain("pending");
    expect(stdout).toContain("%");
    // Summary should not list individual tasks
    expect(stdout).not.toContain("L");
  });

  it("tasks outputs valid JSON", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tasks",
      path.join(fixturesDir, "with-tasks.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("total");
    expect(parsed).toHaveProperty("done");
    expect(parsed).toHaveProperty("pending");
    expect(parsed).toHaveProperty("tasks");
    expect(parsed.total).toBe(parsed.done + parsed.pending);
    expect(parsed.tasks[0]).toHaveProperty("line");
    expect(parsed.tasks[0]).toHaveProperty("checked");
    expect(parsed.tasks[0]).toHaveProperty("text");
  });

  // md tables tests
  it("tables lists tables with dimensions", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tables",
      path.join(fixturesDir, "with-tables.md"),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("table(s)");
    expect(stdout).toContain("columns");
    expect(stdout).toContain("rows");
  });

  it("tables extracts specific table with --index", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tables",
      path.join(fixturesDir, "with-tables.md"),
      "--index",
      "1",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("1 table(s)");
  });

  it("tables exits 1 for out-of-range --index", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "tables",
      path.join(fixturesDir, "with-tables.md"),
      "--index",
      "99",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("out of range");
  });

  it("tables includes content with --content", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tables",
      path.join(fixturesDir, "with-tables.md"),
      "--content",
      "--index",
      "1",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Name");
    expect(stdout).toContain("format");
  });

  it("tables outputs valid JSON", async () => {
    const { exitCode, stdout } = await runCli(
      "md",
      "tables",
      path.join(fixturesDir, "with-tables.md"),
      "-fj",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toHaveProperty("headers");
    expect(parsed[0]).toHaveProperty("data");
    expect(parsed[0]).toHaveProperty("columns");
    expect(parsed[0]).toHaveProperty("rows");
    expect(parsed[0]).toHaveProperty("align");
  });

  // md orphans tests
  it("orphans finds unreferenced files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphans-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "index.md"), "# Index\n\nSee [guide](./guide.md).\n");
      fs.writeFileSync(path.join(tmpDir, "guide.md"), "# Guide\n\nContent.\n");
      fs.writeFileSync(path.join(tmpDir, "orphan.md"), "# Orphan\n\nNobody links here.\n");

      const { exitCode, stderr } = await runCli("md", "orphans", tmpDir);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("orphan.md");
      expect(stderr).toContain("index.md");
      // guide.md is referenced, should not be in orphans
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("orphans respects --entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphans-entry-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# README\n\nSee [other](./other.md).\n");
      fs.writeFileSync(path.join(tmpDir, "other.md"), "# Other\n\nContent.\n");

      const { exitCode, stdout } = await runCli("md", "orphans", tmpDir, "--entry", "README.md");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("No orphans");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("orphans outputs valid JSON", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphans-json-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.md"), "# A\n\n[link](./b.md)\n");
      fs.writeFileSync(path.join(tmpDir, "b.md"), "# B\n");
      fs.writeFileSync(path.join(tmpDir, "c.md"), "# C\n");

      const { exitCode, stderr } = await runCli("md", "orphans", tmpDir, "-fj");
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stderr);
      expect(parsed).toHaveProperty("totalFiles", 3);
      expect(parsed).toHaveProperty("orphans");
      expect(parsed.orphans.length).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // md rename-heading tests
  it("rename-heading dry-run shows planned changes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-"));
    const tmpFile = path.join(tmpDir, "test.md");
    try {
      fs.writeFileSync(
        tmpFile,
        "# Title\n\n## Old Section\n\nContent.\n\nSee [link](#old-section).\n",
      );

      const { exitCode, stdout } = await runCli(
        "md",
        "rename-heading",
        tmpFile,
        "Old Section",
        "New Section",
        "--dry-run",
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Old Section");
      expect(stdout).toContain("New Section");
      expect(stdout).toContain("#old-section");
      expect(stdout).toContain("#new-section");
      expect(stdout).toContain("dry run");

      // File should not be modified
      const content = fs.readFileSync(tmpFile, "utf-8");
      expect(content).toContain("## Old Section");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rename-heading applies changes without dry-run", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-apply-"));
    const tmpFile = path.join(tmpDir, "test.md");
    try {
      fs.writeFileSync(tmpFile, "# Title\n\n## Old Name\n\nContent.\n\nSee [link](#old-name).\n");

      const { exitCode } = await runCli("md", "rename-heading", tmpFile, "Old Name", "New Name");
      expect(exitCode).toBe(0);

      const content = fs.readFileSync(tmpFile, "utf-8");
      expect(content).toContain("## New Name");
      expect(content).toContain("#new-name");
      expect(content).not.toContain("## Old Name");
      expect(content).not.toContain("#old-name");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rename-heading exits 1 for missing heading", async () => {
    const { exitCode, stderr } = await runCli(
      "md",
      "rename-heading",
      path.join(fixturesDir, "with-sections.md"),
      "Nonexistent",
      "New Name",
      "--dry-run",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Heading not found");
  });

  it("rename-heading outputs valid JSON", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-json-"));
    const tmpFile = path.join(tmpDir, "test.md");
    try {
      fs.writeFileSync(tmpFile, "# Title\n\n## My Heading\n\nContent.\n");

      const { exitCode, stdout } = await runCli(
        "md",
        "rename-heading",
        tmpFile,
        "My Heading",
        "Your Heading",
        "--dry-run",
        "-fj",
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty("heading");
      expect(parsed.heading.oldText).toBe("My Heading");
      expect(parsed.heading.newText).toBe("Your Heading");
      expect(parsed.heading.oldSlug).toBe("my-heading");
      expect(parsed.heading.newSlug).toBe("your-heading");
      expect(parsed.dryRun).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads project config upward and applies command defaults", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "configured-cli-"));
    const nested = path.join(tmpDir, "nested");
    try {
      fs.mkdirSync(nested);
      fs.writeFileSync(
        path.join(tmpDir, ".cairn.yml"),
        [
          "version: 1",
          "output:",
          "  format: json",
          "  paths: relative",
          "commands:",
          "  headers:",
          "    maxDepth: 1",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(tmpDir, "doc.md"), "# Top\n\n## Child\n");
      const { stdout, exitCode } = await runCliIn(nested, "md", "headers", "../doc.md");
      expect(exitCode).toBe(0);
      const headings = JSON.parse(stdout);
      expect(headings).toHaveLength(1);
      expect(headings[0].slug).toBe("top");
      const stats = await runCliIn(nested, "md", "stats", "../doc.md");
      expect(stats.exitCode).toBe(0);
      expect(JSON.parse(stats.stdout).file).toBe("doc.md");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lets CLI flags override config and supports --no-config", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "configured-override-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, ".cairn.yml"),
        "version: 1\noutput:\n  format: json\ncommands:\n  headers:\n    maxDepth: 1\n",
      );
      fs.writeFileSync(path.join(tmpDir, "doc.md"), "# Top\n\n## Child\n");
      const overridden = await runCliIn(
        tmpDir,
        "md",
        "headers",
        "doc.md",
        "--format=llm",
        "--max-depth",
        "2",
      );
      expect(overridden.exitCode).toBe(0);
      expect(overridden.stdout).toContain("2 heading(s)");
      const unconfigured = await runCliIn(tmpDir, "md", "headers", "doc.md", "--no-config");
      expect(unconfigured.exitCode).toBe(0);
      expect(unconfigured.stdout).toContain("2 heading(s)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts an explicit config path after a subcommand", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-config-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "custom.yml"), "version: 1\noutput:\n  format: json\n");
      fs.writeFileSync(path.join(tmpDir, "doc.md"), "# Doc\n");
      const result = await runCliIn(tmpDir, "md", "headers", "doc.md", "--config", "custom.yml");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)[0].slug).toBe("doc");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses the configured workspace for an omitted lint-dir argument", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "configured-workspace-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "docs"));
      fs.writeFileSync(
        path.join(tmpDir, ".cairn.yml"),
        "version: 1\nroot: docs\nchecks:\n  katex: false\n",
      );
      fs.writeFileSync(path.join(tmpDir, "docs", "doc.md"), "# Doc\n\nBad math: $\\invalid$\n");
      const { stdout, exitCode } = await runCliIn(tmpDir, "md", "lint-dir");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("No issues found across 1 file(s)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies configured URL ignore patterns without making requests", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "configured-urls-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, ".cairn.yml"),
        'version: 1\nurls:\n  ignore: ["https://127.0.0.1:1/**"]\n',
      );
      fs.writeFileSync(path.join(tmpDir, "doc.md"), "[ignored](https://127.0.0.1:1/nope)\n");
      const { stdout, exitCode } = await runCliIn(tmpDir, "md", "check-urls", "doc.md");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("No external URLs found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("renames duplicate GitHub heading anchors and reference-style destinations", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-duplicates-"));
    const target = path.join(tmpDir, "target.md");
    const source = path.join(tmpDir, "source.md");
    try {
      fs.writeFileSync(target, "# Same\n\n## Same\n");
      fs.writeFileSync(source, "[second][ref]\n\n[ref]: target.md#same-1\n");
      const { exitCode } = await runCli(
        "md",
        "rename-heading",
        target,
        "same-1",
        "Different",
        "--directory",
        tmpDir,
      );
      expect(exitCode).toBe(0);
      expect(fs.readFileSync(target, "utf-8")).toContain("## Different");
      expect(fs.readFileSync(source, "utf-8")).toContain("target.md#different");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("graphs reachability and emits deterministic raw graph output", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-e2e-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "entry.md"), "[Child](child.md)\n");
      fs.writeFileSync(path.join(tmpDir, "child.md"), "# Child\n");
      fs.writeFileSync(path.join(tmpDir, "lost.md"), "# Lost\n");
      const report = await runCli(
        "md",
        "graph",
        tmpDir,
        "--entry",
        path.join(tmpDir, "entry.md"),
        "-fj",
      );
      expect(report.exitCode).toBe(2);
      expect(JSON.parse(report.stderr).unreachable).toContain(path.join(tmpDir, "lost.md"));
      const raw = await runCli("md", "graph", tmpDir, "--output", "dot");
      expect(raw.stdout).toMatch(/^digraph markdown \{/);
      expect(raw.stderr).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("narrows the graph and the diagram to a focus neighborhood", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-focus-e2e-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "hub.md"), "[Near](near.md)\n");
      fs.writeFileSync(path.join(tmpDir, "near.md"), "[Far](far.md)\n");
      fs.writeFileSync(path.join(tmpDir, "far.md"), "# Far\n");
      fs.writeFileSync(path.join(tmpDir, "island.md"), "# Island\n");
      const hub = path.join(tmpDir, "hub.md");

      const one = await runCli("md", "graph", tmpDir, "--focus", hub, "--depth", "1", "-fj");
      expect(one.exitCode).toBe(0);
      const payload = JSON.parse(one.stdout);
      expect(payload.focus).toEqual({ files: [hub], depth: 1, nodes: 2, omitted: 2 });
      expect(payload.nodes.map((n: { file: string }) => n.file)).toEqual([
        path.join(tmpDir, "hub.md"),
        path.join(tmpDir, "near.md"),
      ]);

      // The diagram is the point of the flag; it must shrink too.
      const diagram = await runCli(
        "md",
        "graph",
        tmpDir,
        "--focus",
        hub,
        "--depth",
        "0",
        "--output",
        "mermaid",
      );
      expect(diagram.exitCode).toBe(0);
      expect(diagram.stdout.trim().split("\n")).toHaveLength(2);

      // An unfocused run carries no focus block at all.
      const plain = JSON.parse((await runCli("md", "graph", tmpDir, "-fj")).stdout);
      expect(plain.focus).toBeUndefined();
      expect(plain.files).toBe(4);

      const missing = await runCli("md", "graph", tmpDir, "--focus", path.join(tmpDir, "nope.md"));
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("Focus document not in the selected set");

      const bad = await runCli("md", "graph", tmpDir, "--focus", hub, "--depth", "9");
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain("--depth must be an integer from 0 to 6");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates configured frontmatter schema and shortcut rules", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontmatter-e2e-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "schema.yml"), "type: object\nrequired: [title]\n");
      fs.writeFileSync(
        path.join(tmpDir, ".cairn.yml"),
        "version: 1\nfrontmatter:\n  schema: schema.yml\n  rules:\n    formats: {date: date}\n",
      );
      fs.writeFileSync(path.join(tmpDir, "doc.md"), "---\ntitle: Doc\ndate: invalid\n---\n");
      const result = await runCliIn(tmpDir, "md", "validate-frontmatter", "doc.md", "-fj");
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)[0].checker).toBe("frontmatter/format");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("checks, previews, and writes only a marker-based TOC", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toc-sync-e2e-"));
    const file = path.join(tmpDir, "doc.md");
    try {
      fs.writeFileSync(
        file,
        "# Doc\n\nbefore\n<!-- cairn:toc:start -->\nold\n<!-- cairn:toc:end -->\nafter\n",
      );
      expect((await runCli("md", "toc", file, "--check")).exitCode).toBe(2);
      const preview = await runCli("md", "toc", file, "--dry-run");
      expect(preview.stdout).toContain("- [Doc](#doc)");
      expect(fs.readFileSync(file, "utf-8")).toContain("\nold\n");
      expect((await runCli("md", "toc", file, "--write")).exitCode).toBe(0);
      expect((await runCli("md", "toc", file, "--check")).exitCode).toBe(0);
      expect(fs.readFileSync(file, "utf-8")).toContain(
        "before\n<!-- cairn:toc:start -->\n- [Doc](#doc)\n<!-- cairn:toc:end -->\nafter",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("aggregates configured checks in an audit summary", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-e2e-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, ".cairn.yml"),
        'version: 1\ntoc:\n  files: ["README.md"]\nchecks:\n  mermaid: false\n  katex: false\n  references: false\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, "README.md"),
        "# Readme\n\n<!-- cairn:toc:start -->\nold\n<!-- cairn:toc:end -->\n",
      );
      const result = await runCliIn(tmpDir, "md", "audit", "--summary");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("toc: 1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("suppresses baselined audit findings but still fails on regressions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-baseline-e2e-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".cairn.yml"), "version: 1\n");
      fs.writeFileSync(path.join(tmpDir, "a.md"), "# A\n\n[gone](./missing.md)\n");
      fs.writeFileSync(path.join(tmpDir, "b.md"), "# B\n\n[gone](./nope.md)\n");
      const baseline = path.join(tmpDir, "audit-baseline.json");

      expect((await runCliIn(tmpDir, "md", "audit")).exitCode).toBe(2);

      // Recording exits 0 even though the run found something.
      const written = await runCliIn(tmpDir, "md", "audit", "--write-baseline", baseline);
      expect(written.exitCode).toBe(0);
      expect(written.stdout).toContain("Wrote 2 baseline entries");
      const document = JSON.parse(fs.readFileSync(baseline, "utf-8"));
      expect(document.baselineFormat).toBe("cairn-md-audit-baseline");
      // Workspace-relative, so the file survives a checkout elsewhere.
      expect(document.entries.map((e: { file: string }) => e.file)).toEqual(["a.md", "b.md"]);

      const clean = await runCliIn(tmpDir, "md", "audit", "--baseline", baseline, "-fj");
      expect(clean.exitCode).toBe(0);
      const payload = JSON.parse(clean.stdout);
      expect(payload.findings).toEqual([]);
      expect(payload.totals.findings).toBe(0);
      expect(payload.baseline).toMatchObject({ suppressed: 2, stale: [] });

      // Line drift must not resurface a known finding.
      fs.writeFileSync(
        path.join(tmpDir, "a.md"),
        "# A\n\nfiller\n\nmore\n\n[gone](./missing.md)\n",
      );
      expect((await runCliIn(tmpDir, "md", "audit", "--baseline", baseline)).exitCode).toBe(0);

      // A genuinely new finding still fails, and only it is reported.
      fs.writeFileSync(path.join(tmpDir, "c.md"), "# C\n\n[new](./brand-new.md)\n");
      const regressed = await runCliIn(tmpDir, "md", "audit", "--baseline", baseline);
      expect(regressed.exitCode).toBe(2);
      expect(regressed.stderr).toContain("brand-new.md");
      expect(regressed.stderr).not.toContain("missing.md");

      // Fixing a baselined finding leaves a stale entry, which never fails.
      fs.rmSync(path.join(tmpDir, "c.md"));
      fs.writeFileSync(path.join(tmpDir, "b.md"), "# B\n");
      const fixed = await runCliIn(tmpDir, "md", "audit", "--baseline", baseline, "-fj");
      expect(fixed.exitCode).toBe(0);
      expect(JSON.parse(fixed.stdout).baseline.stale).toEqual([
        {
          checker: "graph/broken",
          file: "b.md",
          message: "Markdown target not found: ./nope.md",
          count: 1,
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects combining baseline flags and reports a foreign baseline as a finding", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-baseline-bad-e2e-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".cairn.yml"), "version: 1\n");
      fs.writeFileSync(path.join(tmpDir, "a.md"), "# A\n\n[gone](./missing.md)\n");
      const baseline = path.join(tmpDir, "b.json");

      const both = await runCliIn(
        tmpDir,
        "md",
        "audit",
        "--baseline",
        baseline,
        "--write-baseline",
        baseline,
      );
      expect(both.exitCode).toBe(1);
      expect(both.stderr).toContain("cannot be combined");

      const missing = await runCliIn(tmpDir, "md", "audit", "--baseline", baseline);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("does not exist");

      // A document from some other tool is reported, not silently trusted.
      fs.writeFileSync(baseline, JSON.stringify({ bomFormat: "something-else" }));
      const foreign = await runCliIn(tmpDir, "md", "audit", "--baseline", baseline);
      expect(foreign.exitCode).toBe(2);
      expect(foreign.stderr).toContain("[baseline]");
      expect(foreign.stderr).toContain("missing.md");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("moves a file and rewrites inbound and outbound references", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-file-e2e-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "old"));
      fs.mkdirSync(path.join(tmpDir, "new"));
      fs.writeFileSync(path.join(tmpDir, ".cairn.yml"), "version: 1\n");
      fs.writeFileSync(path.join(tmpDir, "target.md"), "# Target\n");
      fs.writeFileSync(
        path.join(tmpDir, "old", "source.md"),
        "[Target](../target.md?x=1#target)\n",
      );
      fs.writeFileSync(path.join(tmpDir, "index.md"), "[Moved](old/source.md#top)\n");
      const preview = await runCliIn(
        tmpDir,
        "md",
        "rename-file",
        "old/source.md",
        "new/moved.md",
        "--dry-run",
        "-fj",
        "--paths",
        "relative",
      );
      expect(preview.exitCode).toBe(0);
      expect(JSON.parse(preview.stdout).dryRun).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "old", "source.md"))).toBe(true);
      const moved = await runCliIn(tmpDir, "md", "rename-file", "old/source.md", "new/moved.md");
      expect(moved.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(tmpDir, "index.md"), "utf-8")).toContain("new/moved.md#top");
      expect(fs.readFileSync(path.join(tmpDir, "new", "moved.md"), "utf-8")).toContain(
        "../target.md?x=1#target",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("routes JSONL and SARIF findings to stderr", async () => {
    const file = path.join(fixturesDir, "broken-katex.md");
    const jsonl = await runCli("md", "lint", file, "--format", "jsonl");
    expect(jsonl.exitCode).toBe(2);
    const records = jsonl.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1).type).toBe("summary");
    const sarif = await runCli("md", "lint", file, "--format", "sarif");
    expect(sarif.exitCode).toBe(2);
    expect(JSON.parse(sarif.stderr).version).toBe("2.1.0");
  });
});

describe("workspace queries and index", () => {
  it("queries richer workspace data and manages the persistent index", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-query-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, ".cairn.yml"),
        'version: 1\noutput:\n  paths: relative\nassets:\n  extensions: [".png", ".svg"]\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, "a.md"),
        "---\ntitle: Shared\nslug: same\nid: one\n---\n# Alpha\n\n[Part](guide.md#part)\n![Used](used.png)\n\n- [ ] Todo\n\n```js\nconst a = 1;\n```\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, "b.md"),
        "---\ntitle: Shared\nslug: same\nid: one\n---\n# Beta\n\n## Alpha\n\n- [x] Done\n\n```python\npass\n```\n",
      );
      fs.writeFileSync(path.join(tmpDir, "guide.md"), "# Guide\n\n## Part\n");
      fs.writeFileSync(path.join(tmpDir, "missing.md"), "No top-level heading.\n");
      fs.writeFileSync(path.join(tmpDir, "used.png"), "used");
      fs.writeFileSync(path.join(tmpDir, "unused.svg"), "unused");

      const duplicates = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "query",
        "duplicates",
        "--field",
        "title",
        "--format=json",
      );
      expect(duplicates.exitCode).toBe(0);
      expect(JSON.parse(duplicates.stdout).results[0]).toMatchObject({ value: "Shared" });

      const links = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "query",
        "links-to",
        "--target",
        "guide.md#part",
        "--format=json",
      );
      expect(JSON.parse(links.stdout).results).toHaveLength(1);

      const unused = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "query",
        "unused-assets",
        "--format=json",
      );
      expect(JSON.parse(unused.stdout).results).toEqual([
        { file: "unused.svg", extension: ".svg" },
      ]);

      const blocks = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "query",
        "code-blocks",
        "--lang",
        "js",
        "--format=json",
      );
      expect(JSON.parse(blocks.stdout).results).toMatchObject([{ language: "js", count: 1 }]);

      const tasks = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "query",
        "tasks",
        "--summary",
        "--format=json",
      );
      expect(JSON.parse(tasks.stdout).summary).toEqual({
        total: 2,
        done: 1,
        pending: 1,
        matched: 2,
      });

      const missing = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "query",
        "missing-h1",
        "--format=json",
      );
      expect(JSON.parse(missing.stdout).results).toEqual([{ file: "missing.md" }]);

      const built = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "index",
        "build",
        "--format=json",
      );
      expect(built.stderr).toBe("");
      expect(built.exitCode).toBe(0);
      expect(JSON.parse(built.stdout)).toMatchObject({ action: "build", current: 4, stale: 0 });
      const status = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "index",
        "status",
        "--format=json",
      );
      expect(JSON.parse(status.stdout)).toMatchObject({ action: "status", current: 4, missing: 0 });
      const cleared = await runCliInWithWorkspaceCache(
        tmpDir,
        "md",
        "index",
        "clear",
        "--format=json",
      );
      expect(JSON.parse(cleared.stdout)).toMatchObject({ action: "clear", cleared: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("md context", () => {
  async function inWorkspace(body: (dir: string) => Promise<void>): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-context-e2e-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.md"), "# A\nlead\n\n## Details\nbody\n\n[b](./b.md)\n");
      fs.writeFileSync(path.join(tmpDir, "b.md"), "# B\nbody\n\n[c](./c.md)\n");
      fs.writeFileSync(path.join(tmpDir, "c.md"), "# C\nbody\n");
      fs.writeFileSync(path.join(tmpDir, "gone.md"), "# Gone\n\n[x](./missing.md)\n");
      await body(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("packs a seed and its neighbours, with provenance", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(dir, "md", "context", "a.md", "--depth", "1", "-fj");
      expect(result.exitCode).toBe(0);
      const pack = JSON.parse(result.stdout);
      expect(pack.files.map((f: string) => path.basename(f))).toEqual(["a.md", "b.md"]);
      expect(pack.units.map((u: { heading: string }) => u.heading)).toEqual(["A", "Details", "B"]);
      expect(pack.units[2].provenance).toMatchObject({ distance: 1, direction: "link" });
      expect(pack.budget.truncated).toBe(false);
    });
  });

  it("emits a paste-ready pack with provenance comments in llm format", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(
        dir,
        "md",
        "context",
        "a.md",
        "--depth",
        "0",
        "--paths",
        "relative",
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("<!-- a.md#a (L1-L3) seed -->");
      expect(result.stdout).toContain("# A\nlead");
      expect(result.stdout).toContain("estimate: bytes/4");
    });
  });

  it("restricts to a named section, optionally without its subsections", async () => {
    await inWorkspace(async (dir) => {
      const whole = await runCliIn(
        dir,
        "md",
        "context",
        "a.md",
        "--section",
        "A",
        "--depth",
        "0",
        "-fj",
      );
      expect(JSON.parse(whole.stdout).units.map((u: { heading: string }) => u.heading)).toEqual([
        "A",
        "Details",
      ]);
      const only = await runCliIn(
        dir,
        "md",
        "context",
        "a.md",
        "--section",
        "A",
        "--no-children",
        "--depth",
        "0",
        "-fj",
      );
      expect(JSON.parse(only.stdout).units.map((u: { heading: string }) => u.heading)).toEqual([
        "A",
      ]);
    });
  });

  it("seeds from documents referencing --target", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(
        dir,
        "md",
        "context",
        "--target",
        "c.md",
        "--depth",
        "0",
        "-fj",
      );
      expect(result.exitCode).toBe(0);
      const pack = JSON.parse(result.stdout);
      expect(pack.seeds.map((f: string) => path.basename(f))).toEqual(["b.md"]);
    });
  });

  it("truncates to a byte budget and exits 0 anyway", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(
        dir,
        "md",
        "context",
        "a.md",
        "--depth",
        "1",
        "--budget",
        "12",
        "-fj",
      );
      expect(result.exitCode).toBe(0);
      const pack = JSON.parse(result.stdout);
      expect(pack.budget.truncated).toBe(true);
      expect(pack.omitted.length).toBeGreaterThan(0);
      expect(pack.budget.usedBytes).toBeLessThanOrEqual(12);
    });
  });

  it("reports broken dependencies without changing the exit code", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(dir, "md", "context", "gone.md", "--depth", "0", "-fj");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).broken).toHaveLength(1);
    });
  });

  it("rejects a missing seed, an unknown section, and stdin", async () => {
    await inWorkspace(async (dir) => {
      const noSeed = await runCliIn(dir, "md", "context");
      expect(noSeed.exitCode).toBe(1);
      expect(noSeed.stderr).toMatch(/requires at least one seed file or --target/);

      const badSection = await runCliIn(dir, "md", "context", "a.md", "--section", "Nope");
      expect(badSection.exitCode).toBe(1);
      expect(badSection.stderr).toMatch(/Heading not found in any seed: Nope/);

      const stdin = await runCliIn(dir, "md", "context", "-");
      expect(stdin.exitCode).toBe(1);
      expect(stdin.stderr).toMatch(/does not accept stdin/);

      const badDepth = await runCliIn(dir, "md", "context", "a.md", "--depth", "9");
      expect(badDepth.exitCode).toBe(1);
      expect(badDepth.stderr).toMatch(/--depth must be an integer from 0 to 6/);
    });
  });
});

describe("md diff", () => {
  function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-diff-e2e-"));
    const env = {
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "a.md"), "# Title\n\n- [ ] Ship it\n\n[G](./old.md)\n");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    return dir;
  }

  it("compares two files by structure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-diff-files-"));
    try {
      fs.writeFileSync(path.join(dir, "old.md"), "# Top\n\n## Alpha\nbody\n");
      fs.writeFileSync(path.join(dir, "new.md"), "# Top\n\n## Beta\nbody\n");
      const result = await runCliIn(dir, "md", "diff", "old.md", "new.md", "-fj");
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.mode).toBe("files");
      expect(report.files[0].headings).toContainEqual(
        expect.objectContaining({
          kind: "renamed",
          oldText: "Alpha",
          newText: "Beta",
          heuristic: true,
        }),
      );
      expect(report.totals.heuristicRenames).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("labels heuristic renames in the text output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-diff-text-"));
    try {
      fs.writeFileSync(path.join(dir, "old.md"), "# Top\n\n## Alpha\nbody\n");
      fs.writeFileSync(path.join(dir, "new.md"), "# Top\n\n## Beta\nbody\n");
      const result = await runCliIn(dir, "md", "diff", "old.md", "new.md", "--paths", "relative");
      expect(result.stdout).toContain('"Alpha" -> "Beta"');
      expect(result.stdout).toContain("heuristic");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compares the worktree against a revision", async () => {
    const dir = repo();
    try {
      fs.writeFileSync(path.join(dir, "a.md"), "# Title\n\n- [x] Ship it\n\n[G](./new.md)\n");
      fs.writeFileSync(path.join(dir, "b.md"), "# Added\n");
      const result = await runCliIn(dir, "md", "diff", "--since", "HEAD", "-fj");
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.mode).toBe("revision");
      expect(report.base).toBe("HEAD");
      expect(report.baseCommit).toMatch(/^[0-9a-f]{40}$/);

      const changed = report.files.find((f: { file: string }) => f.file.endsWith("a.md"));
      expect(changed.status).toBe("modified");
      expect(changed.tasks[0]).toMatchObject({ oldChecked: false, newChecked: true });
      expect(changed.links[0]).toMatchObject({ oldTarget: "./old.md", newTarget: "./new.md" });

      const added = report.files.find((f: { file: string }) => f.file.endsWith("b.md"));
      expect(added.status).toBe("added");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a deleted document as removed", async () => {
    const dir = repo();
    try {
      fs.rmSync(path.join(dir, "a.md"));
      const report = JSON.parse(
        (await runCliIn(dir, "md", "diff", "--since", "HEAD", "-fj")).stdout,
      );
      expect(report.files[0].status).toBe("removed");
      expect(report.files[0].headings[0]).toMatchObject({ kind: "removed", oldText: "Title" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 when nothing changed", async () => {
    const dir = repo();
    try {
      const result = await runCliIn(dir, "md", "diff", "--since", "HEAD");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No Markdown changes.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects both modes at once, neither mode, and an unknown revision", async () => {
    const dir = repo();
    try {
      const both = await runCliIn(dir, "md", "diff", "a.md", "a.md", "--since", "HEAD");
      expect(both.exitCode).toBe(1);
      expect(both.stderr).toMatch(/--since cannot be combined with two paths/);

      const neither = await runCliIn(dir, "md", "diff");
      expect(neither.exitCode).toBe(1);
      expect(neither.stderr).toMatch(/needs two paths, or --since/);

      // A typo'd revision must fail loudly, never be read as "all files are new".
      const bogus = await runCliIn(dir, "md", "diff", "--since", "no-such-ref");
      expect(bogus.exitCode).toBe(1);
      expect(bogus.stderr).toMatch(/Unable to read revision no-such-ref/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("md fix", () => {
  const STALE =
    "# Doc\n\nbefore\n<!-- cairn:toc:start -->\nold\n<!-- cairn:toc:end -->\n\n## Section\n";
  const FIXED =
    "# Doc\n\nbefore\n<!-- cairn:toc:start -->\n- [Doc](#doc)\n  - [Section](#section)\n<!-- cairn:toc:end -->\n\n## Section\n";

  async function inWorkspace(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-fix-e2e-"));
    try {
      fs.writeFileSync(path.join(dir, "doc.md"), STALE);
      await body(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("defaults to --check, exits 2, and modifies nothing", async () => {
    await inWorkspace(async (dir) => {
      const before = fs.statSync(path.join(dir, "doc.md"));
      const result = await runCliIn(dir, "md", "fix", "doc.md", "-fj");
      expect(result.exitCode).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.mode).toBe("check");
      expect(payload.edits).toBe(1);
      // Guards against a plan that "fails" for the wrong reason.
      expect(payload.conflicts).toEqual([]);
      expect(payload.rules).toEqual(["markdownlint", "relative-links", "toc"]);
      const after = fs.statSync(path.join(dir, "doc.md"));
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(STALE);
    });
  });

  it("exits 0 and reports nothing when the workspace is already clean", async () => {
    await inWorkspace(async (dir) => {
      fs.writeFileSync(path.join(dir, "doc.md"), FIXED);
      const result = await runCliIn(dir, "md", "fix", "doc.md");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No pending fixes");
    });
  });

  it("prints byte ranges and both texts in --dry-run without writing", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(dir, "md", "fix", "doc.md", "--dry-run");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("toc");
      expect(result.stdout).toMatch(/\[\d+,\d+\)/);
      expect(result.stdout).toContain("dry run — no files modified");
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(STALE);
    });
  });

  it("applies with --write and is idempotent", async () => {
    await inWorkspace(async (dir) => {
      const first = await runCliIn(dir, "md", "fix", "doc.md", "--write", "-fj");
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout).applied).toBe(1);
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(FIXED);

      const second = await runCliIn(dir, "md", "fix", "doc.md", "--write", "-fj");
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout).edits).toBe(0);
      expect((await runCliIn(dir, "md", "fix", "doc.md")).exitCode).toBe(0);
      // No staging file survives a successful commit.
      expect(fs.readdirSync(dir).filter((n) => n.includes("cairn-"))).toEqual([]);
    });
  });

  it("reports malformed markers as unfixable without failing the run", async () => {
    await inWorkspace(async (dir) => {
      fs.writeFileSync(
        path.join(dir, "bad.md"),
        "# Bad\n<!-- cairn:toc:start -->\n<!-- cairn:toc:start -->\n<!-- cairn:toc:end -->\n",
      );
      const result = await runCliIn(dir, "md", "fix", ".", "-fj");
      // doc.md still has a pending fix, so the exit is 2 for that, not for bad.md.
      expect(result.exitCode).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.unfixable).toHaveLength(1);
      expect(payload.unfixable[0]).toMatchObject({ rule: "toc", reason: "malformed markers" });
    });
  });

  it("leaves a document without markers alone", async () => {
    await inWorkspace(async (dir) => {
      fs.writeFileSync(path.join(dir, "plain.md"), "# Plain\n\n## Section\n");
      const result = await runCliIn(dir, "md", "fix", "plain.md", "-fj");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).edits).toBe(0);
    });
  });

  it("rejects conflicting modes, an unknown rule, and stdin", async () => {
    await inWorkspace(async (dir) => {
      const modes = await runCliIn(dir, "md", "fix", "doc.md", "--check", "--write");
      expect(modes.exitCode).toBe(1);
      expect(modes.stderr).toMatch(/cannot be used together/);

      const rule = await runCliIn(dir, "md", "fix", "doc.md", "--rule", "nope");
      expect(rule.exitCode).toBe(1);
      expect(rule.stderr).toMatch(/Unknown rule: nope/);

      const stdin = await runCliIn(dir, "md", "fix", "-");
      expect(stdin.exitCode).toBe(1);
      expect(stdin.stderr).toMatch(/does not accept stdin/);
    });
  });

  it("refuses a config file that tries to make it write", async () => {
    await inWorkspace(async (dir) => {
      // The mutation mode is CLI-only by design; a checked-in config must never
      // be able to turn a check into a write.
      fs.writeFileSync(
        path.join(dir, ".cairn.yml"),
        "version: 1\ncommands:\n  fix:\n    write: true\n",
      );
      const result = await runCliIn(dir, "md", "fix", "doc.md");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Unknown commands\.fix key: write/);
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(STALE);
    });
  });

  it("runs every fixer by default and can be narrowed with --rule", async () => {
    await inWorkspace(async (dir) => {
      fs.mkdirSync(path.join(dir, "docs"));
      fs.writeFileSync(path.join(dir, "docs", "b.md"), "# B\n");
      fs.writeFileSync(
        path.join(dir, "docs", "a.md"),
        "# A\n\ntrailing   \n\n[x](./sub/../b.md)\n",
      );

      const all = await runCliIn(dir, "md", "fix", "docs", "-fj");
      expect(all.exitCode).toBe(2);
      const payload = JSON.parse(all.stderr);
      expect(payload.rules).toEqual(["markdownlint", "relative-links", "toc"]);
      const rules = payload.files[0].edits.map(
        (e: { diagnostic: { rule: string } }) => e.diagnostic.rule,
      );
      expect(rules).toContain("markdownlint/MD009");
      expect(rules).toContain("relative-links");

      const only = await runCliIn(dir, "md", "fix", "docs", "--rule", "relative-links", "-fj");
      expect(JSON.parse(only.stderr).rules).toEqual(["relative-links"]);
      expect(JSON.parse(only.stderr).edits).toBe(1);
    });
  });

  it("normalizes a link without changing what it resolves to, and is idempotent", async () => {
    await inWorkspace(async (dir) => {
      fs.mkdirSync(path.join(dir, "docs"));
      fs.writeFileSync(path.join(dir, "docs", "b.md"), "# B\n");
      // `./` is preserved on the first link and absent on the second, proving
      // the fixer normalizes the path without imposing a style.
      fs.writeFileSync(
        path.join(dir, "docs", "a.md"),
        "# A\n\n[x](./sub/../b.md)\n[y](../docs/b.md)\n",
      );

      const write = await runCliIn(dir, "md", "fix", "docs", "--rule", "relative-links", "--write");
      expect(write.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(dir, "docs", "a.md"), "utf-8")).toBe(
        "# A\n\n[x](./b.md)\n[y](b.md)\n",
      );

      const again = await runCliIn(dir, "md", "fix", "docs", "--rule", "relative-links", "-fj");
      expect(again.exitCode).toBe(0);
      expect(JSON.parse(again.stdout).edits).toBe(0);
    });
  });

  it("narrows to files changed since a revision", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-fix-git-"));
    try {
      const env = {
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      };
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...env },
        });
      fs.writeFileSync(path.join(dir, "tracked.md"), STALE);
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "first");
      fs.writeFileSync(path.join(dir, "new.md"), STALE);

      const result = await runCliIn(dir, "md", "fix", ".", "--changed-since", "HEAD", "-fj");
      expect(result.exitCode).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.filesScanned).toBe(1);
      expect(payload.files[0].file).toContain("new.md");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("md check-snippets", () => {
  const SOURCE =
    "// cairn:snippet:start greet\nexport function greet() {\n  return 1;\n}\n// cairn:snippet:end greet\n";
  const CURRENT =
    "# Doc\n\n```js cairn:snippet=src/a.js#greet\nexport function greet() {\n  return 1;\n}\n```\n";
  const STALE = "# Doc\n\n```js cairn:snippet=src/a.js#greet\nold body\n```\n";

  async function inWorkspace(
    doc: string,
    body: (dir: string) => Promise<void>,
    source = SOURCE,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-snippets-e2e-"));
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "a.js"), source);
      fs.writeFileSync(path.join(dir, "doc.md"), doc);
      await body(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exits 0 and counts the link when the snippet matches", async () => {
    await inWorkspace(CURRENT, async (dir) => {
      const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "-fj", "--include-ok");
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.mode).toBe("check");
      expect(payload).toMatchObject({ linked: 1, current: 1, drift: 0, unresolved: 0 });
      expect(payload.findings[0]).toMatchObject({
        status: "current",
        target: "src/a.js#greet",
      });
    });
  });

  it("ignores a fence with no snippet attribute", async () => {
    await inWorkspace("# Doc\n\n```js\nanything\n```\n", async (dir) => {
      const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "-fj", "--include-ok");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ linked: 0, findings: [] });
    });
  });

  it("reports drift on stderr with exit 2 and writes nothing", async () => {
    await inWorkspace(STALE, async (dir) => {
      const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "-fj");
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      const payload = JSON.parse(result.stderr);
      expect(payload).toMatchObject({ drift: 1, applied: 0 });
      expect(payload.findings[0]).toMatchObject({ status: "stale", line: 3 });
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(STALE);
    });
  });

  it("--write refreshes the block, and a re-check is clean", async () => {
    await inWorkspace(STALE, async (dir) => {
      const write = await runCliIn(dir, "md", "check-snippets", "doc.md", "--write", "-fj");
      expect(write.exitCode).toBe(0);
      expect(JSON.parse(write.stdout)).toMatchObject({ applied: 1 });
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(CURRENT);
      // Idempotence is the whole reason the writer emits the comparison form.
      const again = await runCliIn(dir, "md", "check-snippets", "doc.md");
      expect(again.exitCode).toBe(0);
    });
  });

  it("--dry-run reports both bodies without writing", async () => {
    await inWorkspace(STALE, async (dir) => {
      const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "--dry-run", "-fj");
      expect(result.exitCode).toBe(2);
      const finding = JSON.parse(result.stderr).findings[0];
      expect(finding.documented).toBe("old body");
      expect(finding.expected).toBe("export function greet() {\n  return 1;\n}");
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(STALE);
    });
  });

  it("fails --write on a missing source, because there is no fix to apply", async () => {
    const doc = "# Doc\n\n```js cairn:snippet=src/gone.js#greet\nx\n```\n";
    await inWorkspace(doc, async (dir) => {
      const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "--write", "-fj");
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr).findings[0]).toMatchObject({
        status: "unresolved",
        reason: "source-not-found",
        message: "Source file not found: src/gone.js",
      });
    });
  });

  it("reports a missing region", async () => {
    const doc = "# Doc\n\n```js cairn:snippet=src/a.js#nope\nx\n```\n";
    await inWorkspace(doc, async (dir) => {
      const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "-fj");
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr).findings[0]).toMatchObject({
        status: "unresolved",
        reason: "region-missing",
      });
    });
  });

  it("refuses a source reached by a symlink out of the workspace root", async () => {
    // --write copies a source into a tracked file, so an escape here is a
    // content-exfiltration primitive rather than a nuisance.
    const doc = "# Doc\n\n```text cairn:snippet=escape.txt\nx\n```\n";
    await inWorkspace(doc, async (dir) => {
      const secret = path.join(dir, "..", `${path.basename(dir)}-outside.txt`);
      fs.writeFileSync(secret, "SECRET\n");
      try {
        fs.symlinkSync(secret, path.join(dir, "escape.txt"));
        const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "-fj");
        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stderr).findings[0]).toMatchObject({
          status: "unresolved",
          reason: "source-outside-root",
        });
        expect(result.stderr).not.toContain("SECRET");
      } finally {
        fs.rmSync(secret, { force: true });
      }
    });
  });

  it("refuses a blockquoted fence but still refreshes the rest of the document", async () => {
    const doc =
      "# Doc\n\n> ```js cairn:snippet=src/a.js#greet\n> x\n> ```\n\n" +
      "```js cairn:snippet=src/a.js#greet\nx\n```\n";
    await inWorkspace(doc, async (dir) => {
      const result = await runCliIn(dir, "md", "check-snippets", "doc.md", "--write", "-fj");
      expect(result.exitCode).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload).toMatchObject({ drift: 2, unwritable: 1, applied: 1 });
      const written = fs.readFileSync(path.join(dir, "doc.md"), "utf-8");
      expect(written).toContain("> x");
      expect(written).toContain("```js cairn:snippet=src/a.js#greet\nexport function greet");
    });
  });

  it("rejects two modes and stdin", async () => {
    await inWorkspace(CURRENT, async (dir) => {
      const modes = await runCliIn(dir, "md", "check-snippets", "doc.md", "--check", "--write");
      expect(modes.exitCode).toBe(1);
      expect(modes.stderr).toMatch(/cannot be used together/);
      const stdin = await runCliIn(dir, "md", "check-snippets", "-");
      expect(stdin.exitCode).toBe(1);
      expect(stdin.stderr).toMatch(/does not accept stdin/);
    });
  });

  it("is reachable from md fix only when named, and from md audit by default", async () => {
    await inWorkspace(STALE, async (dir) => {
      const bare = await runCliIn(dir, "md", "fix", "doc.md", "-fj");
      expect(bare.exitCode).toBe(0);
      expect(JSON.parse(bare.stdout).rules).toEqual(["markdownlint", "relative-links", "toc"]);

      const named = await runCliIn(dir, "md", "fix", "doc.md", "--rule", "snippets", "-fj");
      expect(named.exitCode).toBe(2);
      expect(JSON.parse(named.stderr).edits).toBe(1);

      const audit = await runCliIn(dir, "md", "audit", ".", "-fj");
      expect(audit.exitCode).toBe(2);
      const payload = JSON.parse(audit.stderr);
      expect(payload.enabled).toContain("snippets");
      expect(payload.totals.byCheck.snippets).toBe(1);
      expect(payload.findings[0]).toMatchObject({
        checker: "snippets/drift",
        message: "Snippet is out of date with src/a.js#greet",
      });

      const off = await runCliIn(dir, "md", "audit", ".", "--no-snippets", "-fj");
      expect(off.exitCode).toBe(0);
      expect(JSON.parse(off.stdout).skipped).toContain("snippets");
    });
  });

  it("finds no drift in this repository's own documentation", async () => {
    // Catches three regressions at once: the docs' own examples going live, a
    // phantom region picked up from a fenced example, and any change from
    // reading `Code.meta` back to scanning the raw document.
    const repoRoot = path.join(__dirname, "..", "..");
    const result = await runCliIn(repoRoot, "md", "check-snippets", "docs", "README.md");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

describe("md rename-heading transaction", () => {
  it("updates every file and leaves no staging file behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-heading-tx-"));
    try {
      fs.writeFileSync(
        path.join(dir, "doc.md"),
        "# Doc\n\n## Old Section\n\ntext\n\n[a](#old-section)\n",
      );
      fs.writeFileSync(
        path.join(dir, "other.md"),
        "# Other\n\nSee [x](./doc.md#old-section) and [y](./doc.md#old-section).\n",
      );

      const result = await runCliIn(
        dir,
        "md",
        "rename-heading",
        "doc.md",
        "Old Section",
        "New Section",
        "--directory",
        ".",
      );
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(dir, "doc.md"), "utf-8")).toBe(
        "# Doc\n\n## New Section\n\ntext\n\n[a](#new-section)\n",
      );
      expect(fs.readFileSync(path.join(dir, "other.md"), "utf-8")).toBe(
        "# Other\n\nSee [x](./doc.md#new-section) and [y](./doc.md#new-section).\n",
      );
      // The write now stages siblings and commits by rename; none may survive.
      expect(fs.readdirSync(dir).sort()).toEqual(["doc.md", "other.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("md query composable predicates", () => {
  async function inWorkspace(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-query-e2e-"));
    try {
      fs.writeFileSync(
        path.join(dir, "a.md"),
        "---\nowner: alice\ntags: [api, cli]\n---\n# A\n\n## Sub\n\n- [ ] one\n- [x] two\n\n[G](./b.md)\n\n```ts\ncode();\n```\n",
      );
      fs.writeFileSync(path.join(dir, "b.md"), "---\nowner: bob\n---\n## No H1\n\n- [ ] three\n");
      await body(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("leaves the shortcut kinds byte-identical without composable options", async () => {
    await inWorkspace(async (dir) => {
      const tasks = JSON.parse((await runCliIn(dir, "md", "query", "tasks", "-fj")).stdout);
      expect(Object.keys(tasks)).toEqual(["kind", "directory", "count", "results", "summary"]);
      expect(tasks.results[0]).toEqual(
        expect.objectContaining({ line: expect.any(Number), checked: false, text: "one" }),
      );

      // code-blocks still groups by language without composable options.
      const blocks = JSON.parse((await runCliIn(dir, "md", "query", "code-blocks", "-fj")).stdout);
      expect(blocks.results[0]).toMatchObject({ language: "ts", count: 1 });
      expect(blocks.fields).toBeUndefined();
    });
  });

  it("inventories top-level frontmatter keys", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(dir, "md", "query", "frontmatter-keys", "-fj");
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.kind).toBe("frontmatter-keys");
      // Sorted by key in byte order, and `coverage` is a share of the
      // documents that have frontmatter, not of every selected document.
      expect(payload.results).toEqual([
        { key: "owner", documents: 2, coverage: 1, types: ["string"] },
        { key: "tags", documents: 1, coverage: 0.5, types: ["array"] },
      ]);
      expect(payload.summary).toEqual({ documents: 2, withFrontmatter: 2, keys: 2 });
      expect(payload.count).toBe(2);
      // An aggregate kind carries no projection.
      expect(payload.fields).toBeUndefined();
    });
  });

  it("rejects composable options on frontmatter-keys with the entity form to use", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(dir, "md", "query", "frontmatter-keys", "--select", "key");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("does not support composable options");
      expect(result.stderr).toContain("md query frontmatter --select key --group-by key");
    });
  });

  it("switches code-blocks to flat rows when a composable option is given", async () => {
    await inWorkspace(async (dir) => {
      const result = await runCliIn(
        dir,
        "md",
        "query",
        "code-blocks",
        "--select",
        "file,language",
        "-fj",
      );
      const payload = JSON.parse(result.stdout);
      expect(payload.fields).toEqual(["file", "language"]);
      expect(payload.results).toEqual([{ file: expect.stringContaining("a.md"), language: "ts" }]);
    });
  });

  it("agrees with the missing-h1 shortcut", async () => {
    await inWorkspace(async (dir) => {
      const composable = JSON.parse(
        (await runCliIn(dir, "md", "query", "documents", "--where", "!has:h1", "-fj")).stdout,
      );
      const shortcut = JSON.parse((await runCliIn(dir, "md", "query", "missing-h1", "-fj")).stdout);
      expect(composable.results.map((r: { file: string }) => r.file)).toEqual(
        shortcut.results.map((r: { file: string }) => r.file),
      );
    });
  });

  it("filters, projects, and groups", async () => {
    await inWorkspace(async (dir) => {
      const links = JSON.parse(
        (
          await runCliIn(
            dir,
            "md",
            "query",
            "links",
            "--where",
            "links-to:b.md",
            "--select",
            "file,linkText",
            "-fj",
          )
        ).stdout,
      );
      expect(links.results).toEqual([{ file: expect.stringContaining("a.md"), linkText: "G" }]);

      const grouped = JSON.parse(
        (
          await runCliIn(
            dir,
            "md",
            "query",
            "tasks",
            "--where",
            "status=pending",
            "--group-by",
            "frontmatter.owner",
            "-fj",
          )
        ).stdout,
      );
      expect(grouped.groupBy).toBe("frontmatter.owner");
      expect(grouped.results.map((g: { key: string; count: number }) => [g.key, g.count])).toEqual([
        ["alice", 1],
        ["bob", 1],
      ]);
      expect(grouped.summary).toEqual({ matched: 2, groups: 2 });
    });
  });

  it("renders a table in llm format and names the plan when nothing matches", async () => {
    await inWorkspace(async (dir) => {
      const table = await runCliIn(
        dir,
        "md",
        "query",
        "headings",
        "--select",
        "text,depth",
        "--paths",
        "relative",
      );
      expect(table.stdout).toContain("text");
      expect(table.stdout).toContain("Sub");

      const empty = await runCliIn(
        dir,
        "md",
        "query",
        "documents",
        "--where",
        "frontmatter.owner=nobody",
      );
      expect(empty.exitCode).toBe(0);
      expect(empty.stdout).toContain("frontmatter.owner=nobody");
    });
  });

  it("exits 1 on every kind of typo rather than matching nothing", async () => {
    await inWorkspace(async (dir) => {
      const cases: Array<[string[], RegExp]> = [
        [["documents", "--where", "nope=1"], /Unknown field for documents: nope/],
        [["documents", "--select", "line"], /md query links --select file,line/],
        [["duplicates", "--where", "has:h1"], /does not support composable options/],
        [["missing-h1", "--where", "has:h1"], /md query documents --where '!has:h1'/],
        [["headings", "--where", "links-to:a.md"], /not available on headings/],
        [["tasks", "--where", "checked=maybe"], /boolean field/],
        [
          ["tasks", "--where", "status=pending", "--status", "done"],
          /--status belongs to a shortcut kind/,
        ],
      ];
      for (const [args, message] of cases) {
        const result = await runCliIn(dir, "md", "query", ...args);
        expect(result.exitCode, args.join(" ")).toBe(1);
        expect(result.stderr, args.join(" ")).toMatch(message);
        expect(result.stdout).toBe("");
      }
    });
  });

  it("refuses predicates set from project configuration", async () => {
    await inWorkspace(async (dir) => {
      // Predicates are per-question; a checked-in one would silently filter
      // every query anyone ran in the workspace.
      fs.writeFileSync(
        path.join(dir, ".cairn.yml"),
        "version: 1\ncommands:\n  query:\n    where: ['has:h1']\n",
      );
      const result = await runCliIn(dir, "md", "query", "tasks");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Unknown commands\.query key: where/);
    });
  });

  it("reports --where and --select as repeatable in describe", async () => {
    const result = await runCli("describe", "md", "query", "-fj");
    const options = JSON.parse(result.stdout).commands[0].options as Array<{
      flags: string;
      repeatable?: boolean;
    }>;
    const where = options.find((option) => option.flags.includes("--where"));
    expect(where?.repeatable).toBe(true);
  });
});
