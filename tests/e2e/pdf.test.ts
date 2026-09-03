import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";
import { pdfFixture } from "../helpers/pdf-fixture.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
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

/** A PDF arrives on stdin as bytes, so the writer sends a Buffer, not a string. */
function pipe(input: Buffer, ...args: string[]): Promise<Run> {
  const child = spawn("node", [cli, ...args], { env: { ...process.env, CI: "1" } });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

const temporary: string[] = [];

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

function fixture(key: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-e2e-"));
  temporary.push(root);
  const file = path.join(root, `${key}.pdf`);
  fs.writeFileSync(file, pdfFixture(key));
  return file;
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-e2e-"));
  temporary.push(root);
  return root;
}

function validate(id: string, payload: unknown, label: string): void {
  const entry = SCHEMA_BY_ID.get(id);
  if (!entry) throw new Error(`no such schema: ${id}`);
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const check = ajv.compile(entry.schema);
  if (!check(payload))
    throw new Error(`${label} failed ${id}: ${JSON.stringify(check.errors?.slice(0, 3))}`);
}

const COMMANDS = ["inspect", "text", "outline", "validate", "to-markdown"] as const;

describe("pdf, across every subcommand", () => {
  it("succeeds and validates against the published schema", async () => {
    const file = fixture("structured");
    for (const command of COMMANDS) {
      const result = await run("pdf", command, file, "-fj");
      expect(result.exitCode, command).toBe(0);
      const payload = JSON.parse(result.stdout);
      validate("pdf-result", payload, `pdf ${command}`);
      expect(payload.command, command).toBe(command);
      expect(payload.ok, command).toBe(true);
    }
  });

  it("carries `document` on every payload", async () => {
    // The divergence from adf-result, where the inventory is inspect-only: a
    // conversion from a tagged document and one from a scan must not look
    // identical, so `jq .document.tagged` has to work on any of them.
    const file = fixture("tagged");
    for (const command of COMMANDS) {
      const payload = JSON.parse((await run("pdf", command, file, "-fj")).stdout);
      expect(payload.document, command).toBeDefined();
      expect(payload.document.pageCount, command).toBe(1);
      expect(payload.document.tagged, command).toBe(true);
    }
  });

  it("writes nothing to stderr on a clean run", async () => {
    // The pdf.js console capture is what makes this true, and it is the piece
    // most likely to regress silently: pdf.js routes its warnings to
    // console.warn, which is stderr, which is this toolset's findings stream.
    const file = fixture("minimal");
    for (const command of COMMANDS) {
      const result = await run("pdf", command, file, "-fj");
      expect(result.stderr, command).toBe("");
    }
  });

  it("wraps every payload with --envelope", async () => {
    const file = fixture("minimal");
    for (const command of COMMANDS) {
      const result = await run("pdf", command, file, "-fj", "--envelope");
      const envelope = JSON.parse(result.stdout);
      validate("envelope", envelope, `pdf ${command} envelope`);
      expect(envelope.command, command).toBe(`pdf ${command}`);
      expect(envelope.schema, command).toContain("/v1/pdf-result.json");
      validate("pdf-result", envelope.data, `pdf ${command} data`);
    }
  });

  it("rejects an unsupported format and --envelope without json", async () => {
    const file = fixture("minimal");
    const bad = await run("pdf", "inspect", file, "--format", "sarif");
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/Invalid output format/);

    const envelope = await run("pdf", "inspect", file, "--envelope");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.stderr).toMatch(/--envelope requires --format json/);
  });

  it("is described with five experimental subcommands on one schema", async () => {
    const described = JSON.parse((await run("describe", "-fj")).stdout) as {
      commands: { id: string; stability: string; outputSchema: string }[];
    };
    const rows = described.commands.filter((row) => row.id.startsWith("pdf "));
    expect(rows.map((row) => row.id).sort()).toEqual([
      "pdf inspect",
      "pdf outline",
      "pdf text",
      "pdf to-markdown",
      "pdf validate",
    ]);
    for (const row of rows) {
      expect(row.stability, row.id).toBe("experimental");
      expect(row.outputSchema, row.id).toBe("pdf-result");
    }
  });

  it("publishes pdf-result through `schema`", async () => {
    const result = await run("schema", "pdf-result");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).$id).toContain("/v1/pdf-result.json");
  });
});

describe("pdf input handling", () => {
  it("refuses a file that is not a PDF, naming the bytes it saw", async () => {
    const result = await run("pdf", "inspect", fixture("notAPdf"), "-fj");
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    // The failure form goes to stdout, not stderr, and is schema-valid.
    validate("pdf-result", payload, "failure form");
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics[0].code).toBe("AP002");
  });

  it("refuses a missing file, a directory, and an oversized one", async () => {
    const root = workspace();
    for (const [args, code] of [
      [["pdf", "inspect", path.join(root, "absent.pdf"), "-fj"], "AP004"],
      [["pdf", "inspect", root, "-fj"], "AP004"],
      [["pdf", "inspect", fixture("minimal"), "--max-bytes", "64", "-fj"], "AP003"],
    ] as const) {
      const result = await run(...args);
      expect(result.exitCode, code).toBe(1);
      expect(JSON.parse(result.stdout).diagnostics[0].code, code).toBe(code);
    }
  });

  it("reads a PDF from stdin", async () => {
    const result = await pipe(pdfFixture("minimal"), "pdf", "inspect", "-", "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.source).toBe("-");
    expect(payload.document.pageCount).toBe(1);
  });

  it("does not hang on a FIFO", async () => {
    const root = workspace();
    const fifo = path.join(root, "pipe.pdf");
    await exec("mkfifo", [fifo]);
    const result = await run("pdf", "inspect", fifo, "-fj");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("AP004");
  }, 20_000);
});

describe("pdf inspect", () => {
  it("classifies each page and publishes the evidence behind the label", async () => {
    const payload = JSON.parse((await run("pdf", "inspect", fixture("structured"), "-fj")).stdout);
    expect(payload.pages).toHaveLength(4);
    for (const page of payload.pages) {
      expect(page).toHaveProperty("characters");
      expect(page).toHaveProperty("density");
      expect(["present", "sparse", "absent"]).toContain(page.textLayer);
    }
  });

  it("reports an image-only page as absent, with the OCR remediation", async () => {
    const result = await run("pdf", "inspect", fixture("noTextLayer"), "-fj");
    const payload = JSON.parse(result.stdout);
    expect(payload.pages[0].textLayer).toBe("absent");
    expect(payload.pages[0].characters).toBe(0);
    const finding = payload.diagnostics.find((item: { code: string }) => item.code === "AP050");
    expect(finding.remediation).toMatch(/OCR/);
  });

  it("distinguishes a tagging claim from a measured structure tree", async () => {
    const tagged = JSON.parse((await run("pdf", "inspect", fixture("tagged"), "-fj")).stdout);
    expect(tagged.document.tagged).toBe(true);
    expect(tagged.document.structured).toBe("struct");

    const plain = JSON.parse((await run("pdf", "inspect", fixture("structured"), "-fj")).stdout);
    expect(plain.document.tagged).toBe(false);
    expect(plain.document.structured).toBe("none");
  });
});

describe("pdf text", () => {
  it("selects pages and reports the selection", async () => {
    const result = await run("pdf", "text", fixture("manyPages"), "--pages", "3,1,2-2", "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.selectedPages).toEqual([1, 2, 3]);
    expect(payload.text.map((page: { page: number }) => page.page)).toEqual([1, 2, 3]);
  });

  it("refuses a page outside the document", async () => {
    const result = await run("pdf", "text", fixture("minimal"), "--pages", "5-9", "-fj");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("AP013");
  });

  it("separates pages with a form feed on stdout", async () => {
    const result = await run("pdf", "text", fixture("manyPages"), "--pages", "1,2");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\f");
    expect(result.stdout).toContain("This is page 1.");
    expect(result.stdout).toContain("This is page 2.");
  });

  it("blocks on a page with no text layer only under --strict", async () => {
    const file = fixture("noTextLayer");
    expect((await run("pdf", "text", file)).exitCode).toBe(0);
    const strict = await run("pdf", "text", file, "--strict");
    expect(strict.exitCode).toBe(2);
    expect(strict.stderr).toContain("AP050");
  });
});

describe("pdf outline", () => {
  it("reads the declared tree and keeps an unresolvable entry", async () => {
    const result = await run("pdf", "outline", fixture("outlined"), "-fj");
    const payload = JSON.parse(result.stdout);
    expect(payload.outline.map((entry: { title: string }) => entry.title)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Dangling",
    ]);
    expect(payload.outline[0].children[0].title).toBe("Section 1.1");
    expect(payload.outline[0].page).toBe(1);
    // Kept with a null page rather than dropped, and the finding names it.
    expect(payload.outline[2].page).toBeNull();
    expect(payload.diagnostics.some((item: { code: string }) => item.code === "AP080")).toBe(true);
  });

  it("returns an empty tree and exits 0 when there is no outline", async () => {
    const result = await run("pdf", "outline", fixture("minimal"), "-fj");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).outline).toEqual([]);
  });
});

describe("pdf validate", () => {
  it("passes a clean document", async () => {
    const result = await run("pdf", "validate", fixture("minimal"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^valid:/);
  });

  it("reports a rebuilt cross-reference table without calling it unreadable", async () => {
    const result = await run("pdf", "validate", fixture("damagedXref"), "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.diagnostics.some((item: { code: string }) => item.code === "AP101")).toBe(true);
    expect(payload.ok).toBe(true);
  });

  it("blocks on a rebuilt table under --strict", async () => {
    expect((await run("pdf", "validate", fixture("damagedXref"), "--strict")).exitCode).toBe(2);
  });

  it("reports an unreadable page as an error", async () => {
    const result = await run("pdf", "validate", fixture("pageTreeCycle"), "-fj");
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout);
    const finding = payload.diagnostics.find((item: { code: string }) => item.code === "AP020");
    expect(finding.severity).toBe("error");
    expect(finding.message).toMatch(/circular reference/i);
  });
});

describe("pdf to-markdown", () => {
  it("uses the structure tree when there is one", async () => {
    const result = await run("pdf", "to-markdown", fixture("tagged"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "# Introduction\n\nThe quarter closed ahead of plan.\n\nA second paragraph begins here.\n",
    );
    expect(result.stderr).toContain("AP200");
    expect(result.stderr).toContain("structure tree");
  });

  it("infers structure geometrically when there is not", async () => {
    const result = await run("pdf", "to-markdown", fixture("structured"));
    expect(result.exitCode).toBe(0);
    // Heading levels ranked by size, running header and footer dropped,
    // hyphenation rejoined, list markers consumed, paragraphs split on leading.
    expect(result.stdout).toContain("# Introduction\n");
    expect(result.stdout).toContain("## Findings\n");
    expect(result.stdout).toContain("Revenue rose");
    expect(result.stdout).toContain("- The first finding");
    expect(result.stdout).not.toContain("Quarterly Report");
    expect(result.stdout).not.toContain("Page 1 of 4");
    expect(result.stdout).not.toContain("- • ");
  });

  it("always reports which path each page took", async () => {
    for (const [key, phrase] of [
      ["tagged", "structure tree"],
      ["structured", "geometry"],
    ] as const) {
      const result = await run("pdf", "to-markdown", fixture(key), "-fj");
      const payload = JSON.parse(result.stdout);
      const path200 = payload.diagnostics.find((item: { code: string }) => item.code === "AP200");
      expect(path200, key).toBeDefined();
      expect(path200.severity, key).toBe("notice");
      expect(path200.message, key).toContain(phrase);
    }
  });

  it("blocks an inferred conversion under --strict but not a tagged one", async () => {
    // The reason AP200 is a notice: if "this page was untagged" blocked on its
    // own, --strict would refuse essentially every real PDF and mean nothing.
    expect((await run("pdf", "to-markdown", fixture("structured"))).exitCode).toBe(0);
    expect((await run("pdf", "to-markdown", fixture("structured"), "--strict")).exitCode).toBe(2);
    expect((await run("pdf", "to-markdown", fixture("tagged"), "--strict")).exitCode).toBe(0);
  });

  it("keeps the document on stdout and findings on stderr", async () => {
    const result = await run("pdf", "to-markdown", fixture("structured"));
    expect(result.stdout).not.toContain("diagnostics:");
    expect(result.stdout).not.toContain("AP200");
    expect(result.stderr).toContain("diagnostics:");
  });

  it("writes to --output and leaves stdout empty", async () => {
    const root = workspace();
    const destination = path.join(root, "out", "report.md");
    const result = await run(
      "pdf",
      "to-markdown",
      fixture("tagged"),
      "--output",
      destination,
      "-fj",
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.output).toBe(destination);
    expect(fs.readFileSync(destination, "utf8")).toContain("# Introduction");
  });

  it("refuses a directory as --output", async () => {
    const result = await run("pdf", "to-markdown", fixture("minimal"), "--output", workspace());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--output is a directory/);
  });

  it("emits a page subset without changing what the inference saw", async () => {
    const file = fixture("structured");
    const full = await run("pdf", "to-markdown", file);
    const subset = await run("pdf", "to-markdown", file, "--pages", "2", "-fj");
    const payload = JSON.parse(subset.stdout);
    expect(payload.selectedPages).toEqual([2]);
    expect(payload.diagnostics.some((item: { code: string }) => item.code === "AP208")).toBe(true);
    // A true subset: the heading kept the level the whole-document ranking gave
    // it, rather than being re-ranked as the largest thing on its own page.
    expect(payload.markdown).toContain("## Findings");
    expect(full.stdout).toContain("## Findings");
  });

  it("produces Markdown that lints clean where it lands", async () => {
    const root = workspace();
    const destination = path.join(root, "report.md");
    await run("pdf", "to-markdown", fixture("structured"), "--output", destination);
    const lint = await run("md", "lint", destination, "--style");
    expect(lint.exitCode, lint.stdout + lint.stderr).toBe(0);
  });
});
