import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "../parser.js";
import { renderBundle } from "../render.js";
import { installKey, readInstallDocument, planInstall } from "../install/index.js";
import type { InstallDocument, InstallRecord } from "../install/index.js";
import { guardSettingsFrom } from "../install/guard.js";
import type { GuardSettings } from "../install/guard.js";
import { resolveGuardConfig } from "../guard/resolve.js";
import { CONVERSION_REPORT, diffOutput } from "../output.js";
import type { ConversionProvenance } from "../output.js";
import { PROFILE_SCHEMA_VERSION, compareSemver } from "../targets/schema.js";
import { profileFor } from "../targets/index.js";
import { packageName, packageVersion } from "../../version.js";
import type { AgentDiagnostic, AgentProfile, AgentTarget, Artifact } from "../types.js";
import type { VerifyConfig, VerifyEntry, VersionBound } from "./config.js";
import { diffTree, treeMatches, walkRootsFor } from "./compare.js";

/**
 * Checks that the agent-facing files committed in a repository are still what
 * the bundles they came from render, and that the toolchain doing the checking
 * is the one the repository pinned.
 *
 * Pins are asserted against the *running* CLI rather than against provenance
 * recorded in the tree. Together with byte equality that proves the tree was
 * produced by a conforming cairn, without requiring a provenance document to
 * exist — which matters, because an install manifest records a generator
 * version but neither a profile schema version nor a documentation revision.
 * Provenance found at a destination is corroboration only, and never decides
 * the verdict.
 */

export type PinStatus = "satisfied" | "violated" | "unpinned";

export interface PinReport<T> {
  declared: T | null;
  actual: string;
  status: PinStatus;
}

export interface VerifyPinsReport {
  cli: PinReport<VersionBound>;
  profileSchemaVersion: PinReport<string>;
  targets: Array<{ target: AgentTarget } & PinReport<VersionBound>>;
}

export interface VerifyProvenance {
  source: string;
  generator: { name: string; version: string } | null;
  profileSchemaVersion: string | null;
  status: "matching" | "older" | "newer" | "malformed";
}

export interface VerifyEntryReport {
  name: string;
  bundle: string;
  target: AgentTarget;
  profile: AgentProfile;
  scope: string;
  layout: string;
  destination: string;
  mode: string;
  expected: number;
  missing: string[];
  changed: string[];
  orphaned: string[];
  unmanaged: string[];
  provenance?: VerifyProvenance;
  ok: boolean;
}

export interface VerifyReport {
  config: { path: string; entries: number };
  generator: { name: string; version: string };
  profileSchemaVersion: string;
  pins: VerifyPinsReport;
  entries: VerifyEntryReport[];
  counts: {
    entries: number;
    ok: number;
    missing: number;
    changed: number;
    orphaned: number;
    unmanaged: number;
  };
}

function error(code: string, message: string, extra: Partial<AgentDiagnostic> = {}) {
  return { code, severity: "error", message, quality: "exact", ...extra } as AgentDiagnostic;
}

function notice(code: string, message: string, extra: Partial<AgentDiagnostic> = {}) {
  return { code, severity: "notice", message, quality: "exact", ...extra } as AgentDiagnostic;
}

/**
 * Evaluates one bound with a caller-supplied ordering.
 *
 * Documentation revisions are ISO dates compared lexicographically, exactly as
 * `agent doctor` already compares them; CLI versions go through
 * {@link compareSemver}.
 */
function satisfies(
  actual: string,
  declared: VersionBound,
  compare: (a: string, b: string) => number,
): boolean {
  if (declared.exact !== undefined) return compare(actual, declared.exact) === 0;
  if (declared.min !== undefined && compare(actual, declared.min) < 0) return false;
  if (declared.max !== undefined && compare(actual, declared.max) > 0) return false;
  return true;
}

function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(bound: VersionBound): string {
  if (bound.exact !== undefined) return `exactly ${bound.exact}`;
  return [
    bound.min !== undefined ? `>= ${bound.min}` : undefined,
    bound.max !== undefined ? `<= ${bound.max}` : undefined,
  ]
    .filter(Boolean)
    .join(" and ");
}

export function evaluatePins(
  config: VerifyConfig,
  targets: readonly AgentTarget[],
): { report: VerifyPinsReport; diagnostics: AgentDiagnostic[] } {
  const diagnostics: AgentDiagnostic[] = [];
  const { pins } = config;

  const cli: PinReport<VersionBound> = {
    declared: pins.cli ?? null,
    actual: packageVersion,
    status: !pins.cli
      ? "unpinned"
      : satisfies(packageVersion, pins.cli, compareSemver)
        ? "satisfied"
        : "violated",
  };
  if (cli.status === "violated" && pins.cli)
    diagnostics.push(
      error(
        "AB420",
        `Running ${packageName} ${packageVersion} does not satisfy the pinned range (${describe(pins.cli)})`,
        {
          remediation:
            "Install a cairn matching the pin, or update the pin and regenerate the trees in the same commit.",
        },
      ),
    );

  const schema: PinReport<string> = {
    declared: pins.profileSchemaVersion ?? null,
    actual: PROFILE_SCHEMA_VERSION,
    status: !pins.profileSchemaVersion
      ? "unpinned"
      : pins.profileSchemaVersion === PROFILE_SCHEMA_VERSION
        ? "satisfied"
        : "violated",
  };
  if (schema.status === "violated")
    diagnostics.push(
      error(
        "AB421",
        `Target profile schema version is ${PROFILE_SCHEMA_VERSION}, but ${pins.profileSchemaVersion} is pinned`,
        { remediation: "Update the pin and regenerate the trees in the same commit." },
      ),
    );

  const targetReports: VerifyPinsReport["targets"] = [];
  for (const target of targets) {
    const declared = pins.targets[target];
    const actual = profileFor(target).host.documentationRevision;
    const status: PinStatus = !declared
      ? "unpinned"
      : satisfies(actual, declared, lexical)
        ? "satisfied"
        : "violated";
    targetReports.push({ target, declared: declared ?? null, actual, status });
    if (status === "violated" && declared)
      diagnostics.push(
        error(
          "AB422",
          `The ${target} target profile revision is ${actual}, which does not satisfy the pinned range (${describe(declared)})`,
          {
            target,
            remediation: "Update the pin and regenerate the trees in the same commit.",
          },
        ),
      );
  }

  return { report: { cli, profileSchemaVersion: schema, targets: targetReports }, diagnostics };
}

function readConversionProvenance(destination: string): VerifyProvenance | undefined {
  const file = path.join(destination, CONVERSION_REPORT);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ConversionProvenance>;
    return {
      source: CONVERSION_REPORT,
      generator: parsed.generator ?? null,
      profileSchemaVersion: parsed.profileSchemaVersion ?? null,
      status: "matching",
    };
  } catch {
    return {
      source: CONVERSION_REPORT,
      generator: null,
      profileSchemaVersion: null,
      status: "malformed",
    };
  }
}

function provenanceOf(manifest: InstallDocument): VerifyProvenance {
  return {
    source: ".cairn-install.json",
    generator: manifest.generator,
    // An install manifest records no profile schema version. Reported as null
    // rather than invented, so a consumer can tell "not recorded" from "2".
    profileSchemaVersion: null,
    status: "matching",
  };
}

/**
 * A recorded version this build cannot parse counts as older rather than
 * throwing: provenance is corroboration, and never the verdict.
 */
function isNewer(recorded: string): boolean {
  try {
    return compareSemver(recorded, packageVersion) > 0;
  } catch {
    return false;
  }
}

function gradeProvenance(provenance: VerifyProvenance): VerifyProvenance {
  if (provenance.status === "malformed" || !provenance.generator) return provenance;
  const recorded = provenance.generator.version;
  if (recorded === packageVersion) return provenance;
  return { ...provenance, status: isNewer(recorded) ? "newer" : "older" };
}

/** The edit guard's artifacts at one destination, to compare once for all entries there. */
interface GuardCheck {
  destination: string;
  artifacts: Artifact[];
}

function verifyEntry(
  entry: VerifyEntry,
  guard: GuardSettings,
): {
  report: VerifyEntryReport;
  diagnostics: AgentDiagnostic[];
  guard?: GuardCheck;
} {
  const diagnostics: AgentDiagnostic[] = [];
  const base = {
    name: entry.name,
    bundle: entry.bundle,
    target: entry.target,
    profile: entry.profile,
    scope: entry.scope,
    layout: entry.layout,
    destination: entry.destination,
    mode: entry.unmanaged,
  };

  if (!fs.existsSync(entry.destination) || !fs.statSync(entry.destination).isDirectory()) {
    diagnostics.push(
      error("AB423", `Destination does not exist or is not a directory: ${entry.destination}`, {
        target: entry.target,
        profile: entry.profile,
        path: entry.destination,
        remediation: "Generate the tree, or remove the entry from the verify configuration.",
      }),
    );
    return {
      report: {
        ...base,
        expected: 0,
        missing: [],
        changed: [],
        orphaned: [],
        unmanaged: [],
        ok: false,
      },
      diagnostics,
    };
  }

  const bundle = loadBundle(entry.bundle);

  // A conversion root keeps the `<target>/<profile>` prefix the renderer emits,
  // so it is the one layout `diffOutput` describes and is reused unchanged.
  if (entry.layout === "conversion") {
    const rendered = renderBundle(bundle, [entry.target], [entry.profile]);
    diagnostics.push(...rendered.diagnostics);
    const diff = diffOutput(entry.destination, rendered.artifacts, [entry.target], [entry.profile]);
    const provenance = readConversionProvenance(entry.destination);
    const report: VerifyEntryReport = {
      ...base,
      expected: rendered.artifacts.length,
      missing: diff.missing,
      changed: diff.changed,
      orphaned: [],
      unmanaged: entry.unmanaged === "strict" ? diff.unmanaged : [],
      ...(provenance ? { provenance: gradeProvenance(provenance) } : {}),
      ok: false,
    };
    return { report: finish(report, diagnostics, entry), diagnostics };
  }

  const plan = planInstall(bundle, entry.target, {
    scope: entry.scope,
    into: entry.destination,
    profile: entry.profile,
    // The destination is expected to be occupied — that is the whole point —
    // so the occupancy check must not turn into an AB801 error here.
    force: true,
    guard,
  });
  diagnostics.push(...plan.diagnostics.filter((item) => item.code !== "AB802"));

  // The guard is the destination's, not this bundle's: sixteen entries sharing
  // one root would otherwise report one drifted script sixteen times. It is
  // set aside here and compared once per destination by `runVerify`. A hook
  // document this bundle itself renders stays in the entry's own comparison.
  const ownPaths = new Set(plan.record.files.map((file) => file.path));
  const guardPaths = new Set((plan.guard?.paths ?? []).filter((file) => !ownPaths.has(file)));
  const artifacts = plan.artifacts.filter((artifact) => !guardPaths.has(artifact.path));
  const guardCheck: GuardCheck | undefined = plan.guard
    ? {
        destination: plan.destination,
        artifacts: plan.artifacts.filter((artifact) => plan.guard!.paths.includes(artifact.path)),
      }
    : undefined;

  const prior = readInstallDocument(plan.destination || entry.destination);
  if (prior === "malformed")
    diagnostics.push(
      error("AB806", `Install manifest at ${entry.destination} is malformed`, {
        target: entry.target,
        path: entry.destination,
        remediation: "Remove it and reinstall, or repair it by hand.",
      }),
    );

  // A destination may record several installs. The orphan source is *this*
  // entry's record alone — a sibling's files are not this bundle's orphans —
  // while the strict walk's allowlist is the union of every record, or a
  // sibling's files would all report as unmanaged.
  const records: InstallRecord[] =
    prior === "missing" || prior === "malformed" ? [] : prior.installs;
  const record = records.find(
    (item) =>
      installKey(item) ===
      installKey({
        bundle: { name: bundle.name },
        target: entry.target,
        profile: plan.profile,
        scope: entry.scope,
      }),
  );
  const inventory = record?.files.map((file) => file.path);
  const managedPaths = records.length
    ? [...new Set(records.flatMap((item) => item.files.map((file) => file.path)))]
    : undefined;
  if (!inventory && entry.unmanaged !== "off")
    diagnostics.push(
      notice(
        "AB426",
        `No install of '${bundle.name}' recorded at ${entry.destination}; files this bundle no longer renders cannot be detected`,
        {
          target: entry.target,
          path: entry.destination,
          remediation: "Reinstall so the inventory is recorded.",
        },
      ),
    );

  const expectedPaths = artifacts.map((artifact) => artifact.path);
  const diff = diffTree(plan.destination || entry.destination, artifacts, {
    unmanaged: entry.unmanaged,
    priorInventory: inventory,
    ...(managedPaths ? { managedPaths } : {}),
    walkRoots:
      entry.unmanaged === "strict"
        ? walkRootsFor(entry.target, plan.profile, expectedPaths)
        : undefined,
  });

  const provenance =
    prior !== "missing" && prior !== "malformed" ? gradeProvenance(provenanceOf(prior)) : undefined;

  const report: VerifyEntryReport = {
    ...base,
    profile: plan.profile,
    layout: entry.layout,
    expected: artifacts.length,
    missing: diff.missing,
    changed: diff.changed,
    orphaned: diff.orphaned,
    unmanaged: diff.unmanaged,
    ...(provenance ? { provenance } : {}),
    ok: false,
  };
  return {
    report: finish(report, diagnostics, entry),
    diagnostics,
    ...(guardCheck ? { guard: guardCheck } : {}),
  };
}

/**
 * Compares the edit guard at one destination and folds any drift into the
 * first entry that reported that destination, so the counts and the verdict
 * see it without every entry repeating it.
 */
function verifyGuard(
  check: GuardCheck,
  entry: VerifyEntryReport,
  diagnostics: AgentDiagnostic[],
): VerifyEntryReport {
  const diff = diffTree(check.destination, check.artifacts, { unmanaged: "off" });
  const where = { target: entry.target, profile: entry.profile };
  for (const missing of diff.missing)
    diagnostics.push(
      error("AB402", `The edit guard is missing '${missing}'`, {
        ...where,
        path: missing,
        remediation: "Run agent install again to regenerate the guard.",
      }),
    );
  for (const changed of diff.changed)
    diagnostics.push(
      error("AB402", `The edit guard at '${changed}' is not what this install generates`, {
        ...where,
        path: changed,
        remediation: "Run agent install again to regenerate the guard.",
      }),
    );
  if (!diff.missing.length && !diff.changed.length) return entry;
  return {
    ...entry,
    expected: entry.expected + check.artifacts.length,
    missing: [...entry.missing, ...diff.missing],
    changed: [...entry.changed, ...diff.changed],
    ok: false,
  };
}

/** Maps a comparison into findings and decides the entry's own verdict. */
function finish(
  report: VerifyEntryReport,
  diagnostics: AgentDiagnostic[],
  entry: VerifyEntry,
): VerifyEntryReport {
  const where = { target: entry.target, profile: report.profile };
  for (const missing of report.missing)
    diagnostics.push(
      error("AB402", `Generated output is missing '${missing}'`, {
        ...where,
        path: missing,
        remediation: "Regenerate the tree from the bundle.",
      }),
    );
  for (const changed of report.changed)
    diagnostics.push(
      error("AB402", `Generated output differs from the bundle at '${changed}'`, {
        ...where,
        path: changed,
        remediation: "Regenerate the tree; edit the bundle rather than the generated tree.",
      }),
    );
  for (const orphaned of report.orphaned)
    diagnostics.push(
      error("AB424", `'${orphaned}' was generated previously but is no longer rendered`, {
        ...where,
        path: orphaned,
        remediation: "Delete the file, or restore the component to the bundle.",
      }),
    );
  for (const unmanaged of report.unmanaged)
    diagnostics.push({
      code: "AB403",
      severity: "warning",
      quality: "exact",
      message: `Unmanaged file in the generated tree: '${unmanaged}'`,
      ...where,
      path: unmanaged,
    });
  if (report.provenance && report.provenance.status !== "matching" && report.provenance.generator)
    diagnostics.push(
      notice(
        "AB425",
        `The tree records generator ${report.provenance.generator.version}, but ${packageVersion} is verifying it`,
        { ...where, path: report.destination },
      ),
    );
  return {
    ...report,
    ok:
      !report.missing.length &&
      !report.changed.length &&
      !report.orphaned.length &&
      !report.unmanaged.length,
  };
}

export function runVerify(config: VerifyConfig): {
  report: VerifyReport;
  diagnostics: AgentDiagnostic[];
  targets: AgentTarget[];
  profiles: AgentProfile[];
} {
  const diagnostics: AgentDiagnostic[] = [];
  const targets = [...new Set(config.entries.map((entry) => entry.target))];
  const pins = evaluatePins(config, targets);
  diagnostics.push(...pins.diagnostics);

  // The same settings the install used, from the same document, or the guard's
  // bytes could not be reproduced.
  const guard = guardSettingsFrom(resolveGuardConfig({ explicitPath: config.file }));
  const entries: VerifyEntryReport[] = [];
  const guardChecks = new Map<string, { check: GuardCheck; index: number }>();
  for (const entry of config.entries) {
    const result = verifyEntry(entry, guard);
    entries.push(result.report);
    diagnostics.push(...result.diagnostics);
    if (result.guard && !guardChecks.has(result.guard.destination))
      guardChecks.set(result.guard.destination, {
        check: result.guard,
        index: entries.length - 1,
      });
  }
  for (const { check, index } of guardChecks.values())
    entries[index] = verifyGuard(check, entries[index], diagnostics);

  const counts = {
    entries: entries.length,
    ok: entries.filter((entry) => entry.ok).length,
    missing: entries.reduce((total, entry) => total + entry.missing.length, 0),
    changed: entries.reduce((total, entry) => total + entry.changed.length, 0),
    orphaned: entries.reduce((total, entry) => total + entry.orphaned.length, 0),
    unmanaged: entries.reduce((total, entry) => total + entry.unmanaged.length, 0),
  };

  return {
    report: {
      config: { path: config.file, entries: config.entries.length },
      generator: { name: packageName, version: packageVersion },
      profileSchemaVersion: PROFILE_SCHEMA_VERSION,
      pins: pins.report,
      entries,
      counts,
    },
    diagnostics,
    targets,
    profiles: [...new Set(entries.map((entry) => entry.profile))],
  };
}

export { treeMatches };
