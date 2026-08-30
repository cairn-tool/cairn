import path from "node:path";
import type { AgentBundle, AgentDiagnostic, AgentTarget, Artifact } from "../types.js";
import { diagnostic } from "../types.js";
import { loadBundle } from "../parser.js";
import { renderBundle } from "../render.js";
import { profileFor } from "../targets/index.js";
import type { PackageArchive } from "../package/index.js";
import {
  buildArchives,
  buildCatalogs,
  buildChecksums,
  buildSbom,
  checkAssets,
  checkCaseCollisions,
  checkExecutables,
  checkPinning,
} from "../package/index.js";
import { TarPathTooLongError } from "../package/tar.js";
import type { MarketplaceSpec, SpecBundle } from "./spec.js";
import { selectedForTarget } from "./spec.js";

export const MARKETPLACE_REPORT = "marketplace-report.json";

/**
 * Distribution modes a collection supports.
 *
 * `agent package`'s third mode, `none`, is deliberately absent: a collection
 * whose whole product is a catalog has nothing left when the catalog is
 * suppressed.
 */
export const COLLECTION_MODES = ["repo", "local"] as const;
export type CollectionMode = (typeof COLLECTION_MODES)[number];

/** One plugin in one target's catalog. */
export interface CollectionPlugin {
  name: string;
  version: string;
  /** Spec-relative path of the bundle it was rendered from. */
  source: string;
}

export interface CollectionTarget {
  target: AgentTarget;
  /** Collection-relative path of the aggregated catalog, or null when the target has none. */
  catalog: string | null;
  plugins: CollectionPlugin[];
}

export interface MarketplaceReport {
  name: string;
  version: string;
  targets: CollectionTarget[];
  archives: PackageArchive[];
  checksums: string;
  sbom: string;
  checks: { passed: number; failed: number };
}

export interface CollectionBuild {
  /** Every artifact, sorted by byte comparison of path. */
  artifacts: Artifact[];
  report: MarketplaceReport;
  diagnostics: AgentDiagnostic[];
  /** Loaded bundles, keyed by their spec-relative path, in spec order. */
  bundles: Map<string, AgentBundle>;
}

/**
 * The collection's own pass/fail rule.
 *
 * Like package, install, and doctor, this cannot use the shared `hasFindings`:
 * a codex bundle inherently carries approximate render diagnostics, which say
 * nothing about whether a collection is publishable.
 */
export function collectionHasFindings(diagnostics: AgentDiagnostic[], strict: boolean): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.severity === "warning"),
  );
}

function sortByPath(artifacts: Artifact[]): Artifact[] {
  // Byte comparison, never localeCompare: that is ICU- and locale-dependent and
  // would reorder a collection on a differently configured runner.
  return [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Relocates a rendered artifact out of its `<target>/<profile>/` prefix and
 * under the plugin's own directory, so a collection reads
 * `<target>/<plugin>/…` rather than `<target>/plugin/…` repeated N times.
 */
function relocate(artifact: Artifact, target: AgentTarget, plugin: string): Artifact {
  const prefix = `${target}/plugin/`;
  return {
    ...artifact,
    path: `${target}/${plugin}/${artifact.path.slice(prefix.length)}`,
  };
}

/**
 * Renders every bundle for every target it is selected for, and aggregates one
 * catalog per target.
 *
 * Catalog identity comes from the spec rather than from any bundle: a
 * collection's name and owner are properties of the collection. Entry fields
 * still resolve per bundle from the target profile, so `category`'s
 * first-of-list transform and `author`'s object shape keep working with no
 * per-target branching here.
 */
export function buildCollection(
  spec: MarketplaceSpec,
  targets: AgentTarget[],
  mode: CollectionMode,
  options: { archive?: boolean } = {},
): CollectionBuild {
  const diagnostics: AgentDiagnostic[] = [];
  const bundles = new Map<string, AgentBundle>();
  for (const entry of spec.bundles) bundles.set(entry.path, loadBundle(entry.root));

  // Two bundles may declare distinct paths and still render the same plugin
  // name, which a host would resolve arbitrarily.
  const byName = new Map<string, SpecBundle>();
  for (const entry of spec.bundles) {
    const name = bundles.get(entry.path)!.name;
    const previous = byName.get(name);
    if (previous)
      diagnostics.push({
        ...diagnostic(
          "AB905",
          `Bundles '${previous.path}' and '${entry.path}' are both '${name}'`,
          "unsupported",
          {
            path: spec.file,
          },
        ),
        severity: "error",
      });
    else byName.set(name, entry);
  }

  const artifacts: Artifact[] = [];
  const reportTargets: CollectionTarget[] = [];
  let archives: PackageArchive[] = [];

  for (const target of targets) {
    const selected = spec.bundles.filter((entry) => selectedForTarget(entry, target));
    // A notice, not a warning: an exclusion is the author saying so, and a
    // warning would block the build under --strict for working as declared.
    for (const entry of spec.bundles)
      if (!selectedForTarget(entry, target))
        diagnostics.push(
          diagnostic("AB907", `${entry.path} is not built for ${target}`, "exact", {
            target,
            path: entry.path,
          }),
        );

    if (selected.length === 0) {
      diagnostics.push({
        ...diagnostic("AB906", `No bundles are built for ${target}`, "unsupported", {
          target,
          path: spec.file,
          remediation: "Drop the target, or widen a bundle's include/exclude.",
        }),
        severity: "warning",
      });
      reportTargets.push({ target, catalog: null, plugins: [] });
      continue;
    }

    const targetArtifacts: Artifact[] = [];
    const ordered: AgentBundle[] = [];
    const plugins: CollectionPlugin[] = [];
    for (const entry of selected) {
      const bundle = bundles.get(entry.path)!;
      const rendered = renderBundle(bundle, [target], ["plugin"]);
      diagnostics.push(...rendered.diagnostics);
      targetArtifacts.push(
        ...rendered.artifacts.map((artifact) => relocate(artifact, target, bundle.name)),
      );
      ordered.push(bundle);
      plugins.push({ name: bundle.name, version: bundle.version, source: entry.path });
    }

    // AB507 already means "this target produces no catalog"; a target that
    // declares no marketplace at all is the same condition, and one condition
    // keeps one id whichever command surfaces it. Silently emitting payloads
    // and no catalog would be a surprise for a command whose product is one.
    const marketplace = profileFor(target).marketplace;
    if (!marketplace)
      diagnostics.push(
        diagnostic("AB507", `${target} declares no marketplace catalog`, "unsupported", {
          target,
          path: spec.file,
          remediation: `Drop ${target} from targets, or install the plugins directly.`,
        }),
      );
    const location = marketplace?.catalog[mode];
    const catalogs = buildCatalogs(ordered, [target], ["plugin"], mode, {
      document: {
        name: spec.name,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        owner: spec.owner,
      },
      // Relative to the catalog, which sits one level above the plugin
      // directories — never rewritten to "./", which is only correct when a
      // catalog shares a directory with the single plugin it describes.
      sourceFor: (bundle) => `./${bundle.name}`,
      catalogPathFor: (id, _profile, where) => `${id}/${where.directory}/${where.file}`,
      attributeToBundle: true,
    });
    diagnostics.push(...catalogs.diagnostics);
    targetArtifacts.push(...catalogs.artifacts);

    // Per bundle, not once for the collection: each declares its own icon and
    // screenshots, and checking only the first would let the rest ship an asset
    // the catalog references but the payload does not carry.
    for (const bundle of ordered)
      diagnostics.push(...checkPinning(bundle), ...checkAssets(bundle, [target], targetArtifacts));

    artifacts.push(...targetArtifacts);
    reportTargets.push({
      target,
      catalog: location ? `${target}/${location.directory}/${location.file}` : null,
      plugins,
    });
  }

  const payload = sortByPath(artifacts);
  diagnostics.push(...checkExecutables(payload), ...checkCaseCollisions(payload));

  const extra: Artifact[] = [];
  if (options.archive)
    for (const target of targets)
      for (const entry of spec.bundles.filter((item) => selectedForTarget(item, target))) {
        const bundle = bundles.get(entry.path)!;
        // Archive each plugin from its own subtree, so the member paths inside
        // are the plugin's own rather than the collection's.
        const own = payload
          .filter((artifact) => artifact.path.startsWith(`${target}/${bundle.name}/`))
          .map((artifact) => ({
            ...artifact,
            path: `${target}/plugin/${artifact.path.slice(`${target}/${bundle.name}/`.length)}`,
          }));
        try {
          const built = buildArchives(bundle, own, [target], ["plugin"]);
          extra.push(...built.artifacts);
          archives = [...archives, ...built.archives];
        } catch (cause) {
          if (!(cause instanceof TarPathTooLongError)) throw cause;
          diagnostics.push({
            ...diagnostic("AB509", cause.message, "unsupported", {
              path: cause.path,
              remediation: "Shorten the path; ustar headers cannot express it.",
            }),
            severity: "error",
          });
        }
      }

  const withArchives = sortByPath([...payload, ...extra]);
  const checksums = buildChecksums(withArchives);
  // The sbom's subject is the collection, not any one bundle, so it is given a
  // synthetic bundle carrying the spec's identity.
  const subject = { ...bundles.values().next().value!, name: spec.name, version: spec.version };
  const sbom = buildSbom(subject, withArchives);

  const report: MarketplaceReport = {
    name: spec.name,
    version: spec.version,
    targets: reportTargets,
    archives,
    checksums: checksums.path,
    sbom: sbom.path,
    checks: {
      failed: diagnostics.filter((item) => item.severity === "error").length,
      passed: diagnostics.filter((item) => item.severity !== "error").length,
    },
  };

  return {
    artifacts: [...withArchives, checksums, sbom],
    report,
    diagnostics,
    bundles,
  };
}

/** Collection-relative directories the writer owns outright, one per target. */
export function managedRootsFor(targets: AgentTarget[]): string[] {
  return targets.map((target) => path.join(target));
}
