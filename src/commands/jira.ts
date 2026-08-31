import fs from "node:fs";
import path from "node:path";
import { CommandExit, terminate } from "../command-result.js";
import { jsonPayload } from "../result.js";
import { BASE_FORMATS } from "../formats.js";
import type { OutputFormat } from "../types.js";
import { CODES, diagnostic } from "../jira/adf/diagnostics.js";
import { fromMarkdown } from "../jira/adf/from-markdown.js";
import { inspectAdf } from "../jira/adf/inspect.js";
import { parseAdfDocument, readInput } from "../jira/adf/read.js";
import { serializeAdf } from "../jira/adf/serialize.js";
import { toMarkdown } from "../jira/adf/to-markdown.js";
import { validateAdf } from "../jira/adf/validate.js";
import type {
  AdfCommand,
  AdfDocument,
  AdfResult,
  ConversionDiagnostic,
} from "../jira/adf/types.js";

export interface AdfOptions {
  format?: string;
  envelope?: boolean;
  output?: string;
  strict?: boolean;
}

/**
 * The exit rule, and it is deliberately not `hasFindings` from the agent
 * commands.
 *
 * That helper fails on any approximate mapping, which is right for
 * `agent convert` and wrong here: approximation is the *expected* outcome on
 * almost every real Jira description, so blocking on it would make a working
 * conversion indistinguishable from a broken one. An `error` blocks; an
 * approximation blocks only under `--strict` — the same split `agent audit` and
 * `agent test` apply.
 */
function blocking(diagnostics: ConversionDiagnostic[], strict: boolean): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.quality !== "exact"),
  );
}

function checkFormat(opts: AdfOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) throw new Error(`Invalid output format: ${format}`);
  return format;
}

/** Renders diagnostics for the human-facing streams. */
function formatDiagnostics(diagnostics: ConversionDiagnostic[]): string {
  const lines = ["diagnostics:"];
  for (const item of diagnostics)
    lines.push(
      `- ${item.severity} ${item.code} [${item.quality}]` +
        `${item.location ? ` ${item.location}` : ""}` +
        `${item.node ? ` (${item.node})` : ""}: ${item.message}` +
        `${item.remediation ? ` Remediation: ${item.remediation}` : ""}`,
    );
  return `${lines.join("\n")}\n`;
}

/**
 * Writes a result.
 *
 * The converted document owns stdout and diagnostics go to stderr, which is
 * unlike every `agent` subcommand and is the point: `cairn jira adf to-markdown - >
 * out.md` must not get findings spliced into the document. With `--format json`
 * the payload carries both and goes to stdout instead.
 */
function output(result: AdfResult, opts: AdfOptions, primary: string): void {
  const format = checkFormat(opts);
  result.ok = !blocking(result.diagnostics, Boolean(opts.strict));

  if (format === "json") {
    process.stdout.write(
      jsonPayload(`jira adf ${result.command}`, result, opts, {
        ok: result.ok,
        exitCode: result.ok ? 0 : 2,
      }),
    );
    if (!result.ok) terminate(2);
    return;
  }

  if (primary) process.stdout.write(primary);
  if (result.diagnostics.length) process.stderr.write(formatDiagnostics(result.diagnostics));
  if (!result.ok) terminate(2);
}

/**
 * Writes one file atomically: staged beside the destination with `wx`, then
 * renamed. The same pattern as `src/edit-plan.ts`; `src/agent/writer.ts` stages
 * whole artifact trees and is the wrong tool for a single file.
 */
function writeAtomically(destination: string, content: string): void {
  const resolved = path.resolve(destination);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())
    throw new Error(`--output is a directory: ${destination}`);
  const staged = `${resolved}.cairn-${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(staged, content, { encoding: "utf-8", flag: "wx" });
  try {
    fs.renameSync(staged, resolved);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

/**
 * Catches anything the actions did not expect and reports it in the caller's
 * chosen format, so a `--format json` consumer never receives a bare stack
 * trace on stderr. Mirrors `agentActionBoundary`.
 */
export async function adfActionBoundary(
  command: AdfCommand,
  opts: AdfOptions,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CommandExit) throw error;
    const message = (error as Error).message;
    if (opts.format === "json") {
      const result: AdfResult = {
        command,
        ok: false,
        source: "",
        diagnostics: [
          diagnostic({
            code: CODES.failure,
            severity: "error",
            quality: "unsupported",
            message,
            remediation: "Correct the invocation, paths, or filesystem condition and retry.",
          }),
        ],
      };
      process.stdout.write(
        jsonPayload(`jira adf ${command}`, result, opts, { ok: false, exitCode: 1 }),
      );
      terminate(1);
    }
    process.stderr.write(`Error: ${message}\n`);
    terminate(1);
  }
}

/** Reads and parses an ADF document, reporting a read or shape failure as exit 1. */
async function loadDocument(
  source: string,
  command: AdfCommand,
  opts: AdfOptions,
): Promise<AdfDocument> {
  const read = await readInput(source);
  if (!read.ok) return fail(command, source, opts, read.diagnostic);
  const parsed = parseAdfDocument(read.content, source);
  if (!parsed.ok) return fail(command, source, opts, parsed.diagnostic);
  return parsed.document;
}

function fail(
  command: AdfCommand,
  source: string,
  opts: AdfOptions,
  item: ConversionDiagnostic,
): never {
  const result: AdfResult = { command, ok: false, source, diagnostics: [item] };
  if (checkFormat(opts) === "json")
    process.stdout.write(
      jsonPayload(`jira adf ${command}`, result, opts, { ok: false, exitCode: 1 }),
    );
  else process.stderr.write(formatDiagnostics([item]));
  terminate(1);
}

export async function adfToMarkdownAction(source: string, opts: AdfOptions): Promise<void> {
  const document = await loadDocument(source, "to-markdown", opts);
  const { markdown, diagnostics } = toMarkdown(document);
  const result: AdfResult = {
    command: "to-markdown",
    ok: true,
    source,
    markdown,
    ...(opts.output ? { output: path.resolve(opts.output) } : {}),
    diagnostics,
  };
  if (opts.output) writeAtomically(opts.output, markdown);
  output(result, opts, opts.output ? "" : markdown);
}

export async function adfFromMarkdownAction(source: string, opts: AdfOptions): Promise<void> {
  const read = await readInput(source);
  if (!read.ok) fail("from-markdown", source, opts, read.diagnostic);
  const { document, diagnostics } = fromMarkdown(read.content);
  const serialized = serializeAdf(document);
  const result: AdfResult = {
    command: "from-markdown",
    ok: true,
    source,
    adf: document,
    ...(opts.output ? { output: path.resolve(opts.output) } : {}),
    diagnostics,
  };
  if (opts.output) writeAtomically(opts.output, serialized);
  output(result, opts, opts.output ? "" : serialized);
}

export async function adfValidateAction(source: string, opts: AdfOptions): Promise<void> {
  const document = await loadDocument(source, "validate", opts);
  const { diagnostics } = validateAdf(document);
  const result: AdfResult = { command: "validate", ok: true, source, diagnostics };
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const summary = errors
    ? `invalid: ${errors} error(s) in ${source}\n`
    : `valid: no structural errors in ${source}\n`;
  output(result, opts, summary);
}

export async function adfInspectAction(source: string, opts: AdfOptions): Promise<void> {
  const document = await loadDocument(source, "inspect", opts);
  const inventory = inspectAdf(document);
  const result: AdfResult = { command: "inspect", ok: true, source, inventory, diagnostics: [] };
  const width = Math.max(4, ...inventory.map((entry) => entry.type.length));
  const lines = inventory.map(
    (entry) =>
      `${entry.type.padEnd(width)}  ${entry.kind.padEnd(4)}  ${String(entry.count).padStart(4)}  ` +
      `${entry.quality.padEnd(11)}  ${entry.note}`,
  );
  output(result, opts, `${lines.join("\n")}\n`);
}
