import path from "node:path";
import { loadBundle } from "../agent/parser.js";
import { loadSpec, SPEC_FILENAME } from "../agent/marketplace/spec.js";
import { INSTALLABLE_SCHEMA_ID, installableArtifact } from "../agent/docs/collection.js";
import type { CollectionEntry } from "../agent/docs/collection.js";
import { hasBlockingFindings, writeArtifactFile } from "../agent/docs/write.js";
import type { AgentDiagnostic, AgentProfile } from "../agent/types.js";
import type { AgentDocsOptions } from "./agent-docs.js";
import { outputDecidedResult, profiles } from "./agent.js";

/**
 * Emits one documentation artifact covering every bundle a repository
 * publishes.
 *
 * All of them land in a single document because they are installed from a
 * single marketplace: a reader arrives at the collection and chooses between
 * its bundles, so splitting them into one artifact each would make the choice
 * the thing that is not written down.
 *
 * The profile defaults to `plugin` -- the self-contained, installable form --
 * for the same reason its inline sibling defaults to `project`.
 */
export async function agentCollectionDocsAction(
  source: string | undefined,
  opts: AgentDocsOptions,
): Promise<void> {
  const specPath = source ?? SPEC_FILENAME;
  const selectedProfiles: AgentProfile[] = opts.profile ? profiles(opts.profile) : ["plugin"];
  const { spec, diagnostics: specDiagnostics } = loadSpec(specPath);

  const entries: CollectionEntry[] = [];
  const diagnostics: AgentDiagnostic[] = [...specDiagnostics];
  for (const entry of spec.bundles) {
    const bundle = loadBundle(entry.root);
    entries.push({ entry, bundle });
    // Kept flat rather than nested under the bundle only: a caller reading the
    // command result wants one list to scan, and the artifact still carries
    // each bundle's own findings beside the bundle they belong to.
    diagnostics.push(...bundle.diagnostics);
  }

  const artifact = installableArtifact(spec, entries, selectedProfiles, specDiagnostics, {
    id: opts.id,
    title: opts.title,
  });
  const written = opts.out
    ? writeArtifactFile(opts.out, "agent collection-docs", INSTALLABLE_SCHEMA_ID, artifact)
    : undefined;

  outputDecidedResult(
    {
      command: "collection-docs",
      ok: !hasBlockingFindings(diagnostics, Boolean(opts.strict)),
      source: path.resolve(spec.file),
      targets: [...spec.targets],
      profiles: selectedProfiles,
      artifacts: written ? [written] : [],
      diagnostics,
      collectionDocs: artifact,
    },
    opts,
  );
}
