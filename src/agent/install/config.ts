import fs from "node:fs";
import path from "node:path";
import { isInside, knownKeys, object, optionalString } from "../../config-schema.js";
import { TARGETS } from "../types.js";
import type { AgentTarget } from "../types.js";
import type { InstallScope } from "./index.js";
import { configIn } from "../../config.js";
import { readAgentDocument } from "../verify/resolve.js";

/**
 * The `agent.install` block: what a repository installs into itself.
 *
 * A sibling of `agent.verify` rather than a reuse of it, because the two answer
 * different questions — this one declares what to *write*, `verify` asserts what
 * is *there* — and a flag that could widen either would be a surprise in the
 * other. Parsed here rather than in `src/config.ts` for the reason `scripts:` is:
 * `agent` commands run with configuration discovery disabled, so they resolve
 * this block through their own walk. The loader still calls
 * {@link parseInstallBlock} for its throw, so a typo is an error at `md lint`
 * rather than a surprise at install time.
 */

const BLOCK_KEYS = new Set(["targets", "scope", "into", "link", "register", "bundles"]);
const BUNDLE_KEYS = new Set(["path", "include", "exclude"]);

/** One bundle in the block, with the targets it is installed for. */
export interface InstallSpecBundle {
  /** Config-relative POSIX path, as written. */
  path: string;
  /** Absolute bundle root. */
  root: string;
  include?: AgentTarget[];
  exclude?: AgentTarget[];
}

export interface InstallConfig {
  /** Absolute path to the document this block came from. */
  file: string;
  /** Absolute directory the document lives in; every bundle path resolves from it. */
  root: string;
  targets: AgentTarget[];
  scope: InstallScope;
  /** Absolute install root override, when the block declares `into`. */
  into?: string;
  link: boolean;
  register: boolean;
  bundles: InstallSpecBundle[];
}

function targetList(value: unknown, name: string): AgentTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be a list of target names`);
  const unknown = value.filter((item) => !(TARGETS as readonly string[]).includes(item as string));
  if (unknown.length) throw new Error(`Unknown target in ${name}: ${unknown.join(", ")}`);
  return [...new Set(value as string[])] as AgentTarget[];
}

function contained(raw: string, directory: string, name: string): string {
  const resolved = path.resolve(directory, raw);
  if (!isInside(directory, resolved))
    throw new Error(`${name} escapes the configuration directory: ${raw}`);
  return resolved;
}

function specBundle(value: unknown, index: number, directory: string): InstallSpecBundle {
  const name = `agent.install.bundles[${index}]`;
  const block = object(value, name);
  knownKeys(block, BUNDLE_KEYS, name);
  const raw = optionalString(block.path, `${name}.path`);
  if (!raw) throw new Error(`${name}.path is required`);
  const root = contained(raw, directory, `${name}.path`);
  const include = targetList(block.include, `${name}.include`);
  const exclude = targetList(block.exclude, `${name}.exclude`);
  // Same rule as the marketplace spec: one selector or the other, never both,
  // because their intersection has no reading a user would predict.
  if (include && exclude) throw new Error(`${name} declares both include and exclude`);
  return { path: raw, root, ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
}

/** True when `bundle` is installed for `target` under its include/exclude declaration. */
export function installsFor(bundle: InstallSpecBundle, target: AgentTarget): boolean {
  if (bundle.include) return bundle.include.includes(target);
  if (bundle.exclude) return !bundle.exclude.includes(target);
  return true;
}

/**
 * Parses an `agent:` block's `install` key. Returns `undefined` when absent, so
 * a document that declares only `verify:` is valid rather than an error.
 */
export function parseInstallBlock(
  value: unknown,
  context: { file: string; directory: string },
): InstallConfig | undefined {
  if (value === undefined) return undefined;
  const root = object(value, "agent");
  if (root.install === undefined) return undefined;

  const block = object(root.install, "agent.install");
  knownKeys(block, BLOCK_KEYS, "agent.install");

  const targets = targetList(block.targets, "agent.install.targets");
  if (!targets?.length) throw new Error("agent.install.targets must declare at least one target");

  const scopeRaw = optionalString(block.scope, "agent.install.scope") ?? "project";
  if (scopeRaw !== "user" && scopeRaw !== "project")
    throw new Error(`Unknown scope in agent.install.scope: ${scopeRaw}`);

  const intoRaw = optionalString(block.into, "agent.install.into");
  for (const key of ["link", "register"] as const)
    if (block[key] !== undefined && typeof block[key] !== "boolean")
      throw new Error(`agent.install.${key} must be a boolean`);

  const declared = block.bundles;
  if (declared !== undefined && !Array.isArray(declared))
    throw new Error("agent.install.bundles must be a list");
  const list = (declared ?? []) as unknown[];
  if (!list.length) throw new Error("agent.install.bundles must declare at least one bundle");
  const bundles = list.map((item, index) => specBundle(item, index, context.directory));

  const seen = new Set<string>();
  for (const bundle of bundles) {
    if (seen.has(bundle.root))
      throw new Error(`agent.install.bundles declares ${bundle.path} twice`);
    seen.add(bundle.root);
  }

  return {
    file: context.file,
    root: context.directory,
    targets,
    scope: scopeRaw,
    ...(intoRaw ? { into: contained(intoRaw, context.directory, "agent.install.into") } : {}),
    link: Boolean(block.link),
    register: Boolean(block.register),
    bundles,
  };
}

/** Validates that every declared bundle root exists. Deferred so a parse is pure. */
export function checkInstallConfig(config: InstallConfig): void {
  for (const bundle of config.bundles) {
    if (!fs.existsSync(bundle.root) || !fs.statSync(bundle.root).isDirectory())
      throw new Error(`agent.install bundle path is not a directory: ${bundle.path}`);
  }
}

function parseAt(file: string): InstallConfig | undefined {
  const directory = path.dirname(path.resolve(file));
  const document = readAgentDocument(file);
  if (document.agent === undefined) return undefined;
  return parseInstallBlock(document.agent, { file: path.resolve(file), directory });
}

/**
 * Finds the `agent.install` block, by explicit path or by walking up.
 *
 * The same discovery `agent verify` uses, and for the same reason: `agent`
 * commands run with configuration discovery disabled, so they resolve their own
 * block rather than reading it off `ResolvedConfig`.
 */
export function resolveInstallConfig(
  selection: { explicitPath?: string; cwd?: string } = {},
): InstallConfig {
  if (selection.explicitPath) {
    const file = path.resolve(selection.explicitPath);
    if (!fs.existsSync(file)) throw new Error(`Configuration file not found: ${file}`);
    const config = parseAt(file);
    if (!config) throw new Error(`No 'agent.install' block in ${file}`);
    checkInstallConfig(config);
    return config;
  }

  let current = path.resolve(selection.cwd ?? process.cwd());
  while (true) {
    const candidate = configIn(current);
    if (candidate) {
      const config = parseAt(candidate);
      if (config) {
        checkInstallConfig(config);
        return config;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    "No 'agent.install' block found. Declare one in .cairn.yml, or pass --config <file>.",
  );
}
