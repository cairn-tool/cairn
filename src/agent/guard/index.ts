import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isInside } from "../../config-schema.js";
import { configuredPath } from "../manifest.js";
import { matchOutputPattern, profileFor } from "../targets/index.js";
import type { OutputPatternMatch } from "../targets/schema.js";
import type { AgentProfile, AgentTarget } from "../types.js";
import { isAllowlisted } from "./config.js";
import type { GuardConfig, GuardEntry, GuardMode } from "./config.js";

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

function posix(value: string): string {
  return value.split(path.sep).join("/");
}

function isFile(candidate: string): boolean {
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
}

function isDirectory(candidate: string): boolean {
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
}

/**
 * The bundle manifest as a raw record, for {@link configuredPath} alone.
 *
 * Read directly rather than through `loadBundle`, which parses every component,
 * resolves dependencies, and validates conditionals — all of it wasted here,
 * and all of it able to throw on a bundle that is merely mid-edit. An
 * unreadable manifest yields `{}`, so the conventional roots still apply.
 */
function manifestOf(root: string): Record<string, unknown> {
  const file = path.join(root, "agent-bundle.yaml");
  if (!isFile(file)) return {};
  try {
    const value: unknown = parseYaml(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The declared `name:` in a Markdown file's frontmatter, if it has one. */
function frontmatterName(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  try {
    const value: unknown = parseYaml(text.slice(text.indexOf("\n") + 1, end + 1));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const declared = (value as Record<string, unknown>).name;
      if (typeof declared === "string") return declared;
    }
  } catch {
    // Frontmatter this malformed is the bundle's problem, not the guard's; the
    // conventional path has already been tried, so there is nothing else to do.
  }
  return undefined;
}

/**
 * The directory under `root` whose `SKILL.md` declares `name`.
 *
 * Only reached when the conventional `<root>/<name>/SKILL.md` does not exist,
 * which is rare: a component's rendered name is its frontmatter `name:` falling
 * back to the directory basename, so the two agree unless an author deliberately
 * made them differ.
 */
function skillDirectoryNamed(root: string, name: string): string | undefined {
  if (!isDirectory(root)) return undefined;
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const candidate = path.join(root, dirent.name, "SKILL.md");
    if (isFile(candidate) && frontmatterName(candidate) === name) return path.dirname(candidate);
  }
  return undefined;
}

/** The Markdown file under `root` whose frontmatter declares `name`. */
function markdownNamed(root: string, name: string): string | undefined {
  if (!isDirectory(root)) return undefined;
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    const candidate = path.join(root, dirent.name);
    if (frontmatterName(candidate) === name) return candidate;
  }
  return undefined;
}

/** The first of `names` present under `root`, as `findStructured` would pick it. */
function structuredIn(root: string, names: readonly string[]): string | undefined {
  if (isFile(root)) return root;
  return names.map((name) => path.join(root, name)).find(isFile);
}

/**
 * Asset paths `marketplace:` claims, relative to the assets root.
 *
 * A second reading of `marketplaceAssetPaths` in `src/agent/render.ts` rather
 * than a call to it: that one takes a fully loaded `AgentBundle`, and loading
 * one is the 400ms this module exists to avoid. The rule it implements is one
 * line of the manifest, and `tests/unit/agent-guard.test.ts` asserts the two
 * agree on every shipped bundle so they cannot drift apart unnoticed.
 */
function marketplaceAssets(manifest: Record<string, unknown>): Set<string> {
  const block = manifest.marketplace;
  if (!block || typeof block !== "object" || Array.isArray(block)) return new Set();
  const declared = block as Record<string, unknown>;
  const references = [
    declared.icon,
    ...(Array.isArray(declared.screenshots) ? declared.screenshots : []),
  ].filter((value): value is string => typeof value === "string");
  const root = posix(configuredPath(manifest, "assets", "assets"))
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const withheld = new Set<string>();
  for (const reference of references) {
    const normalized = posix(reference).replace(/^\.\//, "");
    if (root && normalized.startsWith(`${root}/`)) withheld.add(normalized.slice(root.length + 1));
    else if (!root) withheld.add(normalized);
  }
  return withheld;
}

/**
 * The bundle files that produce `match`, absolute, or `[]` when this bundle
 * does not source it.
 *
 * The feature vocabulary of an output pattern is the component-key vocabulary
 * of a manifest — `skills | agents | rules | hooks | policies | mcp | assets` —
 * so the source root is `configuredPath` on the very same key. No second table
 * is invented, and a bundle that relocates a component root is followed.
 */
function sourcesFor(
  bundleRoot: string,
  profile: AgentProfile,
  match: OutputPatternMatch,
): string[] {
  if (match.feature === "manifest") {
    const file = path.join(bundleRoot, "agent-bundle.yaml");
    return isFile(file) ? [file] : [];
  }

  const manifest = manifestOf(bundleRoot);
  const root = path.join(bundleRoot, configuredPath(manifest, match.feature, match.feature));

  switch (match.feature) {
    case "skills": {
      if (!match.name) return [];
      const conventional = path.join(root, match.name);
      const directory = isFile(path.join(conventional, "SKILL.md"))
        ? conventional
        : skillDirectoryNamed(root, match.name);
      if (!directory) return [];
      // A skill renders as a directory, so the pattern's trailing `**` is the
      // path *inside* it: point at the very file being edited where it exists,
      // and at the skill's own document otherwise.
      if (match.rest) {
        const inner = path.join(directory, ...match.rest.split("/"));
        if (isFile(inner)) return [inner];
      }
      return [path.join(directory, "SKILL.md")];
    }
    case "agents": {
      if (!match.name) return [];
      const conventional = [`${match.name}.agent.md`, `${match.name}.md`]
        .map((name) => path.join(root, name))
        .find(isFile);
      const file = conventional ?? markdownNamed(root, match.name);
      return file ? [file] : [];
    }
    case "rules": {
      // Codex aggregates every rule into one `AGENTS.md`, so its pattern is a
      // literal with no `{name}` — the source is the whole rules directory.
      if (!match.name) return isDirectory(root) ? [root] : [];
      const conventional = path.join(root, `${match.name}.md`);
      const file = isFile(conventional) ? conventional : markdownNamed(root, match.name);
      return file ? [file] : [];
    }
    case "hooks": {
      const document = structuredIn(root, ["hooks.yaml", "hooks.yml", "hooks.json"]);
      // The pattern is `hooks/**`, so the tail names either a handler script
      // copied beside the document or the rendered document itself — which is
      // always `hooks.json` however the source spelled it.
      if (match.rest) {
        const inner = path.join(root, ...match.rest.split("/"));
        if (isFile(inner)) return [inner];
        const rendered = !match.rest.includes("/") && /^hooks\.(json|ya?ml)$/.test(match.rest);
        return rendered && document ? [document] : [];
      }
      return document ? [document] : [];
    }
    case "mcp": {
      const document = structuredIn(root, ["mcp.yaml", "mcp.yml", "mcp.json"]);
      return document ? [document] : [];
    }
    case "policies":
      return isDirectory(root) || isFile(root) ? [root] : [];
    case "assets": {
      if (match.rest) {
        // `render.ts` withholds the assets `marketplace:` claims from the
        // project profile — they are catalog metadata no host reads at a
        // destination root. Claiming one here would refuse an edit to a file
        // the render never places.
        if (profile === "project" && marketplaceAssets(manifest).has(match.rest)) return [];
        // A named asset this bundle does not have is not this bundle's output.
        // Falling back to the assets root here would put every bundle that
        // merely *has* an assets directory in the answer.
        const inner = path.join(root, ...match.rest.split("/"));
        return isFile(inner) ? [inner] : [];
      }
      return isDirectory(root) ? [root] : [];
    }
    default:
      return [];
  }
}

/** The bundle's declared name, for a message that reads like the manifest. */
function bundleNameOf(bundleRoot: string): string {
  const declared = manifestOf(bundleRoot).name;
  return typeof declared === "string" ? declared : path.basename(bundleRoot);
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
