import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { displayBinary, resolveAgent, resolveBinary } from "./agents/index.js";
import { loadCaseFiles } from "./casefile.js";
import type { CaseFile } from "./casefile.js";

export class Case {
  readonly name: string;
  readonly number: number;
  /** Absolute path to `_plans/tc-N.yaml`. */
  readonly file: string;
  readonly outDir: string;
  readonly repo: string;
  /** The YAML `name` — a human title, distinct from `name` above, which is the identity. */
  readonly title: string;
  readonly agentName: string;
  readonly model: string;
  readonly parallel: boolean;
  readonly tags: readonly string[];
  /** The plan text itself, verbatim from the YAML block scalar. */
  readonly plan: string;

  constructor(spec: CaseFile, outDir: string, repo: string, defaultModel: string) {
    this.name = spec.name;
    this.number = spec.number;
    this.file = spec.file;
    this.outDir = outDir;
    this.repo = repo;
    this.title = spec.title;
    this.agentName = spec.agent;
    this.model = spec.model ?? defaultModel;
    this.parallel = spec.parallel;
    this.tags = spec.tags;
    this.plan = spec.plan;
  }

  /** Python: Path.relative_to(repo).as_posix(), falling back to the absolute path. */
  rel(path: string): string {
    const rel = relative(this.repo, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
    return rel;
  }

  get fileRel(): string {
    return this.rel(this.file);
  }

  get outRel(): string {
    return `${this.rel(this.outDir)}/`;
  }

  get tempDir(): string {
    return join(dirname(this.outDir), `${basename(this.outDir)}-temp`);
  }

  get tempRel(): string {
    return `${this.rel(this.tempDir)}/`;
  }

  /** How this case schedules, for the dry-run listing and the pane note. */
  get constraint(): string {
    if (this.parallel) return "parallel";
    if (this.tags.length === 0) return "exclusive";
    return `tags ${this.tags.join(", ")}`;
  }

  /**
   * Load-bearing: handed verbatim to the selected agent backend. The dash is an em dash (U+2014).
   * The plan is inlined rather than @-referenced, so the write constraint is stated before it,
   * not after.
   */
  get prompt(): string {
    return (
      `Perform the test-case plan below. Write every deliverable to ${this.tempRel}, ` +
      `creating that folder yourself. Do not write to ${this.outRel} — the harness ` +
      `renames the temp folder there only after this run succeeds.\n\n---\n\n${this.plan}`
    );
  }
}

/** Python: int(re.search(r"(\d+)", name).group(1)) */
export function caseNumber(name: string): number {
  const match = /(\d+)/.exec(name);
  if (!match) throw new Error(`no number in case name: ${name}`);
  return Number.parseInt(match[1]!, 10);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface Catalog {
  cases: Case[];
  errors: string[];
}

function fallbackModel(
  spec: CaseFile,
  defaults: string | Readonly<Record<string, string>>,
): string {
  if (typeof defaults === "string") return spec.model ?? defaults;
  return spec.model ?? defaults[spec.agent] ?? resolveAgent(spec.agent).defaultModel;
}

/** Every case under `_plans/`, whether or not it has been run, plus every load error. */
export function catalog(
  runs: string,
  repo: string,
  defaultModel: string | Readonly<Record<string, string>>,
): Catalog {
  const loaded = loadCaseFiles(join(runs, "_plans"));
  const cases = loaded.cases.map(
    (spec) => new Case(spec, join(runs, spec.name), repo, fallbackModel(spec, defaultModel)),
  );
  // loadCaseFiles already sorts numerically — tc-2 must precede tc-10.
  return { cases, errors: loaded.errors };
}

/** Cases whose run folder does not exist, natural-sorted, then filtered. */
export function discover(
  all: readonly Case[],
  only: ReadonlySet<string> | null = null,
  limit: number | null = null,
): Case[] {
  let cases = all.filter((c) => !existsSync(c.outDir));
  if (only !== null) cases = cases.filter((c) => only.has(c.name));
  if (limit !== null) cases = cases.slice(0, limit);
  return cases;
}

export function stillEligible(kase: Case): boolean {
  return isFile(kase.file) && !existsSync(kase.outDir);
}

export function agentCommand(binary: string, kase: Case): string[] {
  return resolveAgent(kase.agentName).buildArgv(
    { repo: kase.repo, model: kase.model, prompt: kase.prompt },
    binary,
  );
}

export function commandFor(kase: Case, explicitAgent: string | null): string[] {
  return agentCommand(resolveBinary(kase.agentName, explicitAgent), kase);
}

/** Python: shlex._find_unsafe = re.compile(r'[^\w@%+=:,./-]', re.ASCII).search */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(s: string): string {
  if (SHELL_SAFE.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** The argv with the plan body elided, for a `--dry-run` listing that stays readable. */
export function elidedCommand(binary: string, kase: Case): string[] {
  const argv = agentCommand(binary, kase);
  const head = kase.prompt.slice(0, kase.prompt.indexOf("\n\n---\n\n"));
  const hidden = kase.plan.length;
  argv[argv.length - 1] = `${head} …[+${hidden.toLocaleString("en-US")} chars of plan]…`;
  return argv;
}

/** Argv for the --dry-run listing: never spawned, so an absent backend is not an error. */
export function displayCommandFor(kase: Case, explicitAgent: string | null): string[] {
  return agentCommand(displayBinary(kase.agentName, explicitAgent), kase);
}

export function elidedCommandFor(kase: Case, explicitAgent: string | null): string[] {
  const argv = displayCommandFor(kase, explicitAgent);
  const head = kase.prompt.slice(0, kase.prompt.indexOf("\n\n---\n\n"));
  const hidden = kase.plan.length;
  argv[argv.length - 1] = `${head} …[+${hidden.toLocaleString("en-US")} chars of plan]…`;
  return argv;
}
