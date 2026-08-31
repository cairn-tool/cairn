import path from "node:path";
import type { AgentDiagnostic, AgentProfile, AgentResult, AgentTarget } from "../agent/types.js";
import { loadBundle } from "../agent/parser.js";
import type { InstallPlan, InstallReport, InstallRequest } from "../agent/install/index.js";
import {
  commitInstall,
  installIsCurrent,
  locationFor,
  planInstalls,
  planToEntry,
  resolveScope,
} from "../agent/install/index.js";
import { installsFor, resolveInstallConfig } from "../agent/install/config.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult, resolveTargets } from "./agent.js";

export interface AgentInstallOptions extends AgentOptions {
  scope?: string;
  into?: string;
  link?: boolean;
  register?: boolean;
  config?: string;
  name?: string[];
}

/**
 * Install's own pass/fail rule.
 *
 * Like package and doctor, this cannot use the shared `hasFindings`: a Codex
 * bundle inherently carries approximate render diagnostics, which say nothing
 * about whether the install landed. Notices (AB802, AB807) never fail.
 */
export function installHasFindings(diagnostics: AgentDiagnostic[], strict: boolean): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.severity === "warning"),
  );
}

/**
 * The targets an install run covers.
 *
 * `all` expands only to targets that declare a location for the requested
 * scope. Expanding to every target would make the most natural invocation of a
 * multi-target install — `--target all --scope user` — hard-fail on codex and
 * opencode, which record no user location; and under plan-all-then-commit-all a
 * hard fail writes nothing at all. An explicitly named target with no location
 * still reports AB800, because there the user asked for something specific.
 */
export function resolveInstallTargets(
  values: string[] | undefined,
  scope: string | undefined,
): AgentTarget[] {
  const raw = values ?? [];
  if (!raw.length) throw new Error("At least one --target is required");
  if (!raw.includes("all")) return resolveTargets(raw, true);
  const resolved = resolveScope(scope, "user");
  const supported = resolveTargets(["all"]).filter((target) => locationFor(target, resolved));
  if (!supported.length)
    throw new Error(`No target records an install location for the ${resolved} scope`);
  return supported;
}

/** Retained for `agent uninstall`, which removes one install at a time. */
export function requireInstallTarget(values: string[] | undefined): AgentTarget {
  const targets = resolveTargets(values, true);
  if (targets.length !== 1)
    throw new Error("Specify one target; uninstall removes one install at a time.");
  return targets[0];
}

function artifactInfo(plans: InstallPlan[]): AgentResult["artifacts"] {
  // Two plans legitimately write the same relative path to different
  // destinations, so `path` is not unique across a multi-destination run. The
  // artifact row is shared by every agent command; a `destination` field for
  // this one caller would be a wide change for a narrow need.
  return plans
    .flatMap((plan) =>
      plan.artifacts.map((artifact) => ({
        destination: plan.destination,
        path: artifact.path,
        bytes: artifact.content.length,
        mode: `0${(artifact.mode & 0o777).toString(8)}`,
        ...(artifact.origin === "native" ? { origin: artifact.origin } : {}),
      })),
    )
    .sort((a, b) => {
      const left = `${a.destination}\0${a.path}`;
      const right = `${b.destination}\0${b.path}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(({ destination: _destination, ...row }) => row);
}

/** Turns a declared `agent.install` block into the requests a run plans. */
function requestsFromConfig(opts: AgentInstallOptions): {
  requests: InstallRequest[];
  source: string;
  options: { scope: string; into?: string; link?: boolean; register?: boolean };
} {
  const config = resolveInstallConfig({ explicitPath: opts.config });
  const selected = opts.name?.length ? new Set(opts.name) : undefined;
  if (selected)
    for (const name of selected)
      if (!config.bundles.some((bundle) => path.basename(bundle.root) === name))
        throw new Error(`No bundle named '${name}' in ${config.file}`);

  // --target narrows the declaration rather than replacing it, the same rule
  // `agent marketplace` uses: a flag that could add a target would let CI
  // install for a host the repository never declared.
  const requested = opts.target?.length ? resolveTargets(opts.target, true) : config.targets;
  const undeclared = requested.filter((target) => !config.targets.includes(target));
  if (undeclared.length)
    throw new Error(
      `Target(s) not declared in ${config.file}: ${undeclared.join(", ")}. --target narrows the block rather than adding to it.`,
    );

  const requests: InstallRequest[] = [];
  for (const spec of config.bundles) {
    if (selected && !selected.has(path.basename(spec.root))) continue;
    const bundle = loadBundle(spec.root);
    for (const target of requested)
      if (installsFor(spec, target)) requests.push({ bundle, target });
  }
  if (!requests.length)
    throw new Error(`No bundle in ${config.file} installs for the given targets`);
  return {
    requests,
    source: config.file,
    options: {
      scope: opts.scope ?? config.scope,
      ...((opts.into ?? config.into) ? { into: opts.into ?? config.into } : {}),
      ...(opts.link || config.link ? { link: true } : {}),
      ...(opts.register || config.register ? { register: true } : {}),
    },
  };
}

export async function agentInstallAction(
  source: string | undefined,
  opts: AgentInstallOptions,
): Promise<void> {
  if (opts.check && opts.dryRun) throw new Error("--check and --dry-run cannot be used together");
  if (source && opts.config) throw new Error("Pass a bundle source or --config, not both");
  if (!source && !opts.config)
    throw new Error("Specify a bundle source, or --config <file> to install a declared block");

  const declared = source ? undefined : requestsFromConfig(opts);
  const targets = declared
    ? [...new Set(declared.requests.map((request) => request.target))]
    : resolveInstallTargets(opts.target, opts.scope);
  // One profile per destination, and one destination per target: a --profile
  // that had to hold for several targets at once is a usage error, not a
  // finding, and rejecting it up front keeps a batch from reporting two clean
  // plans before throwing on the third.
  if (opts.profile && targets.length > 1)
    throw new Error(
      "--profile applies to a single --target; install uses one profile per destination",
    );

  const loaded = source ? loadBundle(source) : undefined;
  const requests: InstallRequest[] =
    declared?.requests ?? targets.map((target) => ({ bundle: loaded!, target }));

  const batch = planInstalls(requests, {
    ...(declared?.options ?? {
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.into ? { into: opts.into } : {}),
      ...(opts.link ? { link: true } : {}),
      ...(opts.register ? { register: true } : {}),
    }),
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.force ? { force: true } : {}),
  });

  const diagnostics = [...batch.diagnostics, ...batch.plans.flatMap((plan) => plan.diagnostics)];
  const blocked = installHasFindings(diagnostics, Boolean(opts.strict));
  const stale = Boolean(
    opts.check && batch.plans.some((plan) => plan.destination && !installIsCurrent(plan)),
  );
  // All or nothing: committing the clean part of a run whose remainder is
  // blocked is how a destination ends up half-populated with no record of it.
  if (!opts.dryRun && !opts.check && !blocked)
    for (const plan of batch.plans) if (plan.destination) commitInstall(plan);

  const placed = batch.plans.filter((plan) => plan.destination);
  const report: InstallReport = { installs: placed.map(planToEntry) };
  const profiles = [...new Set(placed.map((plan) => plan.profile))] as AgentProfile[];
  outputDecidedResult(
    {
      command: "install",
      ok: !blocked && !stale,
      source: declared?.source ?? (loaded as NonNullable<typeof loaded>).root,
      targets,
      ...(profiles.length ? { profiles } : {}),
      artifacts: artifactInfo(batch.plans),
      diagnostics,
      install: report,
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.check ? { check: true, stale } : {}),
    } satisfies AgentResult,
    opts,
  );
}
