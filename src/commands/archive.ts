import os from "node:os";
import path from "node:path";
import { terminate } from "../command-result.js";
import { BASE_FORMATS } from "../formats.js";
import type { OutputFormat } from "../types.js";
import { jsonPayload } from "../result.js";
import { closeQuietly } from "../sqlite-store.js";
import { LATEST_VERSION, getArchiveRoot, openArchive, segmentsDirectory } from "../archive/db.js";
import { archiveStatus, extract, listArtifacts, resolve, verify } from "../archive/query.js";
import { DEFAULT_SEGMENT_BYTES } from "../archive/segments.js";
import { ARTIFACT_CLASSES, parseClasses } from "../archive/sets.js";
import { runArchive } from "../archive/run.js";
import { DEFAULT_PROVIDER, resolveProviders } from "../usage/providers/index.js";
import type { UsageProvider } from "../usage/providers/types.js";

/**
 * The `archive` toolset.
 *
 * Long-term storage for what a coding assistant leaves behind: plans, the files
 * tools produced, and optionally the transcripts and logs. Everything that
 * decides *what* is archived is data in `src/archive/sets.ts`; nothing here
 * branches on a provider name.
 *
 * Formats are validated inline rather than through `commandOptions`, and
 * `archive` is deliberately absent from `COMMAND_OPTIONS` for the same reason
 * `usage` and `scripts` are: it reads outside the workspace entirely and writes
 * to a location the user chooses, so a checked-in configuration file has no
 * business steering it.
 */

export interface ArchiveOptions {
  format?: string;
  envelope?: boolean;
  provider?: string;
  /** Where the archive lives. */
  archive?: string;
  /** `--logs`, forwarded to provider discovery. */
  logs?: string;
  /** `archive run`. */
  include?: string;
  dryRun?: boolean;
  segmentSize?: string;
  /** `archive list`. */
  class?: string;
  since?: string;
  top?: string;
  /** `archive extract`. */
  out?: string;
  /** `archive verify`. */
  deep?: boolean;
  /** `archive migrate`. */
  check?: boolean;
}

function resolveFormat(opts: ArchiveOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) {
    throw new Error(`Invalid output format: ${String(opts.format)}`);
  }
  if (opts.envelope && format !== "json") {
    throw new Error("--envelope requires --format json");
  }
  return format;
}

function archiveRoot(opts: ArchiveOptions): string {
  return opts.archive ? path.resolve(opts.archive) : getArchiveRoot();
}

/** Providers that actually have logs on this machine, with their roots. */
function sourcesFor(opts: ArchiveOptions): Array<{ provider: UsageProvider; root: string }> {
  const providers = resolveProviders(opts.provider);
  if (opts.logs && providers.length > 1) {
    throw new Error("--logs applies to a single provider; name one with --provider");
  }
  const sources: Array<{ provider: UsageProvider; root: string }> = [];
  for (const provider of providers) {
    const root = provider.root({
      env: process.env,
      home: os.homedir(),
      ...(opts.logs ? { override: opts.logs } : {}),
    });
    if (root) sources.push({ provider, root });
  }
  return sources;
}

function positive(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${value} (expected a positive number)`);
  }
  return parsed;
}

// Styling, matching src/commands/usage.ts so the two toolsets read alike.
const BOLD = "1";
const DIM = "2";
const CYAN = "36";
const RESET = "[0m";

function style(text: string, code: string, human: boolean): string {
  return human ? `[${code}m${text}${RESET}` : text;
}

/** Human output abbreviates; llm output stays exact so a consumer can do arithmetic. */
function bytes(value: number, human: boolean): string {
  if (!human) return String(value);
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function write(lines: string[], exitCode: 0 | 2): void {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(lines.join("\n") + "\n");
  if (exitCode !== 0) terminate(exitCode);
}

// ---------------------------------------------------------------------------
// archive run
// ---------------------------------------------------------------------------

export async function archiveRunAction(opts: ArchiveOptions): Promise<void> {
  const format = resolveFormat(opts);
  const classes = parseClasses(opts.include);
  const root = archiveRoot(opts);
  const sources = sourcesFor(opts);
  if (sources.length === 0) throw new Error("No provider logs found on this machine");

  const result = await runArchive({
    archiveRoot: root,
    sources,
    classes,
    ...(opts.dryRun ? { dryRun: true } : {}),
    segmentBytes: positive(opts.segmentSize, "--segment-size", DEFAULT_SEGMENT_BYTES),
  });

  // An unreadable file is reported, never fatal: over thousands of artifacts a
  // file removed mid-walk is routine, and the rest of the run is still good.
  const exitCode = 0;
  const payload = {
    provider: opts.provider ?? DEFAULT_PROVIDER,
    action: (opts.dryRun ? "dry-run" : "run") as "run" | "dry-run",
    archive: { root, ...(opts.dryRun ? {} : archiveStatus(root)) },
    include: classes,
    sources: sources.map((source) => ({ provider: source.provider.name, root: source.root })),
    run: { ...result.counters, failures: result.failures },
    segments: result.segments,
    byClass: result.byClass,
  };

  if (format === "json") {
    process.stdout.write(
      jsonPayload("archive run", payload, opts, {
        summary: { stored: result.counters.stored, bytes: result.counters.bytes },
      }),
    );
    return;
  }

  const human = format === "human";
  const lines = [`${style("archive", BOLD, human)}  ${style(root, CYAN, human)}`];
  for (const name of ARTIFACT_CLASSES) {
    const entry = result.byClass[name];
    if (!entry) continue;
    lines.push(
      `  ${name.padEnd(11)} ${String(entry.discovered).padStart(6)} found  ` +
        `${String(entry.stored).padStart(6)} stored  ${bytes(entry.bytes, human)}`,
    );
  }
  const c = result.counters;
  lines.push(
    opts.dryRun
      ? `would store: ${c.discovered} artifacts, ${bytes(c.bytes, human)} bytes`
      : `stored: ${c.stored} new, ${c.duplicate} already held, ${c.unchanged} unchanged` +
          (c.skipped > 0 ? `, ${c.skipped} unreadable` : ""),
  );
  if (result.segments.length > 0) {
    lines.push(
      style(
        `segments: ${result.segments.map((s) => `${s.name} (${bytes(s.bytes, human)})`).join(", ")}`,
        DIM,
        human,
      ),
    );
  }
  write(lines, exitCode);
}

// ---------------------------------------------------------------------------
// archive status
// ---------------------------------------------------------------------------

export async function archiveStatusAction(opts: ArchiveOptions): Promise<void> {
  const format = resolveFormat(opts);
  const root = archiveRoot(opts);
  const status = archiveStatus(root);

  if (format === "json") {
    process.stdout.write(
      jsonPayload("archive status", { action: "status", archive: status }, opts, {
        summary: { artifacts: status.artifacts, segments: status.segments },
      }),
    );
    return;
  }

  const human = format === "human";
  const lines = [`${style("archive", BOLD, human)}  ${style(root, CYAN, human)}`];
  lines.push(`  present:    ${status.present ? "yes" : "no"}`);
  lines.push(`  schema:     v${status.schemaVersion}`);
  lines.push(`  segments:   ${status.segments}`);
  lines.push(`  blobs:      ${status.blobs}`);
  lines.push(`  artifacts:  ${status.artifacts} across ${status.paths} paths`);
  lines.push(`  content:    ${bytes(status.bytes, human)} bytes`);
  lines.push(`  on disk:    ${bytes(status.compressedBytes, human)} bytes`);
  lines.push(`  updated:    ${status.updatedAt ?? "never"}`);
  for (const [name, entry] of Object.entries(status.byClass)) {
    lines.push(`  ${name.padEnd(11)} ${entry.artifacts} artifacts, ${bytes(entry.bytes, human)}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// archive list
// ---------------------------------------------------------------------------

export async function archiveListAction(opts: ArchiveOptions): Promise<void> {
  const format = resolveFormat(opts);
  const root = archiveRoot(opts);
  const status = archiveStatus(root);
  const top = Math.max(0, Number(opts.top ?? "20"));

  if (opts.class && !ARTIFACT_CLASSES.includes(opts.class as never)) {
    throw new Error(
      `Invalid --class value: ${opts.class} (expected ${ARTIFACT_CLASSES.join(", ")})`,
    );
  }

  let rows: ReturnType<typeof listArtifacts> = [];
  if (status.present) {
    const opened = openArchive({ root, readOnly: true, migrate: false });
    try {
      rows = listArtifacts(opened.db, {
        ...(opts.provider && opts.provider !== "all"
          ? { providers: resolveProviders(opts.provider).map((p) => p.name) }
          : {}),
        ...(opts.class ? { class: opts.class } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        ...(top > 0 ? { limit: top } : {}),
      });
    } finally {
      closeQuietly(opened.db);
    }
  }

  if (format === "json") {
    process.stdout.write(
      jsonPayload("archive list", { action: "list", archive: status, files: rows }, opts, {
        summary: { files: rows.length },
      }),
    );
    return;
  }

  const human = format === "human";
  if (rows.length === 0) {
    process.stdout.write(status.present ? "No matching artifacts.\n" : "No archive yet.\n");
    return;
  }
  const lines = rows.map(
    (row) =>
      `${row.class.padEnd(11)} ${bytes(row.size, human).padStart(8)}  ${row.sha256.slice(0, 12)}  ` +
      `${row.path}${row.versions > 1 ? style(` (${row.versions} versions)`, DIM, human) : ""}`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// archive extract
// ---------------------------------------------------------------------------

export async function archiveExtractAction(target: string, opts: ArchiveOptions): Promise<void> {
  const format = resolveFormat(opts);
  const root = archiveRoot(opts);
  const outDir = path.resolve(opts.out ?? ".");

  const status = archiveStatus(root);
  if (!status.present) throw new Error(`No archive at ${root}`);

  const opened = openArchive({ root, readOnly: true, migrate: false });
  let extracted;
  try {
    const found = resolve(opened.db, target);
    if (found.length === 0) throw new Error(`Nothing in the archive matches: ${target}`);
    if (found.length > 1) {
      throw new Error(
        `Ambiguous: ${target} matches ${found.length} blobs (${found
          .map((blob) => blob.sha256.slice(0, 12))
          .join(", ")})`,
      );
    }
    extracted = extract(root, found[0], outDir);
  } finally {
    closeQuietly(opened.db);
  }

  if (format === "json") {
    process.stdout.write(
      jsonPayload("archive extract", { action: "extract", archive: status, extracted }, opts, {
        summary: { bytes: extracted.bytes },
      }),
    );
    return;
  }
  const human = format === "human";
  process.stdout.write(
    `${extracted.written}  ${bytes(extracted.bytes, human)} bytes  ${extracted.sha256.slice(0, 12)}\n`,
  );
}

// ---------------------------------------------------------------------------
// archive verify
// ---------------------------------------------------------------------------

export async function archiveVerifyAction(opts: ArchiveOptions): Promise<void> {
  const format = resolveFormat(opts);
  const root = archiveRoot(opts);
  const status = archiveStatus(root);
  const result = verify(root, opts.deep === true);
  // Corruption is exactly the actionable finding this command exists to report.
  const exitCode: 0 | 2 = result.findings.length > 0 ? 2 : 0;

  const payload = { action: "verify" as const, archive: status, verify: result };
  if (format === "json") {
    const output = jsonPayload("archive verify", payload, opts, {
      exitCode,
      summary: { findings: result.findings.length, segments: result.segments },
    });
    (exitCode === 0 ? process.stdout : process.stderr).write(output);
    if (exitCode !== 0) terminate(exitCode);
    return;
  }

  const human = format === "human";
  const lines = result.findings.map(
    (finding) => `${style(finding.segment, BOLD, human)}: ${finding.issue}`,
  );
  lines.push(
    `${result.checked}/${result.segments} segments verified` +
      (result.deep ? `, ${result.blobs} blobs re-hashed` : "") +
      (result.findings.length > 0 ? `, ${result.findings.length} problem(s)` : ""),
  );
  write(lines, exitCode);
}

// ---------------------------------------------------------------------------
// archive migrate
// ---------------------------------------------------------------------------

export async function archiveMigrateAction(opts: ArchiveOptions): Promise<void> {
  const format = resolveFormat(opts);
  const root = archiveRoot(opts);
  const check = opts.check === true;

  const opened = openArchive({ root, ...(check ? { migrate: false } : {}) });
  const { from, to, applied } = opened;
  closeQuietly(opened.db);

  const pending = check && from < LATEST_VERSION ? [LATEST_VERSION] : [];
  const payload = {
    action: "migrate" as const,
    archive: archiveStatus(root),
    migrations: { from, to, applied, pending },
  };

  if (format === "json") {
    process.stdout.write(
      jsonPayload("archive migrate", payload, opts, {
        summary: { applied: applied.length, pending: pending.length },
      }),
    );
    return;
  }

  const human = format === "human";
  const lines = [
    `${style("archive", BOLD, human)}  ${style(segmentsDirectory(root), CYAN, human)}`,
  ];
  lines.push(`  schema:   v${to}`);
  lines.push(`  latest:   v${LATEST_VERSION}`);
  if (applied.length > 0) lines.push(`  applied:  ${applied.map((v) => `v${v}`).join(", ")}`);
  else if (pending.length > 0) lines.push(`  pending:  ${pending.map((v) => `v${v}`).join(", ")}`);
  else lines.push("  pending:  none");
  process.stdout.write(lines.join("\n") + "\n");
}
