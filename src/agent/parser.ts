import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AgentBundle,
  AgentDiagnostic,
  BundleRule,
  MarkdownComponent,
  SourceFile,
} from "./types.js";
import { diagnostic, TARGETS } from "./types.js";
import { CONDITIONAL_TEXT, validateConditionals } from "./conditionals.js";
import { normalizeManifest } from "./manifest.js";
import { loadOverlays } from "./overlays.js";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function readStructured(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, "utf8");
  try {
    return record(file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw), file);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
  }
}

export function splitFrontmatter(
  content: string,
  file: string,
): { metadata: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n"))
    return { metadata: {}, body: content };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`${file}: unmatched YAML frontmatter delimiter`);
  try {
    return {
      metadata: record(parseYaml(match[1]) ?? {}, `${file} frontmatter`),
      body: content.slice(match[0].length),
    };
  } catch (error) {
    throw new Error(`${file}: invalid frontmatter: ${(error as Error).message}`, { cause: error });
  }
}

function relativeSafe(root: string, candidate: string, label: string): string {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`${label} escapes the bundle root: ${candidate}`);
  let existing = resolved;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing))
    existing = path.dirname(existing);
  const realRoot = fs.realpathSync(root);
  const real = path.resolve(fs.realpathSync(existing), path.relative(existing, resolved));
  const realRelative = path.relative(realRoot, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative))
    throw new Error(`${label} resolves through a symlink outside the bundle: ${candidate}`);
  return resolved;
}

/**
 * Every file under `directory`, with root-relative paths in the platform's
 * separator. Refuses a symlink that resolves outside `directory`, which is why
 * callers outside this module use it rather than walking the tree themselves.
 */
export function allFiles(directory: string): SourceFile[] {
  if (!fs.existsSync(directory)) return [];
  const root = path.resolve(directory);
  const result: SourceFile[] = [];
  const visited = new Set<string>();
  const visit = (current: string): void => {
    const realCurrent = fs.realpathSync(current);
    if (visited.has(realCurrent)) return;
    visited.add(realCurrent);
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const real = fs.realpathSync(full);
        const rel = path.relative(root, real);
        if (rel.startsWith("..") || path.isAbsolute(rel))
          throw new Error(`Symlink escapes component directory: ${full}`);
      }
      if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(full).isDirectory()))
        visit(full);
      else if (entry.isFile() || entry.isSymbolicLink())
        result.push({
          path: path.relative(root, full),
          content: fs.readFileSync(full),
          mode: fs.statSync(full).mode & 0o777,
        });
    }
  };
  if (fs.statSync(root).isDirectory()) visit(root);
  return result;
}

function configuredPath(manifest: Record<string, unknown>, key: string, fallback: string): string {
  const components =
    manifest.components && typeof manifest.components === "object"
      ? (manifest.components as Record<string, unknown>)
      : {};
  const value = components[key] ?? manifest[key];
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).path === "string"
  )
    return String((value as Record<string, unknown>).path);
  return fallback;
}

function loadMarkdownComponents(
  root: string,
  relative: string,
  kind: "skill" | "agent" | "rule",
  diagnostics: AgentDiagnostic[],
): MarkdownComponent[] {
  const directory = relativeSafe(root, relative, `${kind} path`);
  if (!fs.existsSync(directory)) return [];
  const candidates =
    kind === "skill"
      ? allFiles(directory).filter(
          (file) => file.path === "SKILL.md" || file.path.endsWith(`${path.sep}SKILL.md`),
        )
      : allFiles(directory).filter(
          (file) =>
            file.path.endsWith(kind === "agent" ? ".agent.md" : ".md") ||
            (kind === "agent" && file.path.endsWith(".md")),
        );
  return candidates.map((candidate) => {
    const full = path.join(directory, candidate.path);
    const text = candidate.content.toString("utf8");
    const { metadata, body } = splitFrontmatter(text, full);
    const inferred =
      kind === "skill"
        ? path.basename(path.dirname(candidate.path))
        : path.basename(candidate.path).replace(/\.agent\.md$|\.md$/, "");
    const name = String(metadata.name ?? inferred);
    const description = String(metadata.description ?? "");
    if (metadata.name !== undefined && typeof metadata.name !== "string")
      diagnostics.push({
        ...diagnostic("AB107", `${kind} name must be a string`, "unsupported", { path: full }),
        severity: "error",
      });
    if (metadata.description !== undefined && typeof metadata.description !== "string")
      diagnostics.push({
        ...diagnostic("AB108", `${kind} description must be a string`, "unsupported", {
          path: full,
        }),
        severity: "error",
      });
    if (!NAME.test(name))
      diagnostics.push({
        ...diagnostic("AB101", `Invalid ${kind} name '${name}'`, "unsupported", {
          component: name,
          path: full,
          remediation: "Use lowercase kebab-case.",
        }),
        severity: "error",
      });
    if ((kind === "skill" || kind === "agent") && !description)
      diagnostics.push({
        ...diagnostic("AB102", `${kind} requires a description`, "unsupported", {
          component: name,
          path: full,
          remediation: "Add description to YAML frontmatter.",
        }),
        severity: "error",
      });
    validateConditionals(body, full, diagnostics);
    const componentRoot = kind === "skill" ? path.dirname(full) : directory;
    if (
      metadata.targets &&
      typeof metadata.targets === "object" &&
      !Array.isArray(metadata.targets)
    ) {
      for (const target of Object.keys(metadata.targets as Record<string, unknown>)) {
        if (!TARGETS.includes(target as never))
          diagnostics.push({
            ...diagnostic("AB104", `Unknown target override '${target}'`, "unsupported", {
              component: name,
              path: full,
            }),
            severity: "error",
          });
        else {
          const value = (metadata.targets as Record<string, unknown>)[target];
          if (!value || typeof value !== "object" || Array.isArray(value))
            diagnostics.push({
              ...diagnostic(
                "AB117",
                `Target override '${target}' must be an object`,
                "unsupported",
                {
                  component: name,
                  path: full,
                },
              ),
              severity: "error",
            });
        }
      }
    } else if (metadata.targets !== undefined)
      diagnostics.push({
        ...diagnostic("AB109", "targets must be an object", "unsupported", {
          component: name,
          path: full,
        }),
        severity: "error",
      });
    for (const field of ["include", "exclude"] as const)
      if (metadata[field] !== undefined && !Array.isArray(metadata[field]))
        diagnostics.push({
          ...diagnostic("AB110", `${field} must be an array of target IDs`, "unsupported", {
            component: name,
            path: full,
          }),
          severity: "error",
        });
    for (const field of ["include", "exclude"] as const)
      if (Array.isArray(metadata[field]))
        for (const target of metadata[field].map(String))
          if (!TARGETS.includes(target as never))
            diagnostics.push({
              ...diagnostic("AB106", `Unknown target '${target}' in ${field}`, "unsupported", {
                component: name,
                path: full,
              }),
              severity: "error",
            });
    for (const field of ["resources", "scripts"] as const) {
      const references = Array.isArray(metadata[field]) ? metadata[field] : [];
      for (const reference of references.map(String)) {
        try {
          const resolved = relativeSafe(componentRoot, reference, `${kind} ${field} reference`);
          if (!fs.existsSync(resolved))
            diagnostics.push({
              ...diagnostic("AB151", `Missing ${field} reference '${reference}'`, "unsupported", {
                component: name,
                path: full,
              }),
              severity: "error",
            });
        } catch (error) {
          diagnostics.push({
            ...diagnostic("AB152", (error as Error).message, "unsupported", {
              component: name,
              path: full,
            }),
            severity: "error",
          });
        }
      }
    }
    return { name, description, path: full, metadata, body, files: allFiles(componentRoot) };
  });
}

function findStructured(
  root: string,
  relative: string,
): { path: string; value: Record<string, unknown> } | undefined {
  const full = relativeSafe(root, relative, "component path");
  if (!fs.existsSync(full)) return undefined;
  if (fs.statSync(full).isFile()) return { path: full, value: readStructured(full) };
  const file = ["hooks.yaml", "hooks.yml", "hooks.json", "mcp.yaml", "mcp.yml", "mcp.json"]
    .map((name) => path.join(full, name))
    .find(fs.existsSync);
  return file ? { path: file, value: readStructured(file) } : undefined;
}

function loadPolicies(
  root: string,
  relative: string,
  diagnostics: AgentDiagnostic[],
): Array<{ path: string; value: Record<string, unknown> }> {
  const directory = relativeSafe(root, relative, "policies path");
  if (!fs.existsSync(directory)) return [];
  const files = fs.statSync(directory).isFile()
    ? [directory]
    : allFiles(directory)
        .filter((f) => /\.ya?ml$|\.json$/.test(f.path))
        .map((f) => path.join(directory, f.path));
  return files.map((file) => {
    const value = readStructured(file);
    const entries = Array.isArray(value.rules)
      ? value.rules
      : Array.isArray(value.policies)
        ? value.policies
        : [];
    for (const item of entries) {
      if (!item || typeof item !== "object") continue;
      const policy = item as Record<string, unknown>;
      if (!["allow", "prompt", "deny"].includes(String(policy.action ?? policy.decision)))
        diagnostics.push({
          ...diagnostic("AB140", "Policy action must be allow, prompt, or deny", "unsupported", {
            path: file,
          }),
          severity: "error",
        });
      if (
        !Array.isArray(policy.positiveExamples ?? policy.matches) ||
        !Array.isArray(policy.negativeExamples ?? policy.nonMatches)
      )
        diagnostics.push(
          diagnostic(
            "AB141",
            "Policy should include positive and negative match examples",
            "approximate",
            { path: file, remediation: "Add positiveExamples and negativeExamples arrays." },
          ),
        );
      const pattern = policy.pattern ?? policy.prefix ?? policy.command;
      const prefixes = Array.isArray(pattern)
        ? pattern.some(Array.isArray)
          ? pattern.map((part) => (Array.isArray(part) ? part.map(String).join(" ") : String(part)))
          : [pattern.map(String).join(" ")]
        : [String(pattern ?? "")];
      const matches = (example: unknown): boolean =>
        prefixes.some((prefix) => String(example).trim().startsWith(prefix.trim()));
      for (const example of (policy.positiveExamples ?? policy.matches ?? []) as unknown[])
        if (!matches(example))
          diagnostics.push({
            ...diagnostic(
              "AB142",
              `Positive example does not match the policy prefix: ${String(example)}`,
              "unsupported",
              { path: file },
            ),
            severity: "error",
          });
      for (const example of (policy.negativeExamples ?? policy.nonMatches ?? []) as unknown[])
        if (matches(example))
          diagnostics.push({
            ...diagnostic(
              "AB143",
              `Negative example matches the policy prefix: ${String(example)}`,
              "unsupported",
              { path: file },
            ),
            severity: "error",
          });
    }
    return { path: file, value };
  });
}

function detectCycles(bundle: AgentBundle): void {
  const graph = bundle.graph;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: string, trail: string[]): void => {
    if (visiting.has(node)) {
      bundle.diagnostics.push({
        ...diagnostic(
          "AB160",
          `Component dependency cycle: ${[...trail, node].join(" -> ")}`,
          "unsupported",
          { component: node, remediation: "Remove one of the cyclic skill/MCP references." },
        ),
        severity: "error",
      });
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of graph[node] ?? []) walk(child, [...trail, node]);
    visiting.delete(node);
    visited.add(node);
  };
  Object.keys(graph).forEach((node) => walk(node, []));
}

export function loadBundle(source: string): AgentBundle {
  const root = path.resolve(source);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    throw new Error(`Source is not a directory: ${source}`);
  const neutralPath = path.join(root, "agent-bundle.yaml");
  const legacyPath = path.join(root, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(neutralPath) && !fs.existsSync(legacyPath))
    throw new Error(`No agent-bundle.yaml or .claude-plugin/plugin.json found in ${source}`);
  const legacy = !fs.existsSync(neutralPath);
  const manifest = readStructured(legacy ? legacyPath : neutralPath);
  const diagnostics: AgentDiagnostic[] = [];
  if (legacy)
    diagnostics.push(
      diagnostic("AB001", "Imported legacy Claude Code plugin input", "exact", {
        path: legacyPath,
        remediation: "Add agent-bundle.yaml to adopt the neutral source format.",
      }),
    );
  const name = String(manifest.name ?? path.basename(root));
  // Schema-layer concerns — the accepted schemaVersion set, and the v2-only
  // marketplace and native blocks — live in manifest.ts. Everything below
  // stays here because it is identical across schema layers.
  const normalized = normalizeManifest(
    manifest,
    legacy ? legacyPath : neutralPath,
    legacy,
    path.basename(root),
    diagnostics,
  );
  if (!legacy) {
    for (const field of ["name", "version", "description"] as const)
      if (manifest[field] !== undefined && typeof manifest[field] !== "string")
        diagnostics.push({
          ...diagnostic("AB111", `Bundle field '${field}' must be a string`, "unsupported", {
            path: neutralPath,
          }),
          severity: "error",
        });
    if (
      manifest.version !== undefined &&
      typeof manifest.version === "string" &&
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    )
      diagnostics.push({
        ...diagnostic("AB113", `Invalid bundle version '${manifest.version}'`, "unsupported", {
          path: neutralPath,
          remediation: "Use a semantic version such as 1.0.0.",
        }),
        severity: "error",
      });
    if (
      manifest.targets !== undefined &&
      (!manifest.targets || typeof manifest.targets !== "object" || Array.isArray(manifest.targets))
    )
      diagnostics.push({
        ...diagnostic("AB114", "Bundle targets must be an object", "unsupported", {
          path: neutralPath,
        }),
        severity: "error",
      });
    else if (manifest.targets)
      for (const target of Object.keys(manifest.targets as Record<string, unknown>)) {
        if (!TARGETS.includes(target as never))
          diagnostics.push({
            ...diagnostic("AB115", `Unknown bundle target '${target}'`, "unsupported", {
              path: neutralPath,
            }),
            severity: "error",
          });
        else {
          const value = (manifest.targets as Record<string, unknown>)[target];
          if (!value || typeof value !== "object" || Array.isArray(value))
            diagnostics.push({
              ...diagnostic(
                "AB118",
                `Bundle target override '${target}' must be an object`,
                "unsupported",
                { path: neutralPath },
              ),
              severity: "error",
            });
        }
      }
  }
  if (!NAME.test(name))
    diagnostics.push({
      ...diagnostic("AB100", `Invalid bundle name '${name}'`, "unsupported", {
        path: legacy ? legacyPath : neutralPath,
        remediation: "Use lowercase kebab-case.",
      }),
      severity: "error",
    });
  for (const field of ["schemaVersion", "name", "version", "description"] as const)
    if (!legacy && (manifest[field] === undefined || manifest[field] === ""))
      diagnostics.push({
        ...diagnostic("AB103", `Missing required field '${field}'`, "unsupported", {
          path: neutralPath,
        }),
        severity: "error",
      });
  const skills = loadMarkdownComponents(
    root,
    configuredPath(manifest, "skills", "skills"),
    "skill",
    diagnostics,
  );
  const agents = loadMarkdownComponents(
    root,
    configuredPath(manifest, "agents", "agents"),
    "agent",
    diagnostics,
  );
  if (!legacy)
    for (const component of [...skills, ...agents])
      if (component.metadata.name === undefined)
        diagnostics.push({
          ...diagnostic("AB116", "Component frontmatter requires 'name'", "unsupported", {
            component: component.name,
            path: component.path,
          }),
          severity: "error",
        });
  const rawRules = loadMarkdownComponents(
    root,
    configuredPath(manifest, "rules", "rules"),
    "rule",
    diagnostics,
  );
  const rules: BundleRule[] = rawRules.map((rule) => ({
    ...rule,
    activation: String(rule.metadata.activation ?? "always") as BundleRule["activation"],
    globs: Array.isArray(rule.metadata.globs) ? rule.metadata.globs.map(String) : [],
  }));
  const primaryMarkdown = new Set(
    [...skills, ...agents, ...rules].map((component) => component.path),
  );
  // Validated wherever the renderer *processes* blocks, which is every textual
  // asset and not only Markdown: a broken block in a hook script used to be
  // silently mangled with no diagnostic at all.
  for (const file of allFiles(root)) {
    const full = path.join(root, file.path);
    if (primaryMarkdown.has(full)) continue;
    if (!CONDITIONAL_TEXT.test(file.path)) continue;
    const content = file.content;
    if (content.includes(0)) continue;
    validateConditionals(content.toString("utf8"), full, diagnostics, {
      markdown: file.path.endsWith(".md"),
    });
  }
  for (const rule of rules)
    if (!["always", "files", "model", "manual"].includes(rule.activation))
      diagnostics.push({
        ...diagnostic("AB130", `Unknown rule activation '${rule.activation}'`, "unsupported", {
          component: rule.name,
          path: rule.path,
        }),
        severity: "error",
      });
  for (const [kind, components] of [
    ["skill", skills],
    ["agent", agents],
    ["rule", rules],
  ] as const) {
    const seen = new Set<string>();
    for (const component of components) {
      if (seen.has(component.name))
        diagnostics.push({
          ...diagnostic("AB105", `Duplicate ${kind} name '${component.name}'`, "unsupported", {
            component: component.name,
            path: component.path,
          }),
          severity: "error",
        });
      seen.add(component.name);
    }
  }
  const skillNames = new Set(skills.map((skill) => skill.name));
  const graph: Record<string, string[]> = {};
  for (const component of [...skills, ...agents]) {
    const refs = Array.isArray(component.metadata.skills)
      ? component.metadata.skills.map(String)
      : [];
    graph[component.name] = refs;
    for (const ref of refs)
      if (!skillNames.has(ref))
        diagnostics.push({
          ...diagnostic("AB150", `Missing referenced skill '${ref}'`, "unsupported", {
            component: component.name,
            path: component.path,
            remediation: "Add the skill or remove the reference.",
          }),
          severity: "error",
        });
  }
  const assetsDir = relativeSafe(root, configuredPath(manifest, "assets", "assets"), "assets path");
  const hooksConfigured = configuredPath(manifest, "hooks", legacy ? "hooks/hooks.json" : "hooks");
  const hooks = findStructured(root, hooksConfigured);
  const hookRoot = relativeSafe(root, hooksConfigured, "hooks path");
  const hookDirectory =
    fs.existsSync(hookRoot) && fs.statSync(hookRoot).isDirectory()
      ? hookRoot
      : path.dirname(hookRoot);
  const hookFiles =
    !legacy && hooks && fs.existsSync(hookDirectory)
      ? allFiles(hookDirectory).filter((file) => path.join(hookDirectory, file.path) !== hooks.path)
      : [];
  const legacyAssets = legacy
    ? allFiles(root).filter((file) => {
        const normalized = file.path.split(path.sep).join("/");
        return (
          normalized !== ".claude-plugin/plugin.json" &&
          normalized !== "hooks/hooks.json" &&
          !normalized.startsWith("skills/") &&
          !/^agents\/.*\.md$/.test(normalized)
        );
      })
    : [];
  const bundle: AgentBundle = {
    schemaVersion: normalized.schemaVersion,
    name,
    version: normalized.version,
    description: normalized.description,
    root,
    legacy,
    manifest,
    ...(normalized.marketplace ? { marketplace: normalized.marketplace } : {}),
    overlays: loadOverlays(root, normalized.native, neutralPath, diagnostics),
    skills,
    agents,
    rules,
    hooks,
    hookFiles,
    policies: loadPolicies(root, configuredPath(manifest, "policies", "policies"), diagnostics),
    mcp: findStructured(root, configuredPath(manifest, "mcp", "mcp")),
    assets: legacy ? legacyAssets : fs.existsSync(assetsDir) ? allFiles(assetsDir) : [],
    diagnostics,
    graph,
  };
  detectCycles(bundle);
  bundle.diagnostics = [
    ...new Map(bundle.diagnostics.map((item) => [JSON.stringify(item), item])).values(),
  ];
  return bundle;
}
