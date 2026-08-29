import type { AgentTarget } from "../types.js";
import { TARGETS } from "../types.js";
import { packageName, packageVersion } from "../../version.js";
import { antigravityProfile } from "./antigravity.js";
import { claudeCodeProfile } from "./claude-code.js";
import { codexProfile } from "./codex.js";
import { cursorProfile } from "./cursor.js";
import type { PortableHookEvent, TargetProfile } from "./schema.js";
import { FEATURE_KEYS, PORTABLE_HOOK_EVENTS, PROFILE_SCHEMA_VERSION } from "./schema.js";

export * from "./schema.js";

/**
 * The single source of truth for target behavior. This is an exhaustive record,
 * so adding a target is a compile error until every profile field is supplied.
 */
export const TARGET_PROFILES: Record<AgentTarget, TargetProfile> = {
  "claude-code": claudeCodeProfile,
  codex: codexProfile,
  cursor: cursorProfile,
  antigravity: antigravityProfile,
};

export function profileFor(target: AgentTarget): TargetProfile {
  return TARGET_PROFILES[target];
}

/** Native hook event name, or `undefined` when the target cannot express it. */
export function nativeHookEvent(target: AgentTarget, portable: string): string | undefined {
  const events = TARGET_PROFILES[target].hooks.events as Record<string, string | null>;
  return events[portable] ?? undefined;
}

function buildHookEventAliases(): Record<string, PortableHookEvent> {
  const aliases: Record<string, PortableHookEvent> = {};
  for (const event of PORTABLE_HOOK_EVENTS) {
    aliases[event] = event;
    for (const target of TARGETS) {
      const native = TARGET_PROFILES[target].hooks.events[event];
      if (native) aliases[native] = event;
    }
  }
  return aliases;
}

/**
 * Every native hook event name mapped back to its portable form, derived from
 * the profiles so a new target's spelling is understood on import automatically.
 */
export const HOOK_EVENT_ALIASES: Record<string, PortableHookEvent> = buildHookEventAliases();

/**
 * The per-component compatibility summary, generated from the profiles. Shares
 * the shape of the free-text table it replaced so existing consumers of
 * `agent compat --format json` keep working.
 */
export function compatibilityMatrix(
  targets: readonly AgentTarget[],
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    targets.map((target) => [
      target,
      Object.fromEntries(
        FEATURE_KEYS.map((key) => [key, TARGET_PROFILES[target].features[key].summary]),
      ),
    ]),
  );
}

export interface SpecsPayload {
  schemaVersion: string;
  generator: { name: string; version: string };
  targets: Record<string, TargetProfile>;
}

export function specsPayload(targets: readonly AgentTarget[]): SpecsPayload {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    generator: { name: packageName, version: packageVersion },
    targets: Object.fromEntries(targets.map((target) => [target, TARGET_PROFILES[target]])),
  };
}
