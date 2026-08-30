import type { AgentDiagnostic, AgentResult } from "../agent/types.js";
import { resolveVerifyConfig } from "../agent/verify/resolve.js";
import { runVerify } from "../agent/verify/index.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult } from "./agent.js";

export interface AgentVerifyOptions extends AgentOptions {
  config?: string;
  name?: string[];
}

/**
 * Verify's own pass/fail rule.
 *
 * Like doctor, install, and package, this cannot use the shared `hasFindings`:
 * every Codex bundle carries approximate render diagnostics by design, and
 * failing on those would make a Codex entry a permanent CI failure while saying
 * nothing about whether the committed tree drifted.
 */
export function verifyHasFindings(diagnostics: AgentDiagnostic[], strict: boolean): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.severity === "warning"),
  );
}

export async function agentVerifyAction(opts: AgentVerifyOptions): Promise<void> {
  const config = resolveVerifyConfig({ explicitPath: opts.config });
  const selected = opts.name?.length
    ? {
        ...config,
        entries: config.entries.filter((entry) => opts.name?.includes(entry.name)),
      }
    : config;
  if (opts.name?.length) {
    const known = new Set(config.entries.map((entry) => entry.name));
    const unknown = opts.name.filter((name) => !known.has(name));
    if (unknown.length) throw new Error(`Unknown verify entry name(s): ${unknown.join(", ")}`);
  }

  const { report, diagnostics, targets, profiles } = runVerify(selected);
  const ok = !verifyHasFindings(diagnostics, Boolean(opts.strict));

  outputDecidedResult(
    {
      command: "verify",
      ok,
      source: config.file,
      targets,
      ...(profiles.length ? { profiles } : {}),
      artifacts: [],
      diagnostics,
      verify: report,
    } satisfies AgentResult,
    opts,
  );
}
