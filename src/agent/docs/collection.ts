import { PAYLOAD_SCHEMA_VERSION } from "@cairn-tool/agent-bundle-schema";
import type { InstallableAgentBundlesArtifact } from "@cairn-tool/agent-bundle-schema";
import { packageName, packageVersion } from "../../version.js";
import type { MarketplaceSpec, SpecBundle } from "../marketplace/spec.js";
import { selectedForTarget } from "../marketplace/spec.js";
import type { AgentBundle, AgentDiagnostic, AgentProfile, AgentTarget } from "../types.js";
import { documentBundle } from "./payload.js";
import type { ArtifactIdentity } from "./inline.js";

/** The schema id this artifact conforms to, as `cairn schema` retrieves it. */
export const INSTALLABLE_SCHEMA_ID = "installable-agent-bundles";

/** One bundle of the collection, loaded, with the spec entry it came from. */
export interface CollectionEntry {
  entry: SpecBundle;
  bundle: AgentBundle;
}

/**
 * The documentation artifact for every bundle a repository publishes.
 *
 * "Installable" is the `plugin` output profile: a self-contained directory with
 * its own manifest, which a host discovers through a marketplace or a plugin
 * directory rather than by merging files into a project. All of a repository's
 * bundles land in one document, because they are installed from one marketplace
 * and a reader chooses between them.
 *
 * Each bundle is narrowed to the targets its own spec entry includes, so a
 * bundle the collection excludes from a host is not documented as reaching it.
 */
export function installableArtifact(
  spec: MarketplaceSpec,
  entries: CollectionEntry[],
  profiles: AgentProfile[],
  diagnostics: AgentDiagnostic[],
  identity: ArtifactIdentity = {},
): InstallableAgentBundlesArtifact {
  const generatedAt = identity.generatedAt ?? new Date().toISOString();
  return {
    kind: "installable-agent-bundles",
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    id: identity.id ?? spec.name,
    title: identity.title ?? spec.name,
    generatedAt,
    generator: { name: packageName, version: packageVersion },
    marketplace: {
      name: spec.name,
      version: spec.version,
      ...(spec.description ? { description: spec.description } : {}),
      owner: spec.owner,
      targets: [...spec.targets],
    },
    // Spec order, not sorted: `agent-marketplace.yaml` lists the bundles in the
    // order a reader should meet them, and that is editorial information the
    // artifact should not discard.
    bundles: entries.map(({ entry, bundle }) =>
      documentBundle(
        bundle,
        {
          targets: spec.targets.filter((target: AgentTarget) => selectedForTarget(entry, target)),
          profiles,
        },
        entry.path,
      ),
    ),
    diagnostics: diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.component ? { component: diagnostic.component } : {}),
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      ...(diagnostic.target ? { target: diagnostic.target } : {}),
      ...(diagnostic.profile ? { profile: diagnostic.profile } : {}),
      quality: diagnostic.quality,
      ...(diagnostic.remediation ? { remediation: diagnostic.remediation } : {}),
    })),
  };
}
