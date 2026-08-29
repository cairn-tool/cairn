import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** How long a cached result stays fresh. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** argv token that runs the detached cache refresh. Hidden from help. */
export const REFRESH_COMMAND = "__refresh-update-cache";

/** User-facing command that checks explicitly; suppresses the passive notice. */
export const CHECK_COMMAND = "check-update";

/**
 * Contract-discovery commands. Their stdout is unconditionally a machine
 * document, so a notice is never useful alongside them.
 */
export const DESCRIBE_COMMAND = "describe";
export const SCHEMA_COMMAND = "schema";
export const COMPLETION_COMMAND = "completion";

/**
 * `scripts run` hands its stderr to a child process, so a notice appended at exit
 * would land inside whatever the calling hook captured.
 */
export const SCRIPTS_COMMAND = "scripts";
export const SCRIPTS_RUN_SUBCOMMAND = "run";

/**
 * The machine-stream guarantees, published through `describe` so consumers can
 * read them rather than infer them. Exported from here, next to the gate that
 * enforces them, so the two cannot drift.
 */
export const NOTIFIER_CONTRACT = {
  description: "The update notice is advisory only and never appears on a machine-readable stream.",
  stream: "stderr",
  suppressedWhen: [
    "CAIRN_NO_UPDATE_NOTIFIER=1",
    "CI is set",
    "stderr is not a TTY",
    "--format is json, jsonl, or sarif, including a project-configured format",
    "the command is check-update, describe, schema, completion, scripts run, or the internal cache refresh",
  ],
  optOutEnv: "CAIRN_NO_UPDATE_NOTIFIER",
} as const;

/**
 * How long a held refresh lock is trusted. Must exceed the child's own fetch
 * timeout so a working refresh is never treated as abandoned.
 */
export const LOCK_STALE_MS = 60_000;

export interface UpdateCache {
  /** Epoch ms of the last attempt — set even when the attempt failed, so failures back off too. */
  lastCheckedAt: number;
  /** Last known published version, or null if never resolved. */
  latestVersion: string | null;
}

export function getCachePath(env: NodeJS.ProcessEnv = process.env, homedir?: string): string {
  const home = homedir ?? os.homedir();
  const xdg = env.XDG_CACHE_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(home, ".cache");
  return path.join(base, "cairn", "update-check.json");
}

export function readCache(cachePath: string): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { lastCheckedAt, latestVersion } = parsed as Record<string, unknown>;
    if (typeof lastCheckedAt !== "number" || !Number.isFinite(lastCheckedAt)) return null;
    return {
      lastCheckedAt,
      latestVersion: typeof latestVersion === "string" ? latestVersion : null,
    };
  } catch {
    // A missing or corrupt cache is not an error — treat it as "never checked".
    return null;
  }
}

export function writeCache(cachePath: string, cache: UpdateCache): boolean {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
    return true;
  } catch {
    // The cache is an optimisation; never let it break a command.
    return false;
  }
}

export function getLockPath(cachePath: string): string {
  return path.join(path.dirname(cachePath), "update-check.lock");
}

function isLockStale(lockPath: string, now: number, staleMs: number): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    const at = (parsed as Record<string, unknown>).at;
    // An unreadable lock cannot be reasoned about; assume it was abandoned.
    if (typeof at !== "number" || !Number.isFinite(at)) return true;
    const age = now - at;
    return age < 0 || age >= staleMs;
  } catch {
    return true;
  }
}

/**
 * Exclusively claims the right to spawn a refresh, so concurrent invocations
 * cannot each start their own child process. Uses an atomic `wx` create rather
 * than an exists-then-write check, which would race.
 *
 * Returns false when another refresh is already in flight.
 */
export function acquireRefreshLock(
  lockPath: string,
  now: number,
  staleMs: number = LOCK_STALE_MS,
): boolean {
  const payload = JSON.stringify({ pid: process.pid, at: now });
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    return true;
  } catch {
    // Either the lock is held or the directory is unwritable. Only take it over
    // when it is demonstrably stale — a crashed child must not block forever.
    if (!isLockStale(lockPath, now, staleMs)) return false;
    try {
      fs.rmSync(lockPath, { force: true });
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseRefreshLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Best-effort; the stale timeout is the backstop.
  }
}

export function isCacheStale(
  cache: UpdateCache | null,
  now: number,
  intervalMs: number = CHECK_INTERVAL_MS,
): boolean {
  if (!cache) return true;
  const age = now - cache.lastCheckedAt;
  // A negative age means the clock moved backwards; re-check rather than
  // trusting a timestamp from the future and going quiet indefinitely.
  return age < 0 || age >= intervalMs;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ?? null,
  };
}

/**
 * True when `candidate` is a strictly newer release than `current`.
 *
 * Deliberately conservative: unparseable input and prerelease-to-prerelease
 * comparisons return false. A wrong `true` nags the user on every command, so
 * staying quiet is the safer failure mode.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;

  for (let i = 0; i < 3; i++) {
    if (a.core[i] > b.core[i]) return true;
    if (a.core[i] < b.core[i]) return false;
  }

  // Same core version: a final release supersedes a prerelease of it.
  return a.prerelease === null && b.prerelease !== null;
}

/** Detects JSON output from already-normalised argv (cli.ts expands `-fj` first). */
export function hasJsonOutput(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^--format=(?:json|jsonl|sarif)$/.test(arg)) return true;
    if (arg === "--format" && ["json", "jsonl", "sarif"].includes(argv[i + 1] ?? "")) return true;
  }
  return false;
}

export interface NotifyDecision {
  currentVersion: string;
  cache: UpdateCache | null;
  argv: readonly string[];
  isTty: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Whether the notice may be shown at all. Also gates the background refresh, so
 * non-interactive callers never spawn a child process either.
 */
export function isNotifierAllowed(ctx: Omit<NotifyDecision, "cache" | "currentVersion">): boolean {
  // The pre-rename spelling stays honored: an opt-out already exported in a CI
  // job or a shell profile must not start printing notices because the tool was
  // renamed. Only the current name is published through `describe`.
  if (ctx.env.CAIRN_NO_UPDATE_NOTIFIER === "1") return false;
  if (ctx.env.CLAUDE_CLI_NO_UPDATE_NOTIFIER === "1") return false;
  if (ctx.env.CI) return false;
  // Not a terminal means the output is being parsed by something. Both stdout
  // and stderr carry machine-readable payloads depending on the command, so
  // there is no safe stream to write to.
  if (!ctx.isTty) return false;
  if (hasJsonOutput(ctx.argv)) return false;
  // The refresh child must not recurse, and `check-update` reports the same
  // thing itself — a passive notice alongside it would just be duplication.
  if (ctx.argv.includes(REFRESH_COMMAND)) return false;
  if (ctx.argv.includes(CHECK_COMMAND)) return false;
  // Contract-discovery commands always emit a machine document, and agents that
  // poll them should not keep spawning the background refresh.
  if (ctx.argv.includes(DESCRIBE_COMMAND)) return false;
  if (ctx.argv.includes(SCHEMA_COMMAND)) return false;
  // `eval "$(cairn completion zsh)"` belongs in an interactive rc file,
  // where stderr *is* a TTY. Without this the notice would print on every shell
  // start and the background refresh would spawn on every shell start.
  if (ctx.argv.includes(COMPLETION_COMMAND)) return false;
  // `scripts run` gives its stderr to a child process, so anything written at
  // exit lands inside the output a calling hook captured. Matched by adjacency
  // rather than by `includes`, because `run` is also a legal script name.
  const scriptsIndex = ctx.argv.indexOf(SCRIPTS_COMMAND);
  if (scriptsIndex !== -1 && ctx.argv[scriptsIndex + 1] === SCRIPTS_RUN_SUBCOMMAND) return false;
  return true;
}

export function shouldNotify(ctx: NotifyDecision): boolean {
  if (!isNotifierAllowed(ctx)) return false;
  const latest = ctx.cache?.latestVersion;
  if (!latest) return false;
  return isNewerVersion(latest, ctx.currentVersion);
}

export function formatNotice(current: string, latest: string, packageName: string): string {
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const yellow = "\x1b[33m";
  const reset = "\x1b[0m";
  return [
    "",
    `${yellow}Update available${reset} ${dim}${current}${reset} → ${bold}${latest}${reset}`,
    `${dim}Run${reset} npm install -g ${packageName} ${dim}to update.${reset}`,
    "",
  ].join("\n");
}

export interface InstallOptions {
  currentVersion: string;
  packageName: string;
  argv: readonly string[];
  /** Path to the CLI entry point, re-invoked for the detached refresh. */
  entryPoint: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  isTty?: boolean;
  cachePath?: string;
}

/**
 * Prints an update notice from cache at process exit and kicks off a detached refresh when
 * the cache is stale. Never delays or fails a command.
 */
export function installUpdateNotifier(opts: InstallOptions): void {
  const env = opts.env ?? process.env;
  const isTty = opts.isTty ?? process.stderr.isTTY === true;
  const argv = opts.argv;

  if (!isNotifierAllowed({ argv, isTty, env })) return;

  const cachePath = opts.cachePath ?? getCachePath(env);
  const cache = readCache(cachePath);
  const now = opts.now ?? Date.now();

  if (shouldNotify({ currentVersion: opts.currentVersion, cache, argv, isTty, env })) {
    const latest = cache?.latestVersion;
    if (latest) {
      // Deferred to exit so the notice lands after the command's own output.
      process.on("exit", () => {
        process.stderr.write(formatNotice(opts.currentVersion, latest, opts.packageName));
      });
    }
  }

  if (!isCacheStale(cache, now)) return;

  // Claim the lock here, in the parent, rather than in the child. Letting every
  // invocation spawn a child that then discovers it lost the race would defeat
  // the point — the cost being avoided is the process spawn itself.
  const lockPath = getLockPath(cachePath);
  if (!acquireRefreshLock(lockPath, now)) return;

  if (!spawnRefresh(opts.entryPoint, env)) {
    // Nothing will ever release it otherwise.
    releaseRefreshLock(lockPath);
  }
}

function spawnRefresh(entryPoint: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const child = spawn(process.execPath, [entryPoint, REFRESH_COMMAND], {
      detached: true,
      stdio: "ignore",
      env,
    });
    // Let the parent exit immediately regardless of the child.
    child.unref();
    return true;
  } catch {
    // A failed spawn must never surface to the user.
    return false;
  }
}
