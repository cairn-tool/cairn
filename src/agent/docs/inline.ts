import { PAYLOAD_SCHEMA_VERSION } from "@cairn-tool/agent-bundle-schema";
import type { InlineAgentBundleArtifact } from "@cairn-tool/agent-bundle-schema";
import { packageName, packageVersion } from "../../version.js";
import type { AgentBundle } from "../types.js";
import { documentBundle, type DocumentSelection } from "./payload.js";

/** The schema id this artifact conforms to, as `cairn schema` retrieves it. */
export const INLINE_SCHEMA_ID = "inline-agent-bundle";

export interface ArtifactIdentity {
  id?: string;
  title?: string;
  /** When the bundle was generated, for a caller that needs a fixed timestamp. */
  generatedAt?: string;
}

/**
 * The documentation artifact for the bundle a repository installs into itself.
 *
 * "Inline" is the `project` output profile: files merged into the repository's
 * own dot-directories rather than installed as a self-contained plugin. A
 * repository has at most one, which is why this artifact carries a single
 * bundle where its installable sibling carries a list.
 */
export function inlineArtifact(
  bundle: AgentBundle,
  selection: DocumentSelection,
  identity: ArtifactIdentity = {},
): InlineAgentBundleArtifact {
  return {
    kind: "inline-agent-bundle",
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    id: identity.id ?? bundle.name,
    title: identity.title ?? bundle.marketplace?.displayName ?? bundle.name,
    generatedAt: identity.generatedAt ?? new Date().toISOString(),
    generator: { name: packageName, version: packageVersion },
    bundle: documentBundle(bundle, selection),
  };
}
