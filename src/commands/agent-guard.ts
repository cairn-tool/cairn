import path from "node:path";
import { diagnostic } from "../agent/types.js";
import type { AgentDiagnostic, AgentResult } from "../agent/types.js";
import { classifyPath, guardMessage } from "../agent/guard/index.js";
import type { GuardReport } from "../agent/guard/index.js";
import { resolveGuardConfig } from "../agent/guard/resolve.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult } from "./agent.js";

export interface AgentGuardOptions extends AgentOptions {
  config?: string;
}

/**
 * Decides whether a path may be edited directly, or whether the editor should
 * be sent to the bundle source that produces it.
 *
 * The command is a pure reader: it resolves the repository's `agent.guard`
 * block, matches one path against it, and says so. It is the decision half of
 * the `cairn-agent` bundle's `pre-tool-use` hook, which supplies the path and
 * turns exit 2 into the host's own refusal.
 *
 * Every outcome that is not a refusal exits 0, including a missing
 * configuration, a path outside every destination, and a bundle that is merely
 * unreadable. A guard that fails closed would block editing on any repository
 * whose configuration has a typo, which is a far worse failure than the one it
 * prevents.
 */
export async function agentGuardAction(file: string, opts: AgentGuardOptions): Promise<void> {
  const resolved = path.resolve(file);
  const config = resolveGuardConfig({
    ...(opts.config ? { explicitPath: opts.config } : {}),
    cwd: path.dirname(resolved),
  });

  const report: GuardReport = config
    ? (() => {
        const verdict = classifyPath(resolved, config);
        const partial = {
          ...verdict,
          config: config.file,
          mode: config.mode,
          ...(config.regenerate ? { regenerate: config.regenerate } : {}),
        };
        return { ...partial, message: guardMessage(partial) };
      })()
    : {
        path: resolved,
        decision: "allow",
        reason: "not-configured",
        sources: [],
        config: null,
        mode: null,
        message: "",
      };

  const diagnostics: AgentDiagnostic[] = [];
  if (report.decision === "block")
    diagnostics.push({
      ...diagnostic("AB430", report.message, "unsupported", {
        path: report.match?.relative ?? report.path,
        ...(report.match ? { target: report.match.target, profile: report.match.profile } : {}),
        remediation: report.sources.length
          ? `Edit ${report.sources.join(", ")} instead.`
          : "Edit the bundle that produces this path instead.",
      }),
      severity: "error",
    });
  else if (report.decision === "warn")
    diagnostics.push(
      diagnostic("AB431", report.message, "approximate", {
        path: report.match?.relative ?? report.path,
        ...(report.match ? { target: report.match.target, profile: report.match.profile } : {}),
        remediation: report.sources.length
          ? `Edit ${report.sources.join(", ")} instead; this file is regenerated.`
          : "This file is regenerated; the edit will not survive.",
      }),
    );

  // A block declared but resolving to nothing guards nothing, and silence would
  // read as "this path is fine". Reported once, as a notice, so it surfaces in
  // a normal invocation without ever deciding the exit code.
  if (config && config.mode !== "off" && !config.entries.length)
    diagnostics.push(
      diagnostic("AB432", "agent.guard declares no entries, so nothing is guarded", "approximate", {
        path: config.file,
        remediation: config.derived
          ? "Add an agent.install block with project scope, or declare agent.guard.entries."
          : "Declare at least one entry under agent.guard.entries.",
      }),
    );

  outputDecidedResult(
    {
      command: "guard",
      ok: report.decision !== "block",
      ...(config ? { source: config.file } : {}),
      targets: report.match ? [report.match.target] : [],
      ...(report.match ? { profiles: [report.match.profile] } : {}),
      artifacts: [],
      diagnostics,
      guard: report,
    } satisfies AgentResult,
    opts,
  );
}
