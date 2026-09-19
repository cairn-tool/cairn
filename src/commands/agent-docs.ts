import { loadBundle } from "../agent/parser.js";
import { INLINE_SCHEMA_ID, inlineArtifact } from "../agent/docs/inline.js";
import { hasBlockingFindings, writeArtifactFile } from "../agent/docs/write.js";
import { TARGETS } from "../agent/types.js";
import type { AgentProfile } from "../agent/types.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult, profiles, resolveTargets } from "./agent.js";

export interface AgentDocsOptions extends AgentOptions {
  out?: string;
  id?: string;
  title?: string;
}

/**
 * Emits the documentation artifact for an inline agent bundle.
 *
 * The profile defaults to `project` rather than `both`, because that is what
 * "inline" means: the files merged into a repository's own dot-directories.
 * `--profile` still overrides it, for a reader who wants to see both forms of
 * the same bundle side by side.
 */
export async function agentDocsAction(source: string, opts: AgentDocsOptions): Promise<void> {
  const requested = resolveTargets(opts.target);
  const targets = requested.length ? requested : [...TARGETS];
  const selectedProfiles: AgentProfile[] = opts.profile ? profiles(opts.profile) : ["project"];
  const bundle = loadBundle(source);
  const artifact = inlineArtifact(
    bundle,
    { targets, profiles: selectedProfiles },
    { id: opts.id, title: opts.title },
  );
  const written = opts.out
    ? writeArtifactFile(opts.out, "agent docs", INLINE_SCHEMA_ID, artifact)
    : undefined;

  outputDecidedResult(
    {
      command: "docs",
      ok: !hasBlockingFindings(bundle.diagnostics, Boolean(opts.strict)),
      source: bundle.root,
      targets,
      profiles: selectedProfiles,
      artifacts: written ? [written] : [],
      diagnostics: bundle.diagnostics,
      docs: artifact,
    },
    opts,
  );
}
