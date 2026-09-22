import type { AgentResult } from "../agent/types.js";
import {
  commitUninstall,
  missingInstallDiagnostic,
  planUninstall,
} from "../agent/install/index.js";
import type { InstallEntry } from "../agent/install/index.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult } from "./agent.js";
import { installHasFindings, requireInstallTarget, resolveGuardSettings } from "./agent-install.js";

export interface AgentUninstallOptions extends AgentOptions {
  scope?: string;
  into?: string;
}

export async function agentUninstallAction(
  name: string,
  opts: AgentUninstallOptions,
): Promise<void> {
  if (opts.check && opts.dryRun) throw new Error("--check and --dry-run cannot be used together");
  const target = requireInstallTarget(opts.target);
  const plan = planUninstall(name, target, { scope: opts.scope, into: opts.into });
  if (plan.missing && !opts.check)
    plan.diagnostics.push(missingInstallDiagnostic(name, target, plan.destination));
  const blocked = installHasFindings(plan.diagnostics, Boolean(opts.strict));
  const stale = Boolean(opts.check && plan.manifest);
  if (!opts.dryRun && !opts.check && !blocked)
    // The guard is rebuilt from the surviving bundles, under the settings the
    // destination's configuration declares.
    commitUninstall(plan, { guard: resolveGuardSettings({ cwd: plan.destination }) });

  const entry: InstallEntry | null = plan.manifest
    ? {
        ...(plan.manifest.kind === "collection" || plan.manifest.kind === "guard"
          ? { kind: plan.manifest.kind }
          : {}),
        name: plan.manifest.bundle.name,
        version: plan.manifest.bundle.version,
        target: plan.manifest.target,
        profile: plan.manifest.profile,
        scope: plan.manifest.scope,
        layout: plan.manifest.layout,
        mode: plan.manifest.mode,
        destination: plan.destination,
        registered: Boolean(plan.manifest.registration),
        files: plan.manifest.files.length,
      }
    : null;
  outputDecidedResult(
    {
      command: "uninstall",
      ok: !blocked && !stale,
      targets: [target],
      ...(plan.manifest ? { profiles: [plan.manifest.profile] } : {}),
      artifacts: (plan.manifest?.files ?? []).map((file) => ({
        path: file.path,
        bytes: 0,
        mode: file.mode,
      })),
      diagnostics: plan.diagnostics,
      install: { installs: entry ? [entry] : [] },
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.check ? { check: true, stale } : {}),
    } satisfies AgentResult,
    opts,
  );
}
