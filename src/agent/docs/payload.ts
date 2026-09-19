import path from "node:path";
import type {
  BundleDiagnostic,
  BundleJsonDocument,
  DocumentedBundle,
  DocumentedComponent,
  DocumentedComponents,
  DocumentedDependency,
  DocumentedRule,
  MarketplaceListing,
  RenderedArtifact,
  TargetRender,
} from "@cairn-tool/agent-bundle-schema";
import { renderBundle, selected } from "../render.js";
import { featureVisible } from "../targets/index.js";
import type {
  AgentBundle,
  AgentDiagnostic,
  AgentProfile,
  AgentTarget,
  BundleRule,
  MarkdownComponent,
} from "../types.js";

/** Both output profiles, in the order a render matrix lists them. */
export const PROFILES: readonly AgentProfile[] = ["plugin", "project"];

export interface DocumentSelection {
  targets: AgentTarget[];
  profiles: AgentProfile[];
}

/**
 * Byte order, not locale order.
 *
 * Every array in the artifact is sorted with it. A documentation artifact is
 * fingerprinted by its consumer -- `kps-docs` compares a rebuilt document
 * against a committed fixture -- so two runs over the same bundle have to
 * produce the same bytes, on any machine, under any locale.
 */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A path as the bundle spells it: relative to the bundle root, POSIX-separated.
 *
 * The parsed model carries absolute filesystem paths, which `agent inspect`
 * emits as-is. That is fine for a command result a person is reading on the
 * machine that produced it, and wrong for a published document: it would leak
 * the author's home directory and change the artifact's fingerprint on every
 * machine that rebuilt it.
 */
function bundleRelative(root: string, target: string): string {
  const absolute = path.isAbsolute(target) ? target : path.join(root, target);
  return path.relative(root, absolute).split(path.sep).join("/");
}

function documentComponent(root: string, component: MarkdownComponent): DocumentedComponent {
  const source = bundleRelative(root, component.path);
  const directory = path.posix.dirname(source);
  return {
    name: component.name,
    description: component.description,
    source,
    metadata: component.metadata,
    body: component.body,
    // Component files are recorded relative to the component's own directory;
    // every other path in the artifact is relative to the bundle root, so they
    // are rebased here rather than leaving the consumer to guess which is which.
    files: component.files
      .map((file) => path.posix.join(directory, file.path.split(path.sep).join("/")))
      .sort(byBytes),
  };
}

function documentRule(root: string, rule: BundleRule): DocumentedRule {
  return {
    ...documentComponent(root, rule),
    activation: rule.activation,
    globs: [...rule.globs].sort(byBytes),
  };
}

function documentJson(
  root: string,
  document: { path: string; value: Record<string, unknown> },
): BundleJsonDocument {
  return { path: bundleRelative(root, document.path), value: document.value };
}

function documentDiagnostic(diagnostic: AgentDiagnostic): BundleDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.component ? { component: diagnostic.component } : {}),
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.target ? { target: diagnostic.target } : {}),
    ...(diagnostic.profile ? { profile: diagnostic.profile } : {}),
    quality: diagnostic.quality,
    ...(diagnostic.remediation ? { remediation: diagnostic.remediation } : {}),
  };
}

function documentDependencies(bundle: AgentBundle): DocumentedDependency[] {
  return bundle.dependencies
    .map((dependency) => ({
      name: dependency.name,
      skills: [...dependency.skills].sort(byBytes),
      agents: [...dependency.agents].sort(byBytes),
    }))
    .sort((a, b) => byBytes(a.name, b.name));
}

/**
 * The render matrix: what the bundle produces for each host and profile.
 *
 * Produced by the renderer itself rather than reconstructed from the target
 * profiles, so the artifact cannot claim a layout `agent convert` would not
 * actually write. Content is dropped and only the shape kept -- this documents
 * an installation, it is not a copy of one.
 */
function documentTargets(
  artifacts: Array<{ path: string; content: Buffer; mode: number; origin?: string }>,
  selection: DocumentSelection,
): TargetRender[] {
  const renders: TargetRender[] = [];
  for (const target of selection.targets)
    for (const profile of selection.profiles) {
      const prefix = `${target}/${profile}/`;
      const files: RenderedArtifact[] = artifacts
        .filter((artifact) => artifact.path.startsWith(prefix))
        .map((artifact) => ({
          path: artifact.path.slice(prefix.length),
          bytes: artifact.content.length,
          mode: `0${artifact.mode.toString(8)}`,
          ...(artifact.origin === "native" ? { origin: "native" as const } : {}),
        }))
        .sort((a, b) => byBytes(a.path, b.path));
      // A combination that renders nothing is left out rather than shown empty:
      // OpenCode, for one, has no plugin-profile install location at all.
      if (files.length > 0) renders.push({ target, profile, artifacts: files });
    }
  return renders;
}

function documentComponents(
  bundle: AgentBundle,
  selection: DocumentSelection,
): DocumentedComponents {
  const reaches = (component: MarkdownComponent): boolean =>
    selection.targets.some((target) => selected(component, target));
  const visible = (feature: Parameters<typeof featureVisible>[0]): boolean =>
    featureVisible(feature, selection.targets, selection.profiles);

  const root = bundle.root;
  const sortByName = <T extends { name: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => byBytes(a.name, b.name));

  return {
    ...(visible("skills")
      ? { skills: sortByName(bundle.skills.filter(reaches).map((s) => documentComponent(root, s))) }
      : {}),
    ...(visible("agents")
      ? { agents: sortByName(bundle.agents.filter(reaches).map((a) => documentComponent(root, a))) }
      : {}),
    ...(visible("rules")
      ? { rules: sortByName(bundle.rules.filter(reaches).map((r) => documentRule(root, r))) }
      : {}),
    // Hooks are plugin-profile only on every target, so a project-profile view
    // drops the section rather than showing something that is never emitted.
    ...(visible("hooks")
      ? {
          ...(bundle.hooks ? { hooks: documentJson(root, bundle.hooks) } : {}),
          hookFiles: bundle.hookFiles.map((file) => bundleRelative(root, file.path)).sort(byBytes),
        }
      : {}),
    ...(visible("policies")
      ? {
          policies: bundle.policies
            .map((policy) => documentJson(root, policy))
            .sort((a, b) => byBytes(a.path, b.path)),
        }
      : {}),
    ...(visible("mcp") && bundle.mcp ? { mcp: documentJson(root, bundle.mcp) } : {}),
    ...(visible("assets")
      ? { assets: bundle.assets.map((asset) => bundleRelative(root, asset.path)).sort(byBytes) }
      : {}),
  };
}

/**
 * Normalizes one bundle into the form both documentation artifacts carry.
 *
 * This is `agent inspect`'s `publicBundle` widened for a reader rather than a
 * caller: it keeps each component's Markdown body, so a documentation site can
 * render the component without reading the bundle, and it adds the render
 * matrix, so the site can say what an installation actually looks like on each
 * host. It reuses the renderer's own `selected` predicate and the shared
 * `featureVisible` lookup, which is what stops the artifact and `agent convert`
 * ever disagreeing about which components reach which target.
 */
export function documentBundle(
  bundle: AgentBundle,
  selection: DocumentSelection,
  source?: string,
): DocumentedBundle {
  const { artifacts, diagnostics } = renderBundle(bundle, selection.targets, selection.profiles);
  const components = documentComponents(bundle, selection);
  // Derived from what was actually documented, not recomputed from the bundle.
  // A component can be dropped two ways -- its target filtered it out, or its
  // whole kind is unsupported on every selected target -- and reapplying only
  // the first would leave the graph pointing at a subagent the artifact does
  // not describe.
  const kept = new Set(
    [...(components.skills ?? []), ...(components.agents ?? [])].map((component) => component.name),
  );
  const keptSkills = new Set((components.skills ?? []).map((skill) => skill.name));

  return {
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
    manifestSchemaVersion: bundle.schemaVersion,
    legacy: bundle.legacy,
    ...(source ? { source } : {}),
    // Unlike `agent inspect`, which omits the block entirely on a v1 bundle to
    // keep its output byte-identical, a listing is a documentation artifact's
    // subject: an absent one is reported as absent, not as a missing key.
    ...(bundle.marketplace ? { marketplace: bundle.marketplace as MarketplaceListing } : {}),
    components,
    // Pruned to the components that survived the filter, so the graph never
    // carries an edge to something the artifact does not describe.
    graph: Object.fromEntries(
      Object.entries(bundle.graph)
        .filter(([node]) => kept.has(node))
        .map(([node, refs]): [string, string[]] => [
          node,
          refs.filter((ref) => keptSkills.has(ref)).sort(byBytes),
        ])
        .sort(([a], [b]) => byBytes(a, b)),
    ),
    dependencies: documentDependencies(bundle),
    targets: documentTargets(artifacts, selection),
    diagnostics: diagnostics.map(documentDiagnostic),
  };
}
