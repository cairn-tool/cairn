import path from "node:path";
import { isInside } from "../../config-schema.js";
import { matchOutputPattern, profileFor } from "../targets/index.js";
import type { OutputPatternMatch } from "../targets/schema.js";
import type { AgentProfile, AgentTarget } from "../types.js";
import { isAllowlisted } from "./config.js";
import type { GuardConfig, GuardEntry, GuardMode } from "./config.js";
import { bundleNameOf, posix, sourcesFor } from "./sources.js";

/**
 * Deciding whether a path is cairn's output, and which bundle file produced it.
 *
 * The oracle is the target profile's own declared output patterns, confirmed by
 * the owning bundle actually holding the component the pattern's `{name}`
 * identifies. Nothing is rendered and no bundle is loaded: a `renderBundle` is
 * roughly 400ms, and this runs inside a `PreToolUse` hook on every write.
 *
 * Confirming ownership is not belt-and-braces. It is the same lookup that
 * produces the "edit this instead" pointer the guard exists to give, and it is
 * what keeps a hand-written `.claude/agents/scratch.md` sitting beside
 * generated ones from being refused.
 */

export type GuardDecision = "block" | "warn" | "allow";

export type GuardReason =
  /** A configured bundle sources this path. */
  | "generated"
  /** A declared output pattern describes it, but no configured bundle sources it. */
  | "unowned"
  /** Outside every configured destination, or no pattern describes it. */
  | "unmatched"
  /** Covered by `agent.guard.allow`. */
  | "allowlisted"
  /** `agent.guard.mode: off`. */
  | "disabled"
  /**
   * No document declares an `agent.guard` block. Produced by the command rather
   * than by {@link classifyPath}, and by far the commonest outcome: the hook is
   * installed once with the plugin and most repositories never opt in.
   */
  | "not-configured";

export interface GuardMatch {
  target: AgentTarget;
  profile: AgentProfile;
  /** Absolute destination root the match was made under. */
  destination: string;
  /** The edited path, relative to `destination`, POSIX-separated. */
  relative: string;
  feature: string;
  /** The segment the pattern's `{name}` consumed, when it has one. */
  name?: string;
  pattern: string;
}

export interface GuardVerdict {
  /** The resolved absolute path that was judged. */
  path: string;
  decision: GuardDecision;
  reason: GuardReason;
  match?: GuardMatch;
  bundle?: { name: string; path: string };
  /**
   * Bundle source files to edit instead, relative to the configuration
   * directory. More than one when the rendered file merges several bundles —
   * `.claude/settings.json` and `.mcp.json` are the whole repository's, not one
   * bundle's.
   */
  sources: string[];
}

function relativeUnder(destination: string, target: string): string | undefined {
  if (!isInside(destination, target)) return undefined;
  const relative = posix(path.relative(destination, target));
  return relative ? relative : undefined;
}

/**
 * The declared match for `relative`, in both shapes the caller needs: the
 * payload row, and the raw pattern match whose `rest` names the file inside a
 * skill or hooks directory.
 */
function matchFor(
  entry: GuardEntry,
  relative: string,
): { row: GuardMatch; pattern: OutputPatternMatch } | undefined {
  const found = matchOutputPattern(profileFor(entry.target), entry.profile, relative);
  if (!found) return undefined;
  return {
    row: {
      target: entry.target,
      profile: entry.profile,
      destination: entry.destination,
      relative,
      feature: found.feature,
      ...(found.name !== undefined ? { name: found.name } : {}),
      pattern: found.pattern,
    },
    pattern: found,
  };
}

/**
 * Judges one path against a repository's guard configuration.
 *
 * Every entry is considered, not just the first that matches: one destination
 * commonly holds several bundles rendering through the same patterns, and the
 * bundle that actually owns the name is the one worth naming. A path that some
 * pattern describes but that nothing sources falls through to `unowned`, whose
 * severity the configuration decides.
 */
export function classifyPath(target: string, config: GuardConfig): GuardVerdict {
  const resolved = path.resolve(target);
  if (config.mode === "off")
    return { path: resolved, decision: "allow", reason: "disabled", sources: [] };

  const blocked: GuardDecision = config.mode === "warn" ? "warn" : "block";
  let described: GuardMatch | undefined;
  const merged: { match: GuardMatch; bundle: GuardEntry; sources: string[] }[] = [];

  for (const entry of config.entries) {
    const relative = relativeUnder(entry.destination, resolved);
    if (relative === undefined) continue;
    if (isAllowlisted(config.allow, relative))
      return { path: resolved, decision: "allow", reason: "allowlisted", sources: [] };

    const found = matchFor(entry, relative);
    if (!found) continue;
    const match = found.row;
    described ??= match;

    const sources = sourcesFor(entry.bundle, entry.profile, found.pattern);
    if (!sources.length) continue;

    // A named component belongs to exactly one bundle, so the first owner
    // settles it. A leaf file with no `{name}` — `.claude/settings.json`,
    // `.mcp.json`, Codex's `AGENTS.md` — is merged from every bundle that has
    // the component, so every one of them is a file worth editing.
    if (match.name !== undefined)
      return {
        path: resolved,
        decision: blocked,
        reason: "generated",
        match,
        bundle: { name: bundleNameOf(entry.bundle), path: entry.bundlePath },
        sources: sources.map((file) => posix(path.relative(config.directory, file))),
      };
    merged.push({ match, bundle: entry, sources });
  }

  if (merged.length) {
    const first = merged[0];
    return {
      path: resolved,
      decision: blocked,
      reason: "generated",
      match: first.match,
      ...(merged.length === 1
        ? { bundle: { name: bundleNameOf(first.bundle.bundle), path: first.bundle.bundlePath } }
        : {}),
      sources: [
        ...new Set(
          merged.flatMap((item) =>
            item.sources.map((file) => posix(path.relative(config.directory, file))),
          ),
        ),
      ].sort(),
    };
  }

  if (described)
    return {
      path: resolved,
      decision: config.unowned === "block" ? blocked : "allow",
      reason: "unowned",
      match: described,
      sources: [],
    };

  return { path: resolved, decision: "allow", reason: "unmatched", sources: [] };
}

/** The `guard` block of an `AgentResult`. */
export interface GuardReport extends GuardVerdict {
  /** Absolute path of the document declaring `agent.guard`, or `null`. */
  config: string | null;
  /** The configured mode, or `null` when nothing is configured. */
  mode: GuardMode | null;
  /** The command that regenerates the tree, when the configuration names one. */
  regenerate?: string;
  /**
   * The prose an editor is shown. Built here rather than in the formatter
   * because the hook reads it out of `--format json` and the human and llm
   * renderings must not be able to say something different.
   */
  message: string;
}

/**
 * The refusal, or the warning, as an editor sees it.
 *
 * It names the file, the bundle, every source worth editing, and the command
 * that regenerates — because a hook's stderr is the whole of what an assistant
 * gets, and a refusal it cannot act on just makes it try something else.
 */
export function guardMessage(report: Omit<GuardReport, "message">): string {
  if (report.decision === "allow") return "";
  const relative = report.match?.relative ?? report.path;
  const lead =
    report.decision === "block"
      ? "Refusing to edit a cairn-generated file."
      : "Editing a cairn-generated file; the next render will overwrite it.";
  const lines = [lead, ""];
  if (report.reason === "unowned") {
    lines.push(
      `  ${relative}`,
      `  is a generated path for ${report.match?.target}/${report.match?.profile}, but no`,
      "  configured bundle sources it.",
      "",
      "Either edit the bundle that should own it, or add the path to",
      "agent.guard.allow in the cairn configuration.",
    );
  } else {
    const bundle = report.bundle ? ` from bundle '${report.bundle.name}'` : "";
    lines.push(
      `  ${relative}`,
      `  is generated by cairn${bundle} (${report.match?.target}/${report.match?.profile}).`,
      "",
      report.sources.length === 1 ? "Edit the source instead:" : "Edit the source instead, in:",
      ...report.sources.map((source) => `  ${source}`),
    );
  }
  if (report.regenerate) lines.push("", "Then regenerate:", `  ${report.regenerate}`);
  return lines.join("\n");
}
