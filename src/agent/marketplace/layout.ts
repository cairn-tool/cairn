import type { AgentTarget } from "../types.js";

/**
 * How a built collection is arranged on disk.
 *
 * The two differ in exactly two values — where each target's catalog is written,
 * and what its entries point at — so they live here together rather than as
 * branches scattered through the builder.
 */
export const COLLECTION_LAYOUTS = ["nested", "release"] as const;
export type CollectionLayout = (typeof COLLECTION_LAYOUTS)[number];

/** A target profile's declared catalog location. */
export interface CatalogLocation {
  directory: string;
  file: string;
}

/**
 * Where one target's aggregated catalog is written, relative to the collection
 * root.
 *
 * `nested` gives every target its own subtree, which is what `--install` needs:
 * it strips the `<target>/` prefix to get a host marketplace directory.
 *
 * `release` hoists every catalog to the shared root, which is what a *branch*
 * needs: each host looks for its catalog at the repository root and nowhere
 * else. The three hosts that declare one look in three different places
 * (`.claude-plugin/`, `.cursor-plugin/`, `.agents/plugins/`), so they coexist
 * there without collision, and one branch serves all of them.
 */
export function catalogPathFor(
  layout: CollectionLayout,
  target: AgentTarget,
  location: CatalogLocation,
): string {
  return layout === "release"
    ? `${location.directory}/${location.file}`
    : `${target}/${location.directory}/${location.file}`;
}

/**
 * The `source` a catalog entry carries, relative to the catalog itself.
 *
 * Never rewritten to `./`, which is only correct when a catalog shares a
 * directory with the single plugin it describes.
 */
export function sourceFor(
  layout: CollectionLayout,
  target: AgentTarget,
  bundleName: string,
): string {
  return layout === "release" ? `./${target}/${bundleName}` : `./${bundleName}`;
}

/**
 * What the writer owns in the output directory: directories it may clear
 * wholesale, and files it owns individually.
 *
 * This is the one computation that must not be approximated. A root the writer
 * does not know it owns keeps stale files across a release — a bundle dropped
 * upstream would go on being published indefinitely.
 */
export function ownership(
  layout: CollectionLayout,
  targets: AgentTarget[],
  paths: string[],
): { managedRoots: string[]; looseFiles: string[] } {
  if (layout === "nested")
    return {
      managedRoots: [...targets],
      looseFiles: paths.filter((item) => !targets.some((target) => item.startsWith(`${target}/`))),
    };

  // Release: every top-level directory this build produced is ours — the target
  // trees, `bundles/`, each host's catalog directory, and any resource root
  // hoisted alongside the sources. Derived from the artifacts rather than
  // listed, because the resource roots are a property of the bundles and cannot
  // be known here.
  const roots = new Set<string>();
  const loose: string[] = [];
  for (const item of paths) {
    const slash = item.indexOf("/");
    if (slash === -1) loose.push(item);
    else roots.add(item.slice(0, slash));
  }
  // Byte comparison, never localeCompare: the same rule the rest of this module
  // follows, so a differently configured runner cannot reorder the result.
  return {
    managedRoots: [...roots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    looseFiles: loose,
  };
}
