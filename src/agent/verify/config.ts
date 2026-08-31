import path from "node:path";
import { isInside, knownKeys, object, optionalString } from "../../config-schema.js";
import { parseSemver } from "../targets/schema.js";
import { TARGETS } from "../types.js";
import type { AgentProfile, AgentTarget } from "../types.js";

/** Local, because `src/agent/types.ts` declares the profile as a union, not a list. */
const PROFILES = ["plugin", "project"] as const;

/**
 * The `agent.verify` block: what a repository claims its committed agent trees
 * were generated from, and which toolchain is allowed to have generated them.
 *
 * Parsed here rather than in `src/config.ts` for the reason `scripts:` is:
 * `agent` commands run with configuration discovery disabled, so they resolve
 * this block through their own walk. The loader still calls
 * {@link parseVerifyBlock} for its throw, so a typo is an error at `md lint`
 * rather than a surprise in CI.
 */

const ROOT_KEYS = new Set(["verify", "install"]);
const VERIFY_KEYS = new Set(["pins", "defaults", "entries"]);
const PIN_KEYS = new Set(["cli", "profileSchemaVersion", "targets"]);
const BOUND_KEYS = new Set(["exact", "min", "max"]);
const DEFAULT_KEYS = new Set(["unmanaged", "scope", "profile", "layout"]);
const ENTRY_KEYS = new Set([
  "name",
  "bundle",
  "target",
  "profile",
  "destination",
  "scope",
  "layout",
  "unmanaged",
]);

export const UNMANAGED_MODES = ["off", "orphaned", "strict"] as const;
export type UnmanagedMode = (typeof UNMANAGED_MODES)[number];

export const VERIFY_LAYOUTS = ["merge", "plugin-dir", "conversion"] as const;
export type VerifyLayout = (typeof VERIFY_LAYOUTS)[number];

export const VERIFY_SCOPES = ["user", "project"] as const;
export type VerifyScope = (typeof VERIFY_SCOPES)[number];

/**
 * An inclusive bound, never a range grammar.
 *
 * {@link compareSemver} is deliberately an ordering rather than a range parser,
 * and the target profiles record single bounds for the same reason. Accepting
 * `">=2.1 <3"` here would promise a grammar nothing else in the project has.
 */
export interface VersionBound {
  exact?: string;
  min?: string;
  max?: string;
}

export interface VerifyPins {
  cli?: VersionBound;
  profileSchemaVersion?: string;
  targets: Partial<Record<AgentTarget, VersionBound>>;
}

export interface VerifyEntry {
  /** Stable identifier for the entry, reported in findings and the payload. */
  name: string;
  /** Absolute bundle root: the directory holding `agent-bundle.yaml`. */
  bundle: string;
  target: AgentTarget;
  profile: AgentProfile;
  /** Absolute root the rendered tree was placed at. */
  destination: string;
  scope: VerifyScope;
  layout: VerifyLayout;
  unmanaged: UnmanagedMode;
}

export interface VerifyConfig {
  /** Absolute path of the document this block came from. */
  file: string;
  /** Directory holding the document; every relative path resolves against it. */
  directory: string;
  pins: VerifyPins;
  entries: VerifyEntry[];
}

export function emptyVerifyConfig(file: string, directory: string): VerifyConfig {
  return { file, directory, pins: { targets: {} }, entries: [] };
}

function version(value: unknown, name: string): string {
  const text = optionalString(value, name);
  if (text === undefined) throw new Error(`${name} is required`);
  if (!parseSemver(text)) throw new Error(`${name} must be a version: ${text}`);
  return text;
}

/**
 * A documentation revision is an ISO date, compared lexicographically — the
 * same comparison `agent doctor` already makes against
 * `host.documentationRevision`.
 */
function revision(value: unknown, name: string): string {
  const text = optionalString(value, name);
  if (text === undefined) throw new Error(`${name} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new Error(`${name} must be an ISO date (YYYY-MM-DD): ${text}`);
  return text;
}

function bound(value: unknown, name: string, parse: (raw: unknown, key: string) => string) {
  const block = object(value, name);
  knownKeys(block, BOUND_KEYS, name);
  if (!Object.keys(block).length) throw new Error(`${name} must declare exact, min, or max`);
  if (block.exact !== undefined && (block.min !== undefined || block.max !== undefined))
    throw new Error(`${name}.exact cannot be combined with min or max`);
  const parsed: VersionBound = {};
  if (block.exact !== undefined) parsed.exact = parse(block.exact, `${name}.exact`);
  if (block.min !== undefined) parsed.min = parse(block.min, `${name}.min`);
  if (block.max !== undefined) parsed.max = parse(block.max, `${name}.max`);
  return parsed;
}

function enumerated<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const text = optionalString(value, name);
  if (text === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(text))
    throw new Error(`${name} must be one of ${allowed.join(", ")}: ${text}`);
  return text as T;
}

function pins(value: unknown): VerifyPins {
  const block = object(value, "agent.verify.pins");
  knownKeys(block, PIN_KEYS, "agent.verify.pins");
  const targets: Partial<Record<AgentTarget, VersionBound>> = {};
  const declared = object(block.targets, "agent.verify.pins.targets");
  for (const [key, entry] of Object.entries(declared)) {
    if (!(TARGETS as readonly string[]).includes(key))
      throw new Error(`Unknown target in agent.verify.pins.targets: ${key}`);
    targets[key as AgentTarget] = bound(entry, `agent.verify.pins.targets.${key}`, revision);
  }
  return {
    ...(block.cli !== undefined ? { cli: bound(block.cli, "agent.verify.pins.cli", version) } : {}),
    ...(block.profileSchemaVersion !== undefined
      ? {
          profileSchemaVersion: (() => {
            const text = optionalString(
              block.profileSchemaVersion,
              "agent.verify.pins.profileSchemaVersion",
            );
            if (!text) throw new Error("agent.verify.pins.profileSchemaVersion must be a string");
            return text;
          })(),
        }
      : {}),
    targets,
  };
}

/**
 * Resolves a declared path against the document's directory and refuses one
 * that escapes it. A verify document describes its own repository; reaching
 * outside would let a checked-in file name an arbitrary destination.
 */
function contained(raw: string, directory: string, name: string): string {
  const resolved = path.resolve(directory, raw);
  if (!isInside(directory, resolved))
    throw new Error(`${name} escapes the configuration directory: ${raw}`);
  return resolved;
}

interface EntryDefaults {
  scope: VerifyScope;
  unmanaged: UnmanagedMode;
  profile?: AgentProfile;
  layout?: VerifyLayout;
}

function entry(value: unknown, index: number, directory: string, defaults: EntryDefaults) {
  const name = `agent.verify.entries[${index}]`;
  const block = object(value, name);
  knownKeys(block, ENTRY_KEYS, name);

  const bundleRaw = optionalString(block.bundle, `${name}.bundle`);
  if (!bundleRaw) throw new Error(`${name}.bundle is required`);
  const targetRaw = optionalString(block.target, `${name}.target`);
  if (!targetRaw) throw new Error(`${name}.target is required`);
  if (!(TARGETS as readonly string[]).includes(targetRaw))
    throw new Error(`Unknown target in ${name}.target: ${targetRaw}`);
  const target = targetRaw as AgentTarget;

  const profileRaw = optionalString(block.profile, `${name}.profile`) ?? defaults.profile;
  if (!profileRaw) throw new Error(`${name}.profile is required`);
  if (!(PROFILES as readonly string[]).includes(profileRaw))
    throw new Error(`Unknown profile in ${name}.profile: ${profileRaw}`);
  const profile = profileRaw as AgentProfile;

  const destinationRaw = optionalString(block.destination, `${name}.destination`) ?? ".";
  const bundle = contained(bundleRaw, directory, `${name}.bundle`);
  const destination = contained(destinationRaw, directory, `${name}.destination`);

  return {
    name: optionalString(block.name, `${name}.name`) ?? `${bundleRaw}/${target}/${profile}`,
    bundle,
    target,
    profile,
    destination,
    scope: enumerated(block.scope, `${name}.scope`, VERIFY_SCOPES, defaults.scope),
    layout: enumerated(block.layout, `${name}.layout`, VERIFY_LAYOUTS, defaults.layout ?? "merge"),
    unmanaged: enumerated(
      block.unmanaged,
      `${name}.unmanaged`,
      UNMANAGED_MODES,
      defaults.unmanaged,
    ),
  } satisfies VerifyEntry;
}

/**
 * Parses an `agent:` block. Returns an empty configuration when the key is
 * absent, so a document that declares nothing is valid rather than an error.
 */
export function parseVerifyBlock(
  value: unknown,
  context: { file: string; directory: string },
): VerifyConfig {
  if (value === undefined) return emptyVerifyConfig(context.file, context.directory);
  const root = object(value, "agent");
  knownKeys(root, ROOT_KEYS, "agent");
  if (root.verify === undefined) return emptyVerifyConfig(context.file, context.directory);

  const block = object(root.verify, "agent.verify");
  knownKeys(block, VERIFY_KEYS, "agent.verify");

  const defaultBlock = object(block.defaults, "agent.verify.defaults");
  knownKeys(defaultBlock, DEFAULT_KEYS, "agent.verify.defaults");
  const defaults: EntryDefaults = {
    scope: enumerated(defaultBlock.scope, "agent.verify.defaults.scope", VERIFY_SCOPES, "project"),
    unmanaged: enumerated(
      defaultBlock.unmanaged,
      "agent.verify.defaults.unmanaged",
      UNMANAGED_MODES,
      "orphaned",
    ),
    ...(defaultBlock.profile !== undefined
      ? {
          profile: enumerated(
            defaultBlock.profile,
            "agent.verify.defaults.profile",
            PROFILES,
            "project",
          ),
        }
      : {}),
    ...(defaultBlock.layout !== undefined
      ? {
          layout: enumerated(
            defaultBlock.layout,
            "agent.verify.defaults.layout",
            VERIFY_LAYOUTS,
            "merge",
          ),
        }
      : {}),
  };

  const declared = block.entries;
  if (declared !== undefined && !Array.isArray(declared))
    throw new Error("agent.verify.entries must be a list");
  const list = (declared ?? []) as unknown[];
  if (!list.length) throw new Error("agent.verify.entries must declare at least one entry");

  const entries = list.map((item, index) => entry(item, index, context.directory, defaults));
  const seen = new Set<string>();
  for (const item of entries) {
    if (seen.has(item.name)) throw new Error(`Duplicate agent.verify entry name: ${item.name}`);
    seen.add(item.name);
  }

  return { file: context.file, directory: context.directory, pins: pins(block.pins), entries };
}
