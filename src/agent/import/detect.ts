import fs from "node:fs";
import path from "node:path";
import type { AgentProfile, AgentTarget, SourceFile } from "../types.js";
import { TARGETS } from "../types.js";
import { TARGET_PROFILES, outputPatternToRegExp, profileFor } from "../targets/index.js";

export interface DetectionCandidate {
  target: AgentTarget;
  profile: AgentProfile;
  score: number;
  /** Feature keys whose declared output patterns matched at least one file. */
  matchedFeatures: string[];
  /** Matches on patterns unique to this one (target, profile) pair. */
  distinctiveMatches: string[];
  hasManifest: boolean;
}

export interface DetectionResult {
  target: AgentTarget;
  profile: AgentProfile;
  confidence: "manifest" | "distinctive" | "scored" | "explicit";
  candidates: DetectionCandidate[];
}

/** Every (target, profile) pair the profiles declare. */
export function candidateLayouts(): Array<{ target: AgentTarget; profile: AgentProfile }> {
  return TARGETS.flatMap((target) =>
    profileFor(target).profiles.map((profile) => ({ target, profile })),
  );
}

/**
 * Output patterns that appear in exactly one (target, profile) cell.
 *
 * Derived from the profile matrix rather than hand-listed, so a future profile
 * edit cannot leave this stale. This is what stops `.mcp.json` — declared by
 * four different cells — from deciding anything, while `.cursor/rules/{name}.mdc`
 * or `.codex/agents/{name}.toml` decide immediately.
 */
export function distinctivePatterns(): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const { target, profile } of candidateLayouts())
    for (const entry of TARGET_PROFILES[target].outputs[profile] ?? []) {
      const cell = `${target}/${profile}`;
      const existing = owners.get(entry.pattern);
      if (existing) existing.add(cell);
      else owners.set(entry.pattern, new Set([cell]));
    }
  const distinctive = new Map<string, Set<string>>();
  for (const [pattern, cells] of owners) if (cells.size === 1) distinctive.set(pattern, cells);
  return distinctive;
}

function relativePaths(files: SourceFile[]): string[] {
  return files.map((file) => file.path.split(path.sep).join("/"));
}

/**
 * Scores a source tree against every declared native layout.
 *
 * Scoring counts *distinct features matched*, not files, so a plugin with forty
 * skills does not outrank one with skills, hooks, rules, and MCP.
 */
export function scoreLayouts(root: string, files: SourceFile[]): DetectionCandidate[] {
  const paths = relativePaths(files);
  const distinctive = distinctivePatterns();
  const candidates: DetectionCandidate[] = [];

  for (const { target, profile } of candidateLayouts()) {
    const targetProfile = TARGET_PROFILES[target];
    const matchedFeatures = new Set<string>();
    const distinctiveMatches: string[] = [];
    for (const entry of targetProfile.outputs[profile] ?? []) {
      const pattern = outputPatternToRegExp(entry.pattern);
      if (!paths.some((candidate) => pattern.test(candidate))) continue;
      matchedFeatures.add(entry.feature);
      if (distinctive.get(entry.pattern)?.has(`${target}/${profile}`))
        distinctiveMatches.push(entry.pattern);
    }
    const manifest = targetProfile.manifest;
    // `directory` is null for a host whose plugin manifest sits at the plugin
    // root. Requiring a directory here would make such a layout undetectable by
    // its manifest — the one signal that settles a plugin layout outright.
    const hasManifest =
      profile === "plugin" &&
      fs.existsSync(
        manifest.directory
          ? path.join(root, manifest.directory, manifest.file)
          : path.join(root, manifest.file),
      );

    candidates.push({
      target,
      profile,
      // A distinctive match is worth more than a shared one, and a manifest
      // settles a plugin layout outright.
      score: matchedFeatures.size + distinctiveMatches.length * 3 + (hasManifest ? 100 : 0),
      matchedFeatures: [...matchedFeatures].sort(),
      distinctiveMatches: distinctiveMatches.sort(),
      hasManifest,
    });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Determines which native layout a source tree is.
 *
 * Never guesses silently: an ambiguous tree throws and names the candidates so
 * the caller can pass `--from` explicitly.
 */
export function detectLayout(root: string, files: SourceFile[]): DetectionResult {
  const candidates = scoreLayouts(root, files);
  const best = candidates[0];
  if (!best || best.score === 0)
    throw new Error(
      `Could not detect a native layout in ${root}. Looked for: ` +
        candidateLayouts()
          .map(({ target, profile }) => `${target}/${profile}`)
          .join(", ") +
        ". Pass --from to select one explicitly.",
    );

  // A plugin candidate with no manifest is not a plugin layout at all.
  const viable = candidates.filter(
    (candidate) => candidate.profile !== "plugin" || candidate.hasManifest,
  );
  const chosen = viable[0] ?? best;
  const runnerUp = viable.find(
    (candidate) => candidate !== chosen && candidate.score === chosen.score,
  );
  if (runnerUp)
    throw new Error(
      `Ambiguous native layout in ${root}: ${chosen.target}/${chosen.profile} and ` +
        `${runnerUp.target}/${runnerUp.profile} score equally. Pass --from to select one.`,
    );

  return {
    target: chosen.target,
    profile: chosen.profile,
    confidence: chosen.hasManifest
      ? "manifest"
      : chosen.distinctiveMatches.length
        ? "distinctive"
        : "scored",
    candidates,
  };
}

/** Accepted `--from` values, generated from the profiles rather than hand-listed. */
export function fromSpecs(): string[] {
  return [
    "auto",
    ...TARGETS,
    ...candidateLayouts().map(({ target, profile }) => `${target}-${profile}`),
  ];
}

/** Resolves an explicit `--from`, falling back to detection for `auto`. */
export function resolveLayout(
  root: string,
  files: SourceFile[],
  from: string | undefined,
  scope: string | undefined,
): DetectionResult {
  const requested = from ?? "auto";
  if (requested === "auto" && (!scope || scope === "auto")) return detectLayout(root, files);

  const candidates = scoreLayouts(root, files);
  let target: AgentTarget | undefined;
  let profile: AgentProfile | undefined;

  if (requested !== "auto") {
    const pair = candidateLayouts().find(({ target: t, profile: p }) => `${t}-${p}` === requested);
    if (pair) {
      target = pair.target;
      profile = pair.profile;
    } else if (TARGETS.includes(requested as AgentTarget)) {
      target = requested as AgentTarget;
    } else {
      throw new Error(`Unknown --from '${requested}'. Use one of: ${fromSpecs().join(", ")}.`);
    }
  }
  if (!profile && scope && scope !== "auto") {
    if (scope !== "plugin" && scope !== "project")
      throw new Error(`Unknown --scope '${scope}'. Use plugin, project, or auto.`);
    profile = scope;
  }

  // Whatever was not pinned explicitly is chosen by score within what was.
  const narrowed = candidates.filter(
    (candidate) =>
      (!target || candidate.target === target) && (!profile || candidate.profile === profile),
  );
  if (!narrowed.length)
    throw new Error(
      `No layout matches --from '${requested}'${scope ? ` --scope '${scope}'` : ""}.`,
    );
  const chosen = narrowed[0];
  return {
    target: chosen.target,
    profile: chosen.profile,
    confidence: "explicit",
    candidates,
  };
}
