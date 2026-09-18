import path from "node:path";
import { isInside, knownKeys, object, optionalString, strings } from "../../config-schema.js";
import { TARGETS } from "../types.js";
import type { AgentProfile, AgentTarget } from "../types.js";
import { locationFor } from "../install/index.js";
import { installsFor, parseInstallBlock } from "../install/config.js";

/**
 * The `agent.guard` block: which generated trees a repository refuses direct
 * edits to, and what to tell the editor instead.
 *
 * A third sibling of `agent.install` and `agent.verify` rather than a flag on
 * either, because it answers a third question — those declare what to *write*
 * and assert what is *there*; this decides what may be *edited*. Parsed here
 * for the reason the other two are: `agent` commands run with configuration
 * discovery disabled and resolve their own block, while `src/config.ts` calls
 * {@link parseGuardBlock} for its throw so a typo is an error at `md lint`
 * rather than a surprise inside a hook, where nobody is watching stderr.
 *
 * There is no `enabled:` key. `mode: off` is the switch, and a second spelling
 * of the same state is a way for the two to disagree.
 */

const BLOCK_KEYS = new Set(["mode", "unowned", "allow", "regenerate", "entries"]);
const ENTRY_KEYS = new Set(["name", "bundle", "target", "profile", "destination"]);

/** Local, because `src/agent/types.ts` declares the profile as a union, not a list. */
const PROFILES = ["plugin", "project"] as const;

export const GUARD_MODES = ["block", "warn", "off"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];

/**
 * What to do with a path that a target's declared output patterns describe but
 * that no configured bundle actually sources.
 *
 * `allow` is the default because a repository may keep hand-written content
 * beside generated content — a `.claude/agents/scratch.md` nobody renders is
 * not a cairn artifact, and blocking it would make the guard a nuisance rather
 * than a safeguard. `block` is for a repository whose agent tree is generated
 * in full, where anything cairn-shaped and unaccounted for is a mistake.
 */
export const UNOWNED_MODES = ["allow", "block"] as const;
export type UnownedMode = (typeof UNOWNED_MODES)[number];

/** One generated tree: the bundle that produces it, and where it lands. */
export interface GuardEntry {
  /** Stable identifier, reported in the payload. */
  name: string;
  /** Absolute bundle root: the directory holding `agent-bundle.yaml`. */
  bundle: string;
  /** The bundle root as written, for a message a user can act on. */
  bundlePath: string;
  target: AgentTarget;
  profile: AgentProfile;
  /** Absolute root the rendered tree was placed at. */
  destination: string;
}

export interface GuardConfig {
  /** Absolute path of the document this block came from. */
  file: string;
  /** Directory holding the document; every relative path resolves against it. */
  directory: string;
  mode: GuardMode;
  unowned: UnownedMode;
  /** Destination-relative POSIX paths the guard never claims. */
  allow: string[];
  /** The command that regenerates the tree, quoted back to the editor. */
  regenerate?: string;
  entries: GuardEntry[];
  /** True when `entries` was derived from `agent.install` rather than declared. */
  derived: boolean;
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

/**
 * Resolves a declared path against the document's directory and refuses one
 * that escapes it — the same rule `agent.verify` and `agent.install` apply, for
 * the same reason: a checked-in file must not be able to name a destination
 * outside the repository it describes.
 */
function contained(raw: string, directory: string, name: string): string {
  const resolved = path.resolve(directory, raw);
  if (!isInside(directory, resolved))
    throw new Error(`${name} escapes the configuration directory: ${raw}`);
  return resolved;
}

function entry(value: unknown, index: number, directory: string): GuardEntry {
  const name = `agent.guard.entries[${index}]`;
  const block = object(value, name);
  knownKeys(block, ENTRY_KEYS, name);

  const bundleRaw = optionalString(block.bundle, `${name}.bundle`);
  if (!bundleRaw) throw new Error(`${name}.bundle is required`);
  const targetRaw = optionalString(block.target, `${name}.target`);
  if (!targetRaw) throw new Error(`${name}.target is required`);
  if (!(TARGETS as readonly string[]).includes(targetRaw))
    throw new Error(`Unknown target in ${name}.target: ${targetRaw}`);
  const target = targetRaw as AgentTarget;

  const profileRaw = optionalString(block.profile, `${name}.profile`) ?? "project";
  if (!(PROFILES as readonly string[]).includes(profileRaw))
    throw new Error(`Unknown profile in ${name}.profile: ${profileRaw}`);
  const profile = profileRaw as AgentProfile;

  const destinationRaw = optionalString(block.destination, `${name}.destination`) ?? ".";

  return {
    name: optionalString(block.name, `${name}.name`) ?? `${bundleRaw}/${target}/${profile}`,
    bundle: contained(bundleRaw, directory, `${name}.bundle`),
    bundlePath: bundleRaw,
    target,
    profile,
    destination: contained(destinationRaw, directory, `${name}.destination`),
  };
}

/**
 * Entries implied by an `agent.install` block, so the common case restates
 * nothing. A declared `entries:` list is what a repository uses when it has no
 * install block, or generates through `agent convert` instead.
 *
 * Only **project**-scope locations are derived. A user-scope install lands
 * under `~` in a `marketplace` or `plugin-dir` layout whose destination nests
 * the bundle name below the declared root; that is not a tree an assistant
 * edits by accident, and guessing its shape here would be a second copy of
 * `planInstall`'s layout rules waiting to drift from the first.
 */
function derivedEntries(
  agent: unknown,
  context: { file: string; directory: string },
): GuardEntry[] {
  const install = parseInstallBlock(agent, context);
  if (!install || install.scope !== "project") return [];
  const entries: GuardEntry[] = [];
  for (const bundle of install.bundles)
    for (const target of install.targets) {
      if (!installsFor(bundle, target)) continue;
      const location = locationFor(target, "project");
      if (!location) continue;
      entries.push({
        name: `${bundle.path}/${target}/${location.profile}`,
        bundle: bundle.root,
        bundlePath: bundle.path,
        target,
        profile: location.profile,
        destination: install.into ?? path.resolve(install.root, location.root),
      });
    }
  return entries;
}

/**
 * Parses an `agent:` block's `guard` key. Returns `undefined` when absent — a
 * repository that declares nothing is not guarded, which is what makes the hook
 * safe to install globally.
 */
export function parseGuardBlock(
  value: unknown,
  context: { file: string; directory: string },
): GuardConfig | undefined {
  if (value === undefined) return undefined;
  const root = object(value, "agent");
  if (root.guard === undefined) return undefined;

  const block = object(root.guard, "agent.guard");
  knownKeys(block, BLOCK_KEYS, "agent.guard");

  const declared = block.entries;
  if (declared !== undefined && !Array.isArray(declared))
    throw new Error("agent.guard.entries must be a list");
  const list = (declared ?? []) as unknown[];
  const derived = !list.length;
  const entries = derived
    ? derivedEntries(value, context)
    : list.map((item, index) => entry(item, index, context.directory));

  const seen = new Set<string>();
  for (const item of entries) {
    if (seen.has(item.name)) throw new Error(`Duplicate agent.guard entry name: ${item.name}`);
    seen.add(item.name);
  }

  const allow = strings(block.allow, "agent.guard.allow", []);
  for (const pattern of allow)
    if (path.isAbsolute(pattern) || pattern.split("/").includes(".."))
      throw new Error(`agent.guard.allow must be destination-relative: ${pattern}`);

  return {
    file: context.file,
    directory: context.directory,
    mode: enumerated(block.mode, "agent.guard.mode", GUARD_MODES, "block"),
    unowned: enumerated(block.unowned, "agent.guard.unowned", UNOWNED_MODES, "allow"),
    allow,
    ...(block.regenerate !== undefined
      ? {
          regenerate: (() => {
            const text = optionalString(block.regenerate, "agent.guard.regenerate");
            if (!text) throw new Error("agent.guard.regenerate must be a non-empty string");
            return text;
          })(),
        }
      : {}),
    entries,
    derived,
  };
}

/**
 * True when a destination-relative path is allow-listed. An entry ending in
 * `/**` covers the directory and everything beneath it; anything else is an
 * exact path. Deliberately not the output-pattern grammar — an allow list a
 * user writes should read as paths, not as a second wildcard dialect.
 */
export function isAllowlisted(allow: readonly string[], relative: string): boolean {
  return allow.some((pattern) => {
    if (!pattern.endsWith("/**")) return pattern === relative;
    const prefix = pattern.slice(0, -3);
    return relative === prefix || relative.startsWith(`${prefix}/`);
  });
}
