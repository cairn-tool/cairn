import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getCachePath,
  getLockPath,
  isNewerVersion,
  readCache,
  releaseRefreshLock,
  writeCache,
} from "../update-notifier.js";
import type { OutputFormat } from "../types.js";
import { jsonPayload } from "../result.js";

const exec = promisify(execFile);

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Resolves the latest published version via `npm view`.
 *
 * Shelling out to npm rather than querying the registry directly is deliberate.
 * The package is public on registry.npmjs.org, but plenty of installs sit behind
 * a mirror or a proxy, so the request needs npm's own resolution of
 * `@scope:registry`, `registry`, and `_authToken` across the project and user
 * .npmrc files plus environment overrides. Reimplementing that is a large
 * surface to get wrong for no gain.
 */
export async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const { stdout } = await exec("npm", ["view", packageName, "version", "--json"], {
      timeout: FETCH_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed === "string") return parsed;
    // `npm view` returns an array when several versions match.
    if (Array.isArray(parsed)) {
      const last: unknown = parsed[parsed.length - 1];
      return typeof last === "string" ? last : null;
    }
    return null;
  } catch {
    // Offline, unauthenticated, npm missing, package unpublished — all the same
    // to us. The caller still records the attempt so it backs off for 24h.
    return null;
  }
}

/**
 * Refreshes the cached latest version. Run in a detached child process, so it
 * must never throw and never write to stdout/stderr.
 */
export async function refreshUpdateCacheAction(packageName: string): Promise<void> {
  const cachePath = getCachePath();
  try {
    const previous = readCache(cachePath);
    const latest = await fetchLatestVersion(packageName);

    writeCache(cachePath, {
      lastCheckedAt: Date.now(),
      // Keep the previous answer on failure rather than dropping a valid notice.
      latestVersion: latest ?? previous?.latestVersion ?? null,
    });
  } finally {
    // The parent holds the lock on our behalf; release it however we exit.
    releaseRefreshLock(getLockPath(cachePath));
  }
}

interface CheckUpdateOptions {
  format: string;
  envelope?: boolean;
}

/** Seams for testing; every field defaults to the real implementation. */
export interface CheckUpdateDeps {
  fetchLatest?: (packageName: string) => Promise<string | null>;
  cachePath?: string;
  now?: () => number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exit?: (code: number) => void;
}

function resolveFormat(opts: CheckUpdateOptions): OutputFormat {
  const fmt = opts.format;
  if (fmt === "llm" || fmt === "human" || fmt === "json") return fmt;
  return "llm";
}

/**
 * User-facing `check-update`. Always queries the registry — an explicit request
 * should never be answered from a cache that may be up to 24h old — but it does
 * refresh that cache so the passive notifier stays consistent.
 */
export async function checkUpdateAction(
  packageName: string,
  currentVersion: string,
  opts: CheckUpdateOptions,
  deps: CheckUpdateDeps = {},
): Promise<void> {
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const cachePath = deps.cachePath ?? getCachePath();
  const now = deps.now ?? Date.now;
  const stdout = deps.stdout ?? ((t: string) => void process.stdout.write(t));
  const stderr = deps.stderr ?? ((t: string) => void process.stderr.write(t));
  const exit = deps.exit ?? ((c: number) => void (process.exitCode = c));

  const format = resolveFormat(opts);
  const latest = await fetchLatest(packageName);

  if (latest === null) {
    if (format === "json") {
      stderr(
        jsonPayload(
          "check-update",
          {
            current: currentVersion,
            latest: null,
            updateAvailable: false,
            error: "Could not resolve the latest version",
          },
          opts,
          { exitCode: 1 },
        ),
      );
    } else {
      stderr(
        `Error: Could not resolve the latest published version of ${packageName}.\n` +
          `Check your network connection and that ~/.npmrc grants read access to the registry.\n`,
      );
    }
    exit(1);
    return;
  }

  // Record the fresh answer so the background check does not immediately redo it.
  writeCache(cachePath, { lastCheckedAt: now(), latestVersion: latest });

  const updateAvailable = isNewerVersion(latest, currentVersion);

  if (format === "json") {
    stdout(
      jsonPayload("check-update", { current: currentVersion, latest, updateAvailable }, opts, {
        exitCode: updateAvailable ? 2 : 0,
      }),
    );
  } else if (updateAvailable) {
    stdout(
      format === "human"
        ? `\x1b[33mUpdate available\x1b[0m \x1b[2m${currentVersion}\x1b[0m → \x1b[1m${latest}\x1b[0m\n` +
            `\x1b[2mRun\x1b[0m npm install -g ${packageName} \x1b[2mto update.\x1b[0m\n`
        : `Update available: ${currentVersion} -> ${latest}\n` +
            `Run: npm install -g ${packageName}\n`,
    );
  } else {
    stdout(
      format === "human"
        ? `\x1b[32m✔ ${packageName} ${currentVersion} is up to date\x1b[0m\n`
        : `${packageName} ${currentVersion} is up to date\n`,
    );
  }

  // Consistent with the rest of the CLI: 2 means "actionable finding".
  if (updateAvailable) exit(2);
}
