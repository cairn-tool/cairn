import { claudeCodeProvider } from "./claude-code.js";
import type { UsageProvider } from "./types.js";

/**
 * Every provider whose logs `usage` can report on.
 *
 * Registering a second LLM is a new module plus a line here. Nothing in
 * `src/commands/usage.ts` may branch on a provider's name: what a provider can
 * answer is read from its `capabilities`, the same rule that keeps
 * `src/agent/render.ts` free of per-target conditionals.
 */
export const PROVIDERS: readonly UsageProvider[] = [claudeCodeProvider];

export const DEFAULT_PROVIDER = claudeCodeProvider.name;

export function resolveProvider(name: string | undefined): UsageProvider {
  const wanted = name ?? DEFAULT_PROVIDER;
  const provider = PROVIDERS.find((candidate) => candidate.name === wanted);
  if (!provider) {
    throw new Error(
      `Unknown provider: ${wanted} (known: ${PROVIDERS.map((item) => item.name).join(", ")})`,
    );
  }
  return provider;
}

export type { UsageProvider } from "./types.js";
