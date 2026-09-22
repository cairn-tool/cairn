import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configuredPath } from "../manifest.js";
import type { OutputPatternMatch } from "../targets/schema.js";
import type { AgentProfile } from "../types.js";

/**
 * Mapping a rendered path back to the bundle file that produces it.
 *
 * A leaf module on purpose: `agent guard` reaches it through `./index.js`, and
 * `agent install` reaches it directly to bake "edit this instead" pointers into
 * the guard script it generates. The installer cannot import `./index.js` --
 * that pulls in `./config.js`, which imports `../install/index.js` for
 * `locationFor`, and the cycle would close. Nothing here imports outside
 * `targets/` and `manifest.js`.
 */

export function posix(value: string): string {
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
export function sourcesFor(
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
export function bundleNameOf(bundleRoot: string): string {
  const declared = manifestOf(bundleRoot).name;
  return typeof declared === "string" ? declared : path.basename(bundleRoot);
}
