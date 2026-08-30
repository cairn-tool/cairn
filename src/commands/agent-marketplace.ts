import fs from "node:fs";
import path from "node:path";
import type { AgentResult, AgentTarget, Artifact } from "../agent/types.js";
import { loadSpec } from "../agent/marketplace/spec.js";
import type { CollectionMode } from "../agent/marketplace/index.js";
import {
  COLLECTION_MODES,
  MARKETPLACE_REPORT,
  buildCollection,
  collectionHasFindings,
} from "../agent/marketplace/index.js";
import type { InstallEntry, InstallPlan } from "../agent/install/index.js";
import {
  INSTALL_CACHE,
  commitInstall,
  installIsCurrent,
  planCollectionInstall,
  planToEntry,
  resolveScope,
} from "../agent/install/index.js";
import { writeArtifactsAtomically } from "../agent/writer.js";
import { packageName, packageVersion } from "../version.js";
import { isInside } from "../config-schema.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult, resolveTargets } from "./agent.js";

export interface AgentMarketplaceOptions extends AgentOptions {
  marketplace?: string;
  archive?: boolean;
  install?: boolean;
  scope?: string;
  into?: string;
  link?: boolean;
  register?: boolean;
}

function resolveThroughExistingAncestors(candidate: string): string {
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing))
    existing = path.dirname(existing);
  return path.resolve(fs.realpathSync(existing), path.relative(existing, candidate));
}

/**
 * Compares a collection tree against what this run would produce.
 *
 * The report is compared by existence only — it embeds the generator version,
 * so byte-comparing it would call every collection stale after a CLI upgrade.
 * Same rule `agent package` applies to `package-report.json`.
 */
function matchesCollection(output: string, artifacts: Artifact[]): boolean {
  for (const artifact of artifacts) {
    const file = path.join(output, artifact.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    if (artifact.path === MARKETPLACE_REPORT) continue;
    if (!fs.readFileSync(file).equals(artifact.content)) return false;
  }
  return true;
}

/**
 * One target's slice of a built collection, with the `<target>/` prefix
 * stripped: a host marketplace directory holds the catalog and the plugin
 * directories directly, not a target-named level above them.
 */
function forTarget(artifacts: Artifact[], target: AgentTarget): Artifact[] {
  const prefix = `${target}/`;
  return artifacts
    .filter((artifact) => artifact.path.startsWith(prefix))
    .map((artifact) => ({ ...artifact, path: artifact.path.slice(prefix.length) }));
}

export async function agentMarketplaceAction(
  source: string,
  opts: AgentMarketplaceOptions,
): Promise<void> {
  if (opts.check && opts.dryRun) throw new Error("--check and --dry-run cannot be used together");
  if (!opts.output && !opts.install)
    throw new Error("--output is required unless --install is given");
  for (const [flag, given] of [
    ["--scope", opts.scope !== undefined],
    ["--into", opts.into !== undefined],
    ["--link", Boolean(opts.link)],
    ["--register", Boolean(opts.register)],
  ] as const)
    if (given && !opts.install) throw new Error(`${flag} applies only with --install`);

  const mode = (opts.marketplace ?? "repo") as CollectionMode;
  if (!(COLLECTION_MODES as readonly string[]).includes(mode))
    throw new Error(`Unknown --marketplace '${mode}'. Use one of: ${COLLECTION_MODES.join(", ")}.`);

  const { spec, diagnostics: specDiagnostics } = loadSpec(source);
  // With --install and no --output the collection is never written as a tree;
  // the install plan carries the artifacts straight to the host destination.
  const output = opts.output ? path.resolve(opts.output) : undefined;
  // Not the spec directory, which is normally the repository root and is exactly
  // where a build output belongs. What must not be written into is a bundle,
  // whose tree is a source the renderer reads.
  if (output) {
    const resolvedOutput = resolveThroughExistingAncestors(output);
    const inside = spec.bundles.find((entry) => isInside(entry.root, resolvedOutput));
    if (inside) throw new Error(`Output directory must not be inside a bundle: ${inside.path}`);
  }

  // A spec that does not parse cannot be built from, so report and stop rather
  // than rendering against half-validated data.
  if (specDiagnostics.some((item) => item.severity === "error")) {
    outputDecidedResult(
      {
        command: "marketplace",
        ok: false,
        source: spec.file,
        targets: spec.targets,
        artifacts: [],
        diagnostics: specDiagnostics,
      } satisfies AgentResult,
      opts,
    );
    return;
  }

  // --target narrows the spec rather than replacing it: the spec is the record
  // of what this collection is for, and a flag that could add to it would let
  // CI publish a target the spec never declared.
  const requested = opts.target?.length ? resolveTargets(opts.target, true) : spec.targets;
  const unknown = requested.filter((target) => !spec.targets.includes(target));
  if (unknown.length)
    throw new Error(
      `--target ${unknown.join(", ")} is not declared by ${path.basename(spec.file)}`,
    );
  const targets: AgentTarget[] = spec.targets.filter((target) => requested.includes(target));

  const built = buildCollection(spec, targets, mode, { archive: opts.archive });
  const diagnostics = [...specDiagnostics, ...built.diagnostics];

  const all = [
    ...built.artifacts,
    {
      path: MARKETPLACE_REPORT,
      content: Buffer.from(
        JSON.stringify(
          { generator: { name: packageName, version: packageVersion }, ...built.report },
          null,
          2,
        ) + "\n",
      ),
      mode: 0o644,
    },
  ];

  // Install plans are built before the pass/fail decision so their own findings
  // — an occupied destination, a missing activation edit — can block the write
  // rather than being discovered after it.
  const plans: InstallPlan[] = [];
  if (opts.install) {
    const scope = resolveScope(opts.scope, "user");
    for (const target of targets) {
      const entry = built.report.targets.find((item) => item.target === target);
      if (!entry?.plugins.length) continue;
      const plan = planCollectionInstall(
        {
          name: spec.name,
          version: spec.version,
          target,
          artifacts: forTarget(built.artifacts, target),
          plugins: entry.plugins.map((plugin) => ({
            name: plugin.name,
            version: plugin.version,
          })),
        },
        {
          scope,
          into: opts.into,
          link: opts.link,
          force: opts.force,
          register: opts.register,
          materializeInto: opts.link
            ? path.join(spec.root, INSTALL_CACHE, target, "plugin")
            : undefined,
        },
      );
      plans.push(plan);
      diagnostics.push(...plan.diagnostics);
    }
  }

  const blocked = collectionHasFindings(diagnostics, Boolean(opts.strict));
  const stale = opts.check
    ? plans.length
      ? !plans.every((plan) => installIsCurrent(plan))
      : !matchesCollection(output!, all)
    : false;
  const readOnly = Boolean(opts.dryRun) || Boolean(opts.check);
  if (!readOnly && !blocked) {
    if (output)
      writeArtifactsAtomically(output, all, {
        managedRoots: targets,
        looseFiles: all
          .filter((artifact) => !targets.some((target) => artifact.path.startsWith(`${target}/`)))
          .map((artifact) => artifact.path),
        force: Boolean(opts.force),
      });
    for (const plan of plans) commitInstall(plan);
  }

  const installs: InstallEntry[] = plans.map(planToEntry);

  outputDecidedResult(
    {
      command: "marketplace",
      ok: !blocked && !stale,
      source: spec.file,
      targets,
      profiles: ["plugin"],
      artifacts: all.map((artifact) => ({
        path: artifact.path,
        bytes: artifact.content.length,
        mode: `0${artifact.mode.toString(8)}`,
        ...(artifact.origin === "native" ? { origin: artifact.origin } : {}),
      })),
      diagnostics,
      marketplace: built.report,
      ...(opts.install ? { install: { installs } } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.check ? { check: true, stale } : {}),
    } satisfies AgentResult,
    opts,
  );
}
