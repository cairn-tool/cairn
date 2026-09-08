import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

/** Every `raise SystemExit("msg")` in the Python becomes one of these. */
export class UserError extends Error {}

export const DEFAULT_PARALLEL = 8;
export const DEFAULT_TIMEOUT_MIN = 60;

export const REPORT = "_report.md";
export const RESULTS = "_results.md";

export const TRANSCRIPT_CAP = 400;
export const RENDER_HZ = 4;

/** Digits 1..9 zoom a pane; a tenth pane simply has no key. */
export const MAX_ZOOM_KEYS = 9;

/**
 * A case's plan travels inside the prompt argv, so it is bounded by ARG_MAX (1 MiB here, shared
 * with the environment). Well under it, with a message that names the file instead of E2BIG.
 */
export const MAX_PROMPT_BYTES = 256 * 1024;

export const DONE_OK = "ok";
export const DONE_FAIL: ReadonlySet<string> = new Set([
  "error",
  "timeout",
  "no-output",
  "no-folder",
]);

export interface Options {
  repo: string;
  runsDir: string;
  /** Maximum agents in flight; per-case `parallel`/`tags` may hold it below this. */
  parallel: number;
  /**
   * Session-log label for `--model`. Per-case fallbacks live on the Case via
   * `models` / the profile default — a mixed queue does not share one slug.
   */
  model: string;
  only: ReadonlySet<string> | null;
  limit: number | null;
  dryRun: boolean;
  showPrompts: boolean;
  noTui: boolean;
  timeoutMs: number;
  /** Explicit binary for every backend, or null to resolve per profile on PATH. */
  agent: string | null;
  /** When true, main() does not print the human console summary (JSON owns stdout). */
  json: boolean;
}

function expandUser(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

/** Python: resolve_dir(raw, base, what) */
export function resolveDir(raw: string, base: string, what: string): string {
  const expanded = expandUser(raw);
  const joined = isAbsolute(expanded) ? expanded : join(base, expanded);
  // Python's Path.resolve() also resolves symlinks — on macOS /tmp is a link to /private/tmp,
  // so path.resolve() alone would produce a different --workspace and different log paths.
  let path: string;
  try {
    path = realpathSync(joined);
  } catch {
    path = resolve(joined);
  }
  let dir = false;
  try {
    dir = statSync(path).isDirectory();
  } catch {
    /* keep false */
  }
  if (!dir) throw new UserError(`${what} is not a directory: ${path}`);
  return path;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Python: shutil.which — POSIX PATH walk, no PATHEXT handling. */
export function which(name: string): string | null {
  if (name.includes("/")) return isExecutableFile(name) ? name : null;
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(":")) {
    const candidate = join(dir === "" ? "." : dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * An explicit `--agent` path. Kept expanduser'd as given — it is not absolutized,
 * and the result goes verbatim into command.txt and --dry-run output.
 */
export function findExplicitAgent(explicit: string): string {
  const path = expandUser(explicit);
  if (!isExecutableFile(path)) {
    throw new UserError(`--agent is not an executable file: ${explicit}`);
  }
  return path;
}

/** Python: parse_only("27, tc-28,") -> {"tc-27", "tc-28"} */
export function parseOnly(raw: string | null | undefined): ReadonlySet<string> | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const names = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    names.add(trimmed.startsWith("tc-") ? trimmed : `tc-${trimmed}`);
  }
  return names;
}
