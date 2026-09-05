import { CONFIG_FILENAME, selectConfig } from "../config.js";
import type { ConfigSelection } from "../config.js";
import { CommandExit, terminate } from "../command-result.js";
import { BASE_FORMATS } from "../formats.js";
import { jsonPayload } from "../result.js";
import { executeScript, exitStatusFor } from "../scripts/execute.js";
import { listScripts, resolveScript, shadowingFailure } from "../scripts/resolve.js";
import type { ConsultedFile, ScriptResolution } from "../scripts/resolve.js";
import type { OutputFormat } from "../types.js";

export interface ScriptsOptions {
  format?: string;
  envelope?: boolean;
  root?: string;
  config?: string | boolean;
}

export interface ScriptRunOptions extends ScriptsOptions {
  /**
   * Exit 0 whatever happened. For inline use inside a skill document, where the
   * loader reads any non-zero status as a failure to load and a script whose code
   * carries meaning would keep the skill from loading at all. It changes only this
   * process's status: the script's real code stays in `exit.status`.
   */
  ignoreExitCode?: boolean;
}

/**
 * Formats are validated here rather than through `commandOptions`, which is keyed
 * on bare `md` subcommand names and whose error text says `md <command>`. The
 * `agent` subcommands validate inline for the same reason.
 *
 * `scripts` commands are also deliberately absent from `COMMAND_OPTIONS`: a
 * checked-in configuration file must never be able to change what executes, the
 * same rule that keeps `--write` out of the configurable set for `md fix`.
 */
function resolveFormat(opts: ScriptsOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) {
    throw new Error(`Invalid output format: ${String(opts.format)}`);
  }
  if (opts.envelope && format !== "json") {
    throw new Error("--envelope requires --format json");
  }
  return format;
}

/**
 * `--config` and `--no-config` are read from argv rather than from commander,
 * exactly as `md` reads them, so the mutual-exclusion error is raised in one
 * place.
 */
function selection(): ConfigSelection {
  return selectConfig(process.argv.slice(2));
}

function walkOptions(opts: ScriptsOptions) {
  return { root: opts.root, selection: selection() };
}

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function style(text: string, code: string, human: boolean): string {
  return human ? `${code}${text}${RESET}` : text;
}

function commandOf(entry: { run?: string; exec?: readonly string[] }): string {
  return entry.run ?? (entry.exec ?? []).join(" ");
}

// ---------------------------------------------------------------------------
// scripts run
// ---------------------------------------------------------------------------

export interface ScriptRunPayload {
  name: string;
  registry: string;
  workingDirectory: string;
  invokedFrom: string;
  command: { form: "run" | "exec"; run?: string; exec?: readonly string[]; shell?: string };
  args: string[];
  exit: { code: number | null; signal: string | null; status: number };
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  startupError?: string;
}

/**
 * Fails when the resolution cannot safely produce a script to run.
 *
 * The boundary refusal is the load-bearing one: without a repository and without
 * `--root` the walk would fall back to the nearest configuration file, which in a
 * scratch directory can mean a world-writable one in a shared parent.
 */
function requireWinner(resolution: ScriptResolution, name: string): void {
  const shadowing = shadowingFailure(resolution);
  if (shadowing) {
    throw new Error(
      `Cannot resolve '${name}': ${shadowing.file} is unreadable (${shadowing.reason}) and may shadow a definition above it`,
    );
  }
  if (!resolution.winner) {
    const consulted = resolution.consulted.length;
    throw new Error(
      consulted === 0
        ? `No script named '${name}': no ${CONFIG_FILENAME} was found from ${resolution.invokedFrom}`
        : `No script named '${name}' in ${consulted} configuration file${consulted === 1 ? "" : "s"} from ${resolution.invokedFrom}`,
    );
  }
}

async function runScript(name: string, args: string[], opts: ScriptRunOptions): Promise<void> {
  const format = resolveFormat(opts);
  const ignore = Boolean(opts.ignoreExitCode);
  const resolution = resolveScript(name, walkOptions(opts));

  if (resolution.boundary.kind === "nearest-config") {
    throw new Error(
      "Refusing to run a script outside a Git repository; pass --root <dir> to set the boundary explicitly",
    );
  }
  requireWinner(resolution, name);
  const winner = resolution.winner!;

  const outcome = await executeScript({
    mode: format === "json" ? "capture" : "pass-through",
    definition: winner.definition,
    registry: winner.registry,
    workingDirectory: winner.workingDirectory,
    invokedFrom: resolution.invokedFrom,
    args,
  });

  if (format !== "json") {
    if (format === "human") {
      process.stderr.write(
        `${DIM}${winner.definition.name} — ${winner.registry.file} (cwd ${winner.workingDirectory})${RESET}\n`,
      );
    }
    // Assigned rather than thrown: the child's status is outside CommandExit's
    // 1|2 type. Never process.exit() — a piped stdout write is asynchronous and
    // would be truncated.
    process.exitCode = ignore ? 0 : exitStatusFor(outcome);
    return;
  }

  const status = exitStatusFor(outcome);
  const payload: ScriptRunPayload = {
    name,
    registry: winner.registry.file,
    workingDirectory: winner.workingDirectory,
    invokedFrom: resolution.invokedFrom,
    command: {
      form: winner.definition.run !== undefined ? "run" : "exec",
      ...(winner.definition.run !== undefined ? { run: winner.definition.run } : {}),
      ...(winner.definition.exec !== undefined ? { exec: winner.definition.exec } : {}),
      ...(winner.definition.shell !== undefined ? { shell: winner.definition.shell } : {}),
    },
    args: [...args],
    exit: { code: outcome.code, signal: outcome.signal, status },
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    truncated: outcome.truncated ?? { stdout: false, stderr: false },
    durationMs: outcome.durationMs,
    ...(outcome.startupError ? { startupError: outcome.startupError } : {}),
  };

  // A script that never started is an invocation error, not a failing script;
  // collapsing the two would make a typo in exec[0] indistinguishable from a
  // legitimately failing test suite.
  const declared = outcome.startupError ? 1 : status === 0 ? 0 : 2;
  // The suppressed value is what `jsonPayload` is given, so `--envelope`'s
  // exitCode never contradicts the process. `exit.status` still carries the truth.
  const exitCode = ignore ? 0 : declared;
  process.stdout.write(
    jsonPayload("scripts run", payload, opts, {
      exitCode,
      summary: { status, durationMs: outcome.durationMs },
    }),
  );
  if (exitCode !== 0) terminate(exitCode);
}

/**
 * Under `--ignore-exit-code` every outcome exits 0, a refused resolution included:
 * the flag exists so an invocation inline in a skill document cannot keep the skill
 * from loading, and a name that failed to resolve would do exactly that. The message
 * still reaches stderr in the CLI boundary's own wording; only the status changes.
 */
export async function scriptsRunAction(
  name: string,
  args: string[],
  opts: ScriptRunOptions,
): Promise<void> {
  if (!opts.ignoreExitCode) return runScript(name, args, opts);
  try {
    await runScript(name, args, opts);
  } catch (error) {
    if (!(error instanceof CommandExit)) {
      process.stderr.write(`Error: ${(error as Error).message}\n`);
    }
  }
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// scripts which
// ---------------------------------------------------------------------------

export interface ScriptWhichPayload {
  name: string;
  found: boolean;
  boundary: { directory: string; kind: string };
  invokedFrom: string;
  registry?: string;
  workingDirectory?: string;
  description?: string;
  command?: { form: "run" | "exec"; run?: string; exec?: readonly string[]; shell?: string };
  shadowed: Array<{ file: string; description?: string }>;
  consulted: ConsultedFile[];
}

export async function scriptsWhichAction(name: string, opts: ScriptsOptions): Promise<void> {
  const format = resolveFormat(opts);
  const resolution = resolveScript(name, walkOptions(opts));
  const shadowing = shadowingFailure(resolution);
  if (shadowing) {
    throw new Error(
      `Cannot resolve '${name}': ${shadowing.file} is unreadable (${shadowing.reason}) and may shadow a definition above it`,
    );
  }

  const winner = resolution.winner;
  const payload: ScriptWhichPayload = {
    name,
    found: Boolean(winner),
    boundary: { directory: resolution.boundary.directory, kind: resolution.boundary.kind },
    invokedFrom: resolution.invokedFrom,
    ...(winner
      ? {
          registry: winner.registry.file,
          workingDirectory: winner.workingDirectory,
          ...(winner.definition.description ? { description: winner.definition.description } : {}),
          command: {
            form: winner.definition.run !== undefined ? ("run" as const) : ("exec" as const),
            ...(winner.definition.run !== undefined ? { run: winner.definition.run } : {}),
            ...(winner.definition.exec !== undefined ? { exec: winner.definition.exec } : {}),
            ...(winner.definition.shell !== undefined ? { shell: winner.definition.shell } : {}),
          },
        }
      : {}),
    shadowed: resolution.shadowed.map(({ file, description }) => ({
      file,
      ...(description ? { description } : {}),
    })),
    consulted: resolution.consulted,
  };

  if (format === "json") {
    const output = jsonPayload("scripts which", payload, opts, { exitCode: winner ? 0 : 2 });
    (winner ? process.stdout : process.stderr).write(output);
    if (!winner) terminate(2);
    return;
  }

  const human = format === "human";
  const lines: string[] = [];
  if (!winner) {
    lines.push(`No script named '${name}'`);
    lines.push(
      `  consulted: ${resolution.consulted.length} file(s) up to ${payload.boundary.directory}`,
    );
    process.stderr.write(lines.join("\n") + "\n");
    terminate(2);
  }

  lines.push(`${style(name, BOLD, human)}  ${commandOf(winner!.definition)}`);
  if (winner!.definition.description) lines.push(`  ${winner!.definition.description}`);
  lines.push(`  registry: ${style(winner!.registry.file, CYAN, human)}`);
  lines.push(`  cwd:      ${winner!.workingDirectory}`);
  for (const shadow of payload.shadowed) lines.push(`  shadows:  ${shadow.file}`);
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// scripts list
// ---------------------------------------------------------------------------

export async function scriptsListAction(opts: ScriptsOptions): Promise<void> {
  const format = resolveFormat(opts);
  const listing = listScripts(walkOptions(opts));
  const invalid = listing.consulted.filter((file) => file.status === "invalid");

  const payload = {
    boundary: { directory: listing.boundary.directory, kind: listing.boundary.kind },
    invokedFrom: listing.invokedFrom,
    scripts: listing.scripts,
    consulted: listing.consulted,
    invalid: invalid.length,
  };

  if (format === "json") {
    const output = jsonPayload("scripts list", payload, opts, {
      exitCode: invalid.length > 0 ? 2 : 0,
      summary: { scripts: listing.scripts.length, invalid: invalid.length },
    });
    (invalid.length > 0 ? process.stderr : process.stdout).write(output);
    if (invalid.length > 0) terminate(2);
    return;
  }

  const human = format === "human";
  const lines: string[] = [];
  if (listing.scripts.length === 0) {
    lines.push(`No scripts declared from ${listing.invokedFrom}`);
  }
  const width = Math.max(0, ...listing.scripts.map((entry) => entry.name.length));
  for (const entry of listing.scripts) {
    const name = style(entry.name.padEnd(width), BOLD, human);
    lines.push(`${name}  ${entry.description ?? commandOf(entry)}`);
    lines.push(`${" ".repeat(width)}  ${style(entry.file, DIM, human)}`);
  }
  for (const file of invalid) {
    lines.push(`${style("invalid", BOLD, human)}  ${file.file}: ${file.reason}`);
  }

  const rendered = lines.join("\n") + "\n";
  (invalid.length > 0 ? process.stderr : process.stdout).write(rendered);
  if (invalid.length > 0) terminate(2);
}
