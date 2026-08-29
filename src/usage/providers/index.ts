import { antigravityProvider } from "./antigravity.js";
import { claudeCodeProvider } from "./claude-code.js";
import { codexProvider } from "./codex.js";
import type { UsageProvider } from "./types.js";

/**
 * Every provider whose logs `usage` can report on.
 *
 * Registering another assistant is a new module plus a line here. Nothing in
 * `src/commands/usage.ts` may branch on a provider's name: what a provider can
 * answer is read from its `capabilities`, the same rule that keeps
 * `src/agent/render.ts` free of per-target conditionals.
 */
export const PROVIDERS: readonly UsageProvider[] = [
  claudeCodeProvider,
  codexProvider,
  antigravityProvider,
];

export const DEFAULT_PROVIDER = claudeCodeProvider.name;

/** Selects every registered provider rather than one. */
export const ALL_PROVIDERS = "all";

export function providerNames(): string[] {
  return PROVIDERS.map((provider) => provider.name);
}

/**
 * Resolves `--provider` to the providers a report covers.
 *
 * `all` returns every registered provider; whether each has anything on this
 * machine is decided later, by `root()`, so that an unavailable one is simply
 * absent from the results rather than an error.
 */
export function resolveProviders(name: string | undefined): UsageProvider[] {
  const wanted = name ?? DEFAULT_PROVIDER;
  if (wanted === ALL_PROVIDERS) return [...PROVIDERS];
  const provider = PROVIDERS.find((candidate) => candidate.name === wanted);
  if (!provider) {
    throw new Error(
      `Unknown provider: ${wanted} (known: ${[...providerNames(), ALL_PROVIDERS].join(", ")})`,
    );
  }
  return [provider];
}

export type { UsageProvider } from "./types.js";
