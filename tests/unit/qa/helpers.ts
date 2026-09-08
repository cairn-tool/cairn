import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { Options } from "../../../src/qa/config.js";
import { catalog, discover } from "../../../src/qa/cases.js";
import { Harness } from "../../../src/qa/harness.js";

export const FAKE_AGENT = resolve(import.meta.dirname, "../../helpers/fake-agent.mjs");

export interface Fixture {
  repo: string;
  runs: string;
}

/** The knobs a fixture case can set; everything else is defaulted. */
export interface PlanSpec {
  mode?: string;
  model?: string;
  parallel?: boolean;
  tags?: string[];
  title?: string;
  agent?: string;
}

/** One `_plans/tc-N.yaml`. The plan body carries the `MODE:` line the fake agent reads. */
export function caseYaml(name: string, spec: PlanSpec = {}): string {
  const id = name.toUpperCase();
  const lines = [
    `id: ${id}`,
    `name: ${spec.title ?? `Plan ${name}`}`,
    `agent: ${spec.agent ?? "cursor"}`,
  ];
  if (spec.model !== undefined) lines.push(`model: ${spec.model}`);
  lines.push(`parallel: ${spec.parallel ?? true}`);
  if (spec.tags !== undefined) lines.push(`tags: [${spec.tags.join(", ")}]`);
  lines.push("plan: |", `  # Plan ${name}`, "", `  MODE: ${spec.mode ?? "ok"}`, "");
  return lines.join("\n");
}

/** A throwaway repo with a runs dir and one case file per entry. */
export function makeFixture(plans: Record<string, string | PlanSpec>): Fixture {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tch-")));
  const runs = join(repo, "runs");
  mkdirSync(join(runs, "_plans"), { recursive: true });
  for (const [name, spec] of Object.entries(plans)) {
    const resolved: PlanSpec = typeof spec === "string" ? { mode: spec } : spec;
    writeFileSync(join(runs, "_plans", `${name}.yaml`), caseYaml(name, resolved));
  }
  return { repo, runs };
}

export function makeOptions(fx: Fixture, overrides: Partial<Options> = {}): Options {
  return {
    repo: fx.repo,
    runsDir: fx.runs,
    parallel: 2,
    model: "fake-model",
    only: null,
    limit: null,
    dryRun: false,
    showPrompts: false,
    noTui: true,
    timeoutMs: 60_000,
    agent: FAKE_AGENT,
    json: true,
    ...overrides,
  };
}

export function makeHarness(fx: Fixture, overrides: Partial<Options> = {}): Harness {
  const options = makeOptions(fx, overrides);
  const { cases: all, errors } = catalog(options.runsDir, options.repo, options.model);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const pending = discover(all, options.only, options.limit);
  return new Harness(options, pending, all);
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const wait = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
