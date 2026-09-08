import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { MAX_PROMPT_BYTES } from "./config.js";
import { SUPPORTED_AGENTS } from "./agents/index.js";

/** One `_plans/tc-<N>.yaml`, validated. Everything the harness needs about a case. */
export interface CaseFile {
  /** `tc-24` — the identity, derived from the filename and cross-checked against `id`. */
  name: string;
  number: number;
  /** Absolute path to the YAML itself. */
  file: string;
  /** YAML `id`, as written (`TC-24`). */
  id: string;
  /** YAML `name` — the human title. */
  title: string;
  agent: string;
  /** YAML `model`, or null when the case defers to `--model`. */
  model: string | null;
  parallel: boolean;
  tags: string[];
  /** The plan body, verbatim. */
  plan: string;
}

const KEYS = new Set(["id", "name", "agent", "model", "parallel", "tags", "plan"]);

const YAML_EXT = [".yaml", ".yml"];

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `tc-24.yaml` -> `tc-24`, or null when the name is not a case file at all. */
export function caseNameOf(entry: string): string | null {
  for (const ext of YAML_EXT) {
    if (!entry.endsWith(ext)) continue;
    const name = entry.slice(0, -ext.length);
    return /^tc-\d+$/.test(name) ? name : null;
  }
  return null;
}

/** A parse error carrying the position `yaml` gave us, so the message can point at a line. */
function parseErrorText(err: unknown): string {
  const pos = (err as { linePos?: [{ line: number; col: number }] }).linePos;
  const where = pos && pos[0] ? `${pos[0].line}:${pos[0].col}: ` : "";
  const message = err instanceof Error ? err.message : String(err);
  // yaml already prefixes its message with the position; keep ours and drop the duplicate block.
  return `${where}${message.split("\n")[0]!}`;
}

interface Checker {
  fail(message: string): void;
}

function str(value: unknown, key: string, chk: Checker): string | null {
  if (typeof value !== "string") {
    chk.fail(`\`${key}\` must be a string`);
    return null;
  }
  if (value.trim() === "") {
    chk.fail(`\`${key}\` must not be empty`);
    return null;
  }
  return value;
}

/**
 * Validate one parsed YAML document against the schema. Every problem is reported, not just the
 * first, so a single run tells the author everything wrong with the file.
 */
export function validateCaseFile(
  doc: unknown,
  name: string,
  file: string,
  fail: (message: string) => void,
): CaseFile | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    fail("expected a YAML mapping at the top level");
    return null;
  }
  const raw = doc as Record<string, unknown>;
  const chk: Checker = { fail };

  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) {
    fail(`unknown key(s): ${unknown.join(", ")} (expected ${[...KEYS].join(", ")})`);
  }

  const number = Number.parseInt(name.slice("tc-".length), 10);

  const id = str(raw["id"], "id", chk);
  if (id !== null) {
    const match = /^tc-(\d+)$/i.exec(id.trim());
    if (!match) fail(`\`id\` must look like TC-24, not ${JSON.stringify(id)}`);
    else if (Number.parseInt(match[1]!, 10) !== number) {
      fail(`\`id\` is ${id.trim()} but the file is named ${name}`);
    }
  }

  const title = str(raw["name"], "name", chk);
  const plan = str(raw["plan"], "plan", chk);

  let agent = SUPPORTED_AGENTS[0]!;
  if (raw["agent"] !== undefined) {
    const value = str(raw["agent"], "agent", chk);
    if (value !== null) {
      if (!SUPPORTED_AGENTS.includes(value)) {
        fail(
          `\`agent\` must be one of ${SUPPORTED_AGENTS.join(", ")}, not ${JSON.stringify(value)}`,
        );
      } else agent = value;
    }
  }

  let model: string | null = null;
  if (raw["model"] !== undefined) model = str(raw["model"], "model", chk);

  let parallel = true;
  if (raw["parallel"] !== undefined) {
    if (typeof raw["parallel"] !== "boolean") fail("`parallel` must be true or false");
    else parallel = raw["parallel"];
  }

  const tags: string[] = [];
  if (raw["tags"] !== undefined) {
    if (!Array.isArray(raw["tags"])) {
      fail("`tags` must be a list of strings");
    } else {
      for (const [i, tag] of raw["tags"].entries()) {
        const value = str(tag, `tags[${i}]`, chk);
        if (value !== null) tags.push(value.trim());
      }
      if (tags.length > 0 && parallel) {
        fail("`tags` only constrains a case with `parallel: false`; remove one or the other");
      }
    }
  }

  if (plan !== null) {
    // The plan travels in the prompt argv, so an unbounded one would die at spawn with E2BIG.
    const bytes = Buffer.byteLength(plan, "utf8");
    if (bytes > MAX_PROMPT_BYTES) {
      fail(`\`plan\` is ${bytes} bytes; the limit is ${MAX_PROMPT_BYTES}`);
    }
  }

  if (id === null || title === null || plan === null) return null;
  return { name, number, file, id: id.trim(), title, agent, model, parallel, tags, plan };
}

export interface LoadResult {
  cases: CaseFile[];
  errors: string[];
}

/**
 * Every `tc-<N>.yaml` under `_plans/`, parsed and validated. Errors accumulate across files so one
 * invocation reports every broken case rather than stopping at the first.
 */
export function loadCaseFiles(plansDir: string): LoadResult {
  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    return { cases: [], errors: [] };
  }

  const errors: string[] = [];
  const byName = new Map<string, string>();
  const collided = new Set<string>();
  const found: Array<[string, string]> = [];

  for (const entry of entries.sort()) {
    const name = caseNameOf(entry);
    if (name === null) continue;
    const file = join(plansDir, entry);
    if (!isFile(file)) continue;
    const seen = byName.get(name);
    if (seen !== undefined) {
      // Refuse both rather than guessing which one the author meant.
      errors.push(`${name}: both ${seen} and ${entry} exist; keep one`);
      collided.add(name);
      continue;
    }
    byName.set(name, entry);
    found.push([name, file]);
  }

  const cases: CaseFile[] = [];
  for (const [name, file] of found) {
    if (collided.has(name)) continue;
    const problems: string[] = [];
    const fail = (message: string): void => {
      problems.push(message);
    };
    let doc: unknown;
    try {
      doc = parse(readFileSync(file, "utf8"));
    } catch (err) {
      errors.push(`${name}.yaml: ${parseErrorText(err)}`);
      continue;
    }
    const kase = validateCaseFile(doc, name, file, fail);
    if (problems.length > 0) {
      for (const problem of problems) errors.push(`${name}: ${problem}`);
      continue;
    }
    if (kase !== null) cases.push(kase);
  }

  cases.sort((a, b) => a.number - b.number);
  return { cases, errors };
}
