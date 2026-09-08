import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "../config-schema.js";
import { runtime } from "../runtime.js";
import { defaultModels, resolveBinary, SUPPORTED_AGENTS } from "./agents/index.js";
import {
  catalog,
  discover,
  displayCommandFor,
  elidedCommandFor,
  shellJoin,
  type Case,
} from "./cases.js";
import {
  DEFAULT_PARALLEL,
  DEFAULT_TIMEOUT_MIN,
  type Options,
  parseOnly,
  resolveDir,
  UserError,
} from "./config.js";

export const NO_CASES = "no eligible cases (every _plans/tc-N.yaml already has a tc-N/ folder)";

export interface QaCliOptions {
  format?: string;
  envelope?: boolean;
  parallel?: string;
  model?: string | string[];
  repo?: string;
  runsDir?: string;
  only?: string;
  limit?: string;
  dryRun?: boolean;
  showPrompts?: boolean;
  noTui?: boolean;
  timeoutMin?: string;
  agent?: string;
}

export interface PreparedRun {
  options: Options;
  cases: Case[];
  allCases: Case[];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function positiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(raw).trim() || parsed < 1) {
    throw new UserError(`${flag} must be an integer >= 1`);
  }
  return parsed;
}

function anyInt(raw: string | undefined, flag: string): number | null {
  if (raw === undefined || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(raw).trim()) {
    throw new UserError(`${flag} must be an integer`);
  }
  return parsed;
}

export function refuseWindows(): void {
  if (process.platform === "win32") {
    throw new UserError(
      "qa is POSIX-only; Windows support is tracked in docs/future-enhancements.md",
    );
  }
}

export function parseModelFlags(
  values: string[] | undefined,
  defaults: Record<string, string>,
): { label: string; models: Record<string, string> } {
  const models = { ...defaults };
  if (!values || values.length === 0) {
    const unique = new Set(Object.values(models));
    return { label: unique.size === 1 ? [...unique][0]! : "per-agent", models };
  }
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq === -1) {
      if (!raw) throw new UserError("--model must not be empty");
      for (const name of Object.keys(models)) models[name] = raw;
    } else {
      const agent = raw.slice(0, eq);
      const slug = raw.slice(eq + 1);
      if (!SUPPORTED_AGENTS.includes(agent)) {
        throw new UserError(
          `--model agent must be one of ${SUPPORTED_AGENTS.join(", ")}, not ${JSON.stringify(agent)}`,
        );
      }
      if (!slug) throw new UserError(`--model ${agent}= must not be empty`);
      models[agent] = slug;
    }
  }
  const unique = new Set(Object.values(models));
  return { label: unique.size === 1 ? [...unique][0]! : "per-agent", models };
}

function qaConfig(): {
  runsDir?: string;
  model?: string;
  parallel?: number;
  agent?: string;
} {
  return runtime().config.qa ?? {};
}

function modelValues(raw: QaCliOptions): string[] | undefined {
  if (raw.model === undefined) {
    const configured = qaConfig().model;
    return configured === undefined ? undefined : [configured];
  }
  return Array.isArray(raw.model) ? raw.model : [raw.model];
}

export function buildRunOptions(raw: QaCliOptions, format: string): PreparedRun {
  refuseWindows();
  const configured = qaConfig();
  if (!raw.repo) throw new UserError("--repo is required");
  const repo = resolveDir(raw.repo, process.cwd(), "--repo");
  const runsRaw = raw.runsDir ?? configured.runsDir;
  if (!runsRaw) throw new UserError("--runs-dir is required");
  const runs = resolveDir(runsRaw, repo, "--runs-dir");
  if (!isInside(repo, runs)) {
    throw new UserError(`--runs-dir must resolve under --repo: ${runs}`);
  }
  if (!isDir(join(runs, "_plans"))) throw new UserError(`no _plans/ under ${runs}`);

  const parallel = positiveInt(raw.parallel, "--parallel", configured.parallel ?? DEFAULT_PARALLEL);
  const { label, models } = parseModelFlags(modelValues(raw), defaultModels());
  const only = parseOnly(raw.only ?? null);
  const loaded = catalog(runs, repo, models);
  if (loaded.errors.length > 0) {
    throw new UserError(
      `${loaded.errors.length} case file(s) could not be loaded:\n  ${loaded.errors.join("\n  ")}`,
    );
  }
  const allCases = loaded.cases;
  const cases = discover(allCases, only, anyInt(raw.limit, "--limit"));
  const agent = raw.agent ?? configured.agent ?? null;
  if (agent) resolveBinary(allCases[0]?.agentName ?? SUPPORTED_AGENTS[0]!, agent);

  const json = format === "json";
  const ci = Boolean(process.env["CI"]);
  const noTui = raw.noTui === true || json || ci || format === "json";

  return {
    options: {
      repo,
      runsDir: runs,
      parallel,
      model: label,
      only,
      limit: anyInt(raw.limit, "--limit"),
      dryRun: raw.dryRun === true,
      showPrompts: raw.showPrompts === true,
      noTui,
      timeoutMs: positiveInt(raw.timeoutMin, "--timeout-min", DEFAULT_TIMEOUT_MIN) * 60 * 1000,
      agent,
      json,
    },
    cases,
    allCases,
  };
}

/**
 * A relative --runs-dir resolves against --repo when one is given, and against the cwd
 * otherwise — the same rule in every subcommand. `qa run` resolving against --repo while
 * `qa list` resolved against the cwd meant identical flags named different directories
 * depending on where you stood.
 */
export function resolveRunsDir(
  raw: string | undefined,
  flag = "--runs-dir",
  repo?: string,
): string {
  refuseWindows();
  const configured = qaConfig().runsDir;
  const value = raw ?? configured;
  if (!value) throw new UserError(`${flag} is required`);
  return resolveDir(value, repo ?? process.cwd(), flag);
}

export function printDryRun(prepared: PreparedRun): string {
  const { cases, options } = prepared;
  if (cases.length === 0) return `${NO_CASES}\n`;
  const out: string[] = [];
  out.push(`${cases.length} eligible case(s)`);
  out.push(`  repo      ${options.repo}`);
  if (options.agent) out.push(`  agent     ${options.agent}`);
  out.push("");
  for (const kase of cases) {
    out.push(`${kase.name}  ${kase.fileRel}  ${kase.model}  ${kase.constraint}`);
    out.push(`  cwd ${kase.repo}`);
    const argv = options.showPrompts
      ? displayCommandFor(kase, options.agent)
      : elidedCommandFor(kase, options.agent);
    out.push(`  ${shellJoin(argv)}`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

export function caseStatus(kase: Case): "pending" | "done" {
  return existsSync(kase.outDir) ? "done" : "pending";
}
