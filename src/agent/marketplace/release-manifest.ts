import { createHash } from "node:crypto";
import type { AgentTarget, Artifact } from "../types.js";
import { profileFor } from "../targets/index.js";
import type { CollectionTarget } from "./index.js";
import type { PublishedBundle } from "./source-bundles.js";

/** The manifest a release tree publishes at its root. */
export const RELEASE_MANIFEST = "release-manifest.json";

/**
 * Hand-owned, and versions the document this file writes.
 *
 * Unrelated to the package version, to the bundle `schemaVersion`, to the
 * collection spec's, or to any other version in this project.
 */
export const RELEASE_MANIFEST_SCHEMA = "1";

/**
 * How a host is activated once a plugin is installed, flattened to a string a
 * consumer can branch on without knowing cairn's internal profile shapes.
 *
 * This is not derivable from whether a target has a catalog: Cursor publishes a
 * catalog and needs no activation at all, because it auto-scans its plugin
 * directory. A consumer that assumed otherwise would pass `--register` where it
 * does nothing and skip it where it is required.
 */
export type ReleaseActivation = "settings" | `cli:${string}` | null;

export interface ReleaseTargetEntry {
  /** Collection-relative path of this host's catalog, or null when it has none. */
  catalog: string | null;
  /** Directory holding this host's rendered trees, or null when it has none. */
  root: string | null;
  activation: ReleaseActivation;
}

export interface ReleaseBundleTarget {
  path: string;
  sha256: string;
}

export interface ReleaseBundleEntry {
  name: string;
  version: string;
  description: string;
  /** Collection-relative path of the published source bundle. */
  source: string;
  /** Digest of that source tree — the thing a from-source install actually reads. */
  sourceSha256: string;
  targets: Record<string, ReleaseBundleTarget>;
}

export interface ReleaseManifest {
  schemaVersion: string;
  marketplace: string;
  version: string;
  description?: string;
  sourceCommit: string | null;
  generator: { name: string; version: string };
  targets: Record<string, ReleaseTargetEntry>;
  bundles: ReleaseBundleEntry[];
}

/**
 * sha256 over a subtree, covering path, executability and content.
 *
 * Byte-sorted POSIX paths, never `localeCompare` and never platform separators:
 * a digest that depended on the runner's locale or operating system would
 * differ between two builds of the same tree.
 */
export function treeDigest(artifacts: Artifact[], prefix: string): string {
  const scoped = artifacts
    .filter((artifact) => artifact.path === prefix || artifact.path.startsWith(`${prefix}/`))
    .map((artifact) => ({ ...artifact, path: artifact.path.slice(prefix.length + 1) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  for (const artifact of scoped) {
    hash.update(`${artifact.path}\0${artifact.mode & 0o111 ? "x" : "-"}\0`);
    hash.update(artifact.content);
  }
  return hash.digest("hex");
}

function activationFor(target: AgentTarget): ReleaseActivation {
  const activation = profileFor(target).install?.user?.activation;
  if (!activation) return null;
  return activation.form === "codex-plugin-cli" ? `cli:${activation.command}` : "settings";
}

/**
 * The release manifest: everything a consumer needs to install this branch
 * without knowing anything about the repository that produced it.
 *
 * The document-level `targets` map is what lets one branch serve hosts that
 * have no marketplace concept at all. A target with `catalog: null` is not
 * absent from the release — it is installed from `source` instead, which is the
 * whole reason the source bundles are published.
 */
export function buildReleaseManifest(input: {
  marketplace: string;
  version: string;
  description?: string;
  sourceCommit?: string;
  generator: { name: string; version: string };
  targets: CollectionTarget[];
  sources: PublishedBundle[];
  descriptions: Map<string, string>;
  artifacts: Artifact[];
}): Artifact {
  const targets: Record<string, ReleaseTargetEntry> = {};
  for (const entry of input.targets)
    targets[entry.target] = {
      catalog: entry.catalog,
      // The rendered tree, which exists whether or not the host has a catalog:
      // antigravity gets a payload and no marketplace.
      root: entry.plugins.length > 0 ? entry.target : null,
      activation: activationFor(entry.target),
    };

  const bundles: ReleaseBundleEntry[] = input.sources.map((source) => {
    const perTarget: Record<string, ReleaseBundleTarget> = {};
    for (const entry of input.targets)
      if (entry.plugins.some((plugin) => plugin.name === source.name)) {
        const prefix = `${entry.target}/${source.name}`;
        perTarget[entry.target] = { path: prefix, sha256: treeDigest(input.artifacts, prefix) };
      }
    return {
      name: source.name,
      version: source.version,
      description: input.descriptions.get(source.name) ?? "",
      source: source.source,
      sourceSha256: treeDigest(input.artifacts, source.source),
      targets: perTarget,
    };
  });

  const manifest: ReleaseManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    marketplace: input.marketplace,
    version: input.version,
    ...(input.description !== undefined ? { description: input.description } : {}),
    sourceCommit: input.sourceCommit ?? null,
    generator: input.generator,
    targets,
    bundles,
  };

  return {
    path: RELEASE_MANIFEST,
    content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    mode: 0o644,
  };
}
