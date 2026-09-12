import { UserError, which } from "../config.js";
import { findExplicitAgent } from "../config.js";
import { claudeCodeProfile } from "./claude-code.js";
import { codexProfile } from "./codex.js";
import { cursorProfile } from "./cursor.js";
import type { QaAgentProfile } from "./types.js";

/**
 * Every backend `qa run` can spawn.
 *
 * Registering another assistant is a new module plus a line here. Nothing
 * outside this directory may branch on an agent's name: argv, event parsing,
 * and the default model are read from the profile.
 */
// Cursor stays first because an omitted `agent:` defaults to the first registered profile.
export const AGENTS: readonly QaAgentProfile[] = [cursorProfile, claudeCodeProfile, codexProfile];

for (const profile of AGENTS) {
  if (
    profile.maxParallel !== undefined &&
    (!Number.isInteger(profile.maxParallel) || profile.maxParallel < 1)
  ) {
    throw new Error(`qa agent profile ${profile.name} maxParallel must be >= 1`);
  }
}

export const SUPPORTED_AGENTS: readonly string[] = AGENTS.map((profile) => profile.name);

const BY_NAME = new Map(AGENTS.map((profile) => [profile.name, profile]));

const binaryCache = new Map<string, string>();

export function resolveAgent(name: string): QaAgentProfile {
  const profile = BY_NAME.get(name);
  if (!profile) {
    throw new UserError(`Unknown agent: ${name} (known: ${SUPPORTED_AGENTS.join(", ")})`);
  }
  return profile;
}

export function defaultModels(): Record<string, string> {
  return Object.fromEntries(AGENTS.map((profile) => [profile.name, profile.defaultModel]));
}

/**
 * Resolve the executable for one profile. An explicit `--agent` path overrides
 * every backend — that is the fake-agent test hook. PATH lookup is lazy and
 * cached per profile so a one-backend queue does not require either of the
 * other binaries to be installed.
 */
export function resolveBinary(name: string, explicit: string | null): string {
  if (explicit) return findExplicitAgent(explicit);
  const hit = binaryCache.get(name);
  if (hit) return hit;
  const profile = resolveAgent(name);
  for (const candidate of profile.binaries) {
    const found = which(candidate);
    if (found) {
      binaryCache.set(name, found);
      return found;
    }
  }
  throw new UserError(
    `${profile.binaries[0]} not on PATH; pass --agent /path/to/${profile.binaries[0]}`,
  );
}

/**
 * The executable to *display* for a profile, for --dry-run only.
 *
 * Falls back to the profile's first candidate name when nothing is on PATH: previewing a
 * queue launches nothing, so requiring the backend to be installed would make `qa run
 * --dry-run` fail on exactly the machine you would preview a queue on — and would make the
 * e2e suite depend on real agent binaries being present on the CI runner. An explicit --agent
 * is still validated, because a bad path there is a real invocation error.
 */
export function displayBinary(name: string, explicit: string | null): string {
  if (explicit) return findExplicitAgent(explicit);
  try {
    return resolveBinary(name, null);
  } catch {
    return resolveAgent(name).binaries[0]!;
  }
}

export function agentCaps(parallel: number): ReadonlyMap<string, number> {
  const caps = new Map<string, number>();
  for (const profile of AGENTS) {
    // An absent cap means --parallel alone decides, so a queue of one backend can use
    // every slot the user asked for.
    caps.set(profile.name, Math.min(profile.maxParallel ?? parallel, parallel));
  }
  return caps;
}

export type { AgentArgvInput, NormalizedEvents, QaAgentProfile, QaEvent } from "./types.js";
export { asEventList } from "./types.js";
