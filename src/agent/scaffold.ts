import { parseDocument } from "yaml";
import type { AgentTarget, Artifact } from "./types.js";
import { CURRENT_BUNDLE_SCHEMA, defaultOverlayRoot } from "./manifest.js";
import { PORTABLE_HOOK_EVENTS } from "./targets/schema.js";

/**
 * Component kinds `agent add` can create.
 *
 * Templates live here as TypeScript string constants rather than a data
 * directory: tsconfig sets `rootDir: "src"` with no `resolveJsonModule`, so a
 * `templates/` tree would never reach `dist` and the published package would
 * silently lack it.
 */
export const COMPONENT_KINDS = [
  "skill",
  "agent",
  "rule",
  "hook",
  "policy",
  "mcp",
  "overlay",
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface ManifestEdit {
  /** Path into the YAML document, e.g. `["components", "skills"]`. */
  path: string[];
  value: unknown;
  /** Skip the edit when the key already has a value. */
  onlyIfAbsent: boolean;
}

export interface ScaffoldResult {
  artifacts: Artifact[];
  edits: ManifestEdit[];
}

export interface BundleScaffoldSpec {
  name: string;
  version: string;
  description: string;
  license: string;
  components: ComponentKind[];
  targets: AgentTarget[];
  /** Create a `native/<target>/` overlay root with a README for each target. */
  overlays: boolean;
}

export interface ComponentScaffoldSpec {
  kind: ComponentKind;
  name: string;
  description: string;
  /** Component root override; when set, `agent add` must edit the manifest. */
  root?: string;
  activation: string;
  globs: string[];
  command?: string;
  /** Overlay target and output profile, for `kind: "overlay"`. */
  target?: AgentTarget;
  profile?: string;
}

function file(path: string, content: string, mode = 0o644): Artifact {
  return { path, content: Buffer.from(content), mode };
}

/** YAML options matching what `render.ts` emits, so scaffolds round-trip cleanly. */
export const YAML_OPTIONS = { lineWidth: 0, indentSeq: false } as const;

function manifestTemplate(spec: BundleScaffoldSpec): string {
  const lines = [
    "# Portable agent bundle. Render it with:",
    "#   cairn agent convert . --target all --output ./dist",
    `schemaVersion: "${CURRENT_BUNDLE_SCHEMA}"`,
    `name: ${spec.name}`,
    `version: ${spec.version}`,
    `description: ${JSON.stringify(spec.description)}`,
    "",
    "# Distribution metadata. Read by `agent package`; ignored by `agent convert`.",
    "marketplace:",
    `  displayName: ${JSON.stringify(spec.name)}`,
    `  summary: ${JSON.stringify(spec.description)}`,
    "  categories: []",
    "  publisher:",
    '    name: ""',
    `  license: ${spec.license}`,
    "  starterPrompts: []",
  ];
  if (spec.overlays && spec.targets.length) {
    lines.push(
      "",
      "# Target-native overlay roots. Files here are copied verbatim into the",
      "# matching target output and may not escape their target root.",
      "native:",
      ...spec.targets.map((target) => `  ${target}: ${defaultOverlayRoot(target)}`),
    );
  }
  return lines.join("\n") + "\n";
}

const OVERLAY_README = [
  "# Native overlay",
  "",
  "Files under `plugin/` and `project/` here are copied verbatim into the matching",
  "target output. They are not placeholder-rewritten and not target-block processed,",
  "because they are already native.",
  "",
  "Use this for platform-only features that have no defensible portable meaning.",
  "",
].join("\n");

export function skillTemplate(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Describe when this skill applies and what it should do.",
    "",
  ].join("\n");
}

export function agentTemplate(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "model: inherit",
    "---",
    "",
    `# ${name}`,
    "",
    "Describe this agent's responsibilities and boundaries.",
    "",
  ].join("\n");
}

export function ruleTemplate(
  name: string,
  description: string,
  activation: string,
  globs: string[],
): string {
  const lines = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`];
  lines.push(`activation: ${activation}`);
  if (globs.length) lines.push(`globs: [${globs.map((glob) => JSON.stringify(glob)).join(", ")}]`);
  lines.push("---", "", `# ${name}`, "", "State the rule as a direct instruction.", "");
  return lines.join("\n");
}

export function hookTemplate(event: string, command: string): string {
  return (
    [
      "# Portable hook events: " + PORTABLE_HOOK_EVENTS.join(", "),
      "hooks:",
      `  ${event}:`,
      "    - type: command",
      `      command: ${JSON.stringify(command)}`,
    ].join("\n") + "\n"
  );
}

export function hookScriptTemplate(event: string): string {
  return ["#!/bin/sh", `# ${event} hook. Exit non-zero to block the action.`, "exit 0", ""].join(
    "\n",
  );
}

export function policyTemplate(name: string, pattern: string): string {
  // Positive and negative examples are required for a clean parse: without them
  // the parser reports AB141, so a scaffold that omitted them would emit a
  // bundle that does not validate.
  return (
    [
      "rules:",
      `  - pattern: ${JSON.stringify(pattern)}`,
      `    action: prompt`,
      `    justification: ${JSON.stringify(`Review ${name} invocations before running them.`)}`,
      "    positiveExamples:",
      `      - ${JSON.stringify(`${pattern} --help`)}`,
      "    negativeExamples:",
      '      - "echo not-a-match"',
    ].join("\n") + "\n"
  );
}

export function mcpTemplate(name: string, command: string): string {
  return (
    ["mcpServers:", `  ${name}:`, `    command: ${JSON.stringify(command)}`, "    args: []"].join(
      "\n",
    ) + "\n"
  );
}

/** Default component root for each kind, matching what the parser discovers. */
export const DEFAULT_ROOTS: Record<ComponentKind, string> = {
  skill: "skills",
  agent: "agents",
  rule: "rules",
  hook: "hooks",
  policy: "policies",
  mcp: "mcp",
  overlay: "native",
};

/** Manifest `components` key for each kind, or `null` when it has none. */
export const MANIFEST_KEYS: Record<ComponentKind, string | null> = {
  skill: "skills",
  agent: "agents",
  rule: "rules",
  hook: "hooks",
  policy: "policies",
  mcp: "mcp",
  overlay: null,
};

/** The file one `agent add` invocation creates, relative to the component root. */
export function componentFile(spec: ComponentScaffoldSpec): string {
  switch (spec.kind) {
    case "skill":
      return `${spec.name}/SKILL.md`;
    case "agent":
      return `${spec.name}.agent.md`;
    case "rule":
      return `${spec.name}.md`;
    case "hook":
      return "hooks.yaml";
    case "policy":
      return `${spec.name}.yaml`;
    case "mcp":
      return "mcp.yaml";
    case "overlay":
      return `${spec.target}/${spec.profile}/.gitkeep`;
  }
}

export function scaffoldBundle(spec: BundleScaffoldSpec): ScaffoldResult {
  const artifacts: Artifact[] = [file("agent-bundle.yaml", manifestTemplate(spec))];
  for (const kind of spec.components) {
    const root = DEFAULT_ROOTS[kind];
    const componentSpec: ComponentScaffoldSpec = {
      kind,
      // A hook is keyed by its event, not by a free name, so scaffolding one
      // named after the bundle would emit a hook no target can map (AB320).
      name: kind === "hook" ? PORTABLE_HOOK_EVENTS[0] : spec.name,
      description: spec.description,
      activation: "always",
      globs: [],
    };
    artifacts.push(...componentArtifacts(componentSpec, root));
  }
  if (spec.overlays)
    for (const target of spec.targets)
      artifacts.push(file(`${defaultOverlayRoot(target)}/README.md`, OVERLAY_README));
  return { artifacts: sortArtifacts(artifacts), edits: [] };
}

function componentArtifacts(spec: ComponentScaffoldSpec, root: string): Artifact[] {
  const at = (relative: string, content: string, mode = 0o644) =>
    file(`${root}/${relative}`, content, mode);
  switch (spec.kind) {
    case "skill":
      return [at(componentFile(spec), skillTemplate(spec.name, spec.description))];
    case "agent":
      return [at(componentFile(spec), agentTemplate(spec.name, spec.description))];
    case "rule":
      return [
        at(
          componentFile(spec),
          ruleTemplate(spec.name, spec.description, spec.activation, spec.globs),
        ),
      ];
    case "hook": {
      const command = spec.command ?? `\${BUNDLE_ROOT}/hooks/${spec.name}.sh`;
      const artifacts = [at("hooks.yaml", hookTemplate(spec.name, command))];
      // Only scaffold a script when the hook runs one this bundle owns.
      if (!spec.command)
        artifacts.push(at(`${spec.name}.sh`, hookScriptTemplate(spec.name), 0o755));
      return artifacts;
    }
    case "policy":
      return [at(componentFile(spec), policyTemplate(spec.name, spec.command ?? spec.name))];
    case "mcp":
      return [at(componentFile(spec), mcpTemplate(spec.name, spec.command ?? spec.name))];
    case "overlay":
      return [at(componentFile(spec), "")];
  }
}

export function scaffoldComponent(spec: ComponentScaffoldSpec): ScaffoldResult {
  const root = spec.root ?? DEFAULT_ROOTS[spec.kind];
  const key = MANIFEST_KEYS[spec.kind];
  const edits: ManifestEdit[] =
    // Only a non-default root needs recording. Leaving the manifest untouched
    // in the common case is what keeps `agent add` byte-safe.
    spec.root && key ? [{ path: ["components", key], value: spec.root, onlyIfAbsent: false }] : [];
  return { artifacts: sortArtifacts(componentArtifacts(spec, root)), edits };
}

/** Byte order, never `localeCompare`, so a different ICU build cannot reorder output. */
export function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface ManifestEditResult {
  content: Buffer;
  /** False when no edit applied, in which case the source bytes are returned unchanged. */
  changed: boolean;
  /**
   * True when re-serializing the document would alter bytes even with no edit —
   * incidental whitespace normalization. Surfaced so `--dry-run` can warn.
   */
  reformatted: boolean;
}

/**
 * Applies edits to `agent-bundle.yaml` through a comment-preserving document.
 *
 * `parseDocument` keeps comments and key order, but does normalize incidental
 * whitespace, so the source bytes are returned untouched when no edit applies.
 * A plain `parse` + `stringify` would silently delete every comment the
 * scaffold wrote.
 */
export function applyManifestEdits(source: string, edits: ManifestEdit[]): ManifestEditResult {
  const document = parseDocument(source);
  const reformatted = document.toString(YAML_OPTIONS) !== source;
  let changed = false;
  for (const edit of edits) {
    if (edit.onlyIfAbsent && document.getIn(edit.path) !== undefined) continue;
    if (document.getIn(edit.path) === edit.value) continue;
    document.setIn(edit.path, edit.value);
    changed = true;
  }
  return {
    content: Buffer.from(changed ? document.toString(YAML_OPTIONS) : source),
    changed,
    reformatted: changed && reformatted,
  };
}
