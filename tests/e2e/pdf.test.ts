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

const COMMANDS = [
  "inspect",
  "text",
  "outline",
  "validate",
  "to-markdown",
  "attachments",
  "forms",
] as const;

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

  it("is described with seven experimental subcommands on one schema", async () => {
    const described = JSON.parse((await run("describe", "-fj")).stdout) as {
      commands: { id: string; stability: string; outputSchema: string }[];
    };
    const rows = described.commands.filter((row) => row.id.startsWith("pdf "));
    expect(rows.map((row) => row.id).sort()).toEqual([
      "pdf attachments",
      "pdf forms",
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

describe("pdf attachments", () => {
  it("lists embedded files with their size and hash", async () => {
    const file = fixture("attached");
    const result = await run("pdf", "attachments", file, "-fj");
    expect(result.exitCode).toBe(0);
    // Validated here as well as in the cross-command loop, which only ever sees
    // a document with no attachments: an empty array exercises none of the shape.
    const payload = JSON.parse(result.stdout) as {
      attachments: { id: string; filename: string; rawFilename: string; sha256?: string }[];
    };
    validate("pdf-result", payload, "pdf attachments (populated)");
    expect(payload.attachments.map((item) => item.filename)).toEqual(["data.csv", "evil.csv"]);
    for (const item of payload.attachments) expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports the raw stored name beside the one it would write", async () => {
    // The whole point of carrying both: a rename has to be visible in the
    // payload, or a caller cannot tell a sanitized name from an authored one.
    const file = fixture("attached");
    const payload = JSON.parse((await run("pdf", "attachments", file, "-fj")).stdout) as {
      attachments: { filename: string; rawFilename: string }[];
    };
    const escaped = payload.attachments.find((item) => item.filename === "evil.csv");
    expect(escaped?.rawFilename).toBe("../../etc/evil.csv");
  });

  it("writes nothing without --extract", async () => {
    const file = fixture("attached");
    const out = workspace();
    await run("pdf", "attachments", file);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it("extracts into a directory and never outside it", async () => {
    const file = fixture("attached");
    const out = path.join(workspace(), "out");
    // A sanitized name is reported, not fatal: the extraction succeeded and the
    // traversal was contained. --strict is what turns it into a CI signal.
    const result = await run("pdf", "attachments", file, "--extract", out, "-fj");
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      attachments: { filename: string; written?: string }[];
      diagnostics: { code: string }[];
    };
    expect(fs.readdirSync(out).sort()).toEqual(["data.csv", "evil.csv"]);
    for (const item of payload.attachments) expect(item.written).toContain(out);
    expect(payload.diagnostics.map((item) => item.code)).toContain("AP301");

    // The traversal never escaped: nothing was written above the target.
    expect(fs.existsSync(path.join(out, "..", "..", "etc", "evil.csv"))).toBe(false);
  });

  it("blocks on a sanitized name under --strict", async () => {
    const out = path.join(workspace(), "out");
    const result = await run(
      "pdf",
      "attachments",
      fixture("attached"),
      "--extract",
      out,
      "--strict",
      "-fj",
    );
    expect(result.exitCode).toBe(2);
  });

  it("writes the embedded bytes unchanged", async () => {
    const file = fixture("attached");
    const out = path.join(workspace(), "out");
    await run("pdf", "attachments", file, "--extract", out);
    expect(fs.readFileSync(path.join(out, "data.csv"), "utf8")).toBe("hello,world\n1,2\n");
  });

  it("never overwrites an existing file, and says what it wrote instead", async () => {
    const file = fixture("attached");
    const out = path.join(workspace(), "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "data.csv"), "do not clobber me");

    const result = await run("pdf", "attachments", file, "--extract", out, "-fj");
    expect(fs.readFileSync(path.join(out, "data.csv"), "utf8")).toBe("do not clobber me");
    expect(fs.existsSync(path.join(out, "data-2.csv"))).toBe(true);

    const payload = JSON.parse(result.stdout) as { diagnostics: { code: string }[] };
    expect(payload.diagnostics.map((item) => item.code)).toContain("AP302");
  });

  it("reports no embedded files as an answer, not a failure", async () => {
    const result = await run("pdf", "attachments", fixture("minimal"), "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { attachments: unknown[] };
    expect(payload.attachments).toEqual([]);
  });
});

describe("pdf forms", () => {
  it("reads field names, types, and current values", async () => {
    const result = await run("pdf", "forms", fixture("formFilled"), "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      form: { type: string; fieldCount: number; fields: Record<string, unknown>[] };
    };
    validate("pdf-result", payload, "pdf forms (populated)");
    expect(payload.form.type).toBe("acroform");
    expect(payload.form.fields.map((field) => field.name)).toEqual([
      "agree",
      "fullName",
      "internal",
      "reference",
    ]);
    const name = payload.form.fields.find((field) => field.name === "fullName");
    expect(name).toMatchObject({ type: "text", value: "Ada Lovelace", page: 1, charLimit: 64 });
  });

  it("reports a field's page 1-based, matching every other page number here", async () => {
    // pdf.js reports it 0-based; getting this wrong reads correctly in every
    // test written against the wrong value, so it is asserted on its own.
    const payload = JSON.parse(
      (await run("pdf", "forms", fixture("formFilled"), "-fj")).stdout,
    ) as {
      form: { fields: { page: number }[] };
    };
    for (const field of payload.form.fields) expect(field.page).toBe(1);
  });

  it("carries the read-only and hidden flags", async () => {
    const payload = JSON.parse(
      (await run("pdf", "forms", fixture("formFilled"), "-fj")).stdout,
    ) as {
      form: { fields: Record<string, unknown>[] };
    };
    expect(payload.form.fields.find((f) => f.name === "reference")).toMatchObject({
      readOnly: true,
    });
    expect(payload.form.fields.find((f) => f.name === "internal")).toMatchObject({ hidden: true });
  });

  it("keeps a field that resolves to no page, and says so", async () => {
    const result = await run("pdf", "forms", fixture("formOrphan"), "-fj");
    const payload = JSON.parse(result.stdout) as {
      form: { fields: { name: string; page: number | null }[] };
      diagnostics: { code: string }[];
    };
    expect(payload.form.fields[0]).toMatchObject({ name: "orphan", page: null });
    expect(payload.diagnostics.map((item) => item.code)).toContain("AP312");
  });

  it("reports a document with no form as an answer, not a failure", async () => {
    const result = await run("pdf", "forms", fixture("minimal"), "-fj");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { form: { type: string; fieldCount: number } };
    expect(payload.form).toMatchObject({ type: "none", fieldCount: 0 });
  });
});
