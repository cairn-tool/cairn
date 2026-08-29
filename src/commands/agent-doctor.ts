import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "../agent/parser.js";
import { renderBundle } from "../agent/render.js";
import type {
  AgentDiagnostic,
  AgentResult,
  AgentTarget,
  DoctorReport,
  HostReport,
  HostStatus,
} from "../agent/types.js";
import { TARGETS } from "../agent/types.js";
import {
  CONVERSION_REPORT,
  diffOutput,
  type ConversionProvenance,
  type OutputDiff,
} from "../agent/output.js";
import type { HostProfile } from "../agent/targets/index.js";
import {
  compareSemver,
  describesPath,
  parseSemver,
  profileFor,
  validateProfile,
} from "../agent/targets/index.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult, profiles, resolveTargets } from "./agent.js";

export interface AgentDoctorOptions extends AgentOptions {
  hostVersion?: string[];
}

/**
 * Builds a doctor finding. These are statements about conformance rather than
 * about mapping fidelity, so severity is set directly instead of being derived
 * from a {@link AgentDiagnostic.quality}.
 */
function finding(
  code: string,
  severity: AgentDiagnostic["severity"],
  message: string,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  return { code, severity, message, quality: "exact", ...extra };
}

/**
 * Parses `--host-version` values. Accepts `<target>@<semver>`, or a bare
 * `<semver>` when exactly one target is selected. Throws on anything else so
 * the caller exits 1 rather than reporting a misleading conformance finding.
 */
export function parseHostVersions(
  specs: string[] | undefined,
  targets: AgentTarget[],
): Map<AgentTarget, string> {
  const versions = new Map<AgentTarget, string>();
  for (const spec of specs ?? []) {
    const at = spec.lastIndexOf("@");
    let target: string;
    let version: string;
    if (at === -1) {
      if (targets.length !== 1)
        throw new Error(
          `--host-version ${spec} needs a target: use <target>@<version> when more than one target is selected`,
        );
      target = targets[0];
      version = spec;
    } else {
      target = spec.slice(0, at);
      version = spec.slice(at + 1);
    }
    if (!TARGETS.includes(target as AgentTarget))
      throw new Error(`Unknown target in --host-version: ${target}`);
    if (!parseSemver(version))
      throw new Error(`Invalid version in --host-version: ${version || "(empty)"}`);
    versions.set(target as AgentTarget, version);
  }
  return versions;
}

/**
 * Classifies an installed host version against a profile's recorded bounds.
 * Pure so the branches stay reachable while the shipped profiles record no
 * bounds at all.
 */
export function hostVersionStatus(host: HostProfile, requested: string | null): HostStatus {
  if (!requested) return "unknown";
  if (!host.minimumVersion && !host.verifiedThrough) return "unverified";
  if (host.minimumVersion && compareSemver(requested, host.minimumVersion) < 0)
    return "below-minimum";
  if (host.verifiedThrough && compareSemver(requested, host.verifiedThrough) > 0) return "newer";
  return "verified";
}

function hostStatus(
  target: AgentTarget,
  requested: string | null,
): { report: HostReport; findings: AgentDiagnostic[] } {
  const { host } = profileFor(target);
  const status = hostVersionStatus(host, requested);
  const report: HostReport = {
    target,
    requested,
    minimumVersion: host.minimumVersion,
    verifiedThrough: host.verifiedThrough,
    documentationRevision: host.documentationRevision,
    status,
  };
  const findings: Record<HostStatus, () => AgentDiagnostic> = {
    unknown: () =>
      finding(
        "AB414",
        "notice",
        `No host version supplied for ${target}; the profile documented ${host.documentationRevision} is assumed`,
        { target, remediation: `Pass --host-version ${target}@<version> to have it evaluated.` },
      ),
    unverified: () =>
      finding(
        "AB414",
        "notice",
        `No verified host range is recorded for ${target}; version ${requested} was accepted but not evaluated (profile documented ${host.documentationRevision})`,
        { target },
      ),
    "below-minimum": () =>
      finding(
        "AB410",
        "error",
        `Host ${target} ${requested} is below the profile minimum ${host.minimumVersion}`,
        { target, remediation: `Upgrade ${target} to ${host.minimumVersion} or newer.` },
      ),
    newer: () =>
      finding(
        "AB412",
        "warning",
        `Host ${target} ${requested} is newer than the profile's verified ceiling ${host.verifiedThrough}`,
        {
          target,
          remediation:
            "Regenerate with a newer Cairn; the target profile may not describe this host yet.",
        },
      ),
    verified: () =>
      finding("AB411", "notice", `Host ${target} ${requested} is within the verified range`, {
        target,
      }),
  };
  return { report, findings: [findings[status]()] };
}

function readProvenance(output: string): ConversionProvenance | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(output, CONVERSION_REPORT), "utf8"),
    ) as ConversionProvenance;
  } catch {
    return undefined;
  }
}

function outputFindings(
  output: string,
  diff: OutputDiff,
  targets: AgentTarget[],
): AgentDiagnostic[] {
  const findings: AgentDiagnostic[] = [];
  for (const missing of diff.missing)
    findings.push(
      finding("AB402", "error", `Generated output is missing '${missing}'`, {
        path: missing,
        remediation: "Re-run agent convert to regenerate the tree.",
      }),
    );
  for (const changed of diff.changed)
    findings.push(
      finding("AB402", "error", `Generated output differs from the bundle at '${changed}'`, {
        path: changed,
        remediation: "Re-run agent convert; edit the bundle rather than the generated tree.",
      }),
    );
  for (const extra of diff.unmanaged)
    findings.push(
      finding("AB403", "warning", `Unmanaged file in the generated tree: '${extra}'`, {
        path: extra,
        remediation: "Remove it, or add it to the bundle so conversion owns it.",
      }),
    );

  const provenance = readProvenance(output);
  if (!provenance) {
    findings.push(
      finding("AB405", "notice", `No readable ${CONVERSION_REPORT} at the output root`, {
        remediation: "Regenerate with agent convert so provenance is recorded.",
      }),
    );
    return findings;
  }
  for (const target of targets) {
    const recorded = provenance.targetProfiles?.[target]?.documentationRevision;
    const current = profileFor(target).host.documentationRevision;
    if (recorded && recorded < current)
      findings.push(
        finding(
          "AB404",
          "warning",
          `Generated output for ${target} predates the current target profile (${recorded} < ${current})`,
          { target, remediation: "Re-run agent convert to pick up the updated target profile." },
        ),
      );
  }
  return findings;
}

/**
 * Doctor's own pass/fail rule. It deliberately does not reuse the shared
 * `hasFindings`, which treats any approximate mapping as a failure even without
 * `--strict` — that would make every codex bundle a doctor failure.
 */
export function doctorHasFindings(diagnostics: AgentDiagnostic[], strict: boolean): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.severity === "warning"),
  );
}

export async function agentDoctorAction(
  source: string | undefined,
  opts: AgentDoctorOptions,
): Promise<void> {
  const selected = resolveTargets(opts.target);
  const targets = selected.length ? selected : [...TARGETS];
  const selectedProfiles = profiles(opts.profile);
  const hostVersions = parseHostVersions(opts.hostVersion, targets);
  const diagnostics: AgentDiagnostic[] = [];
  const doctor: DoctorReport = { hosts: [], undeclared: [], overlays: [], native: [] };

  // 1. The profiles themselves must be internally consistent. This makes a
  //    bare `agent doctor --target all` meaningful with no bundle at all.
  for (const target of targets)
    for (const problem of validateProfile(profileFor(target)))
      diagnostics.push(
        finding("AB400", "error", `Target profile for ${target} is inconsistent: ${problem}`, {
          target,
          remediation: "This is a Cairn defect; please report it.",
        }),
      );

  // 2. Host versions.
  for (const target of targets) {
    const { report, findings } = hostStatus(target, hostVersions.get(target) ?? null);
    doctor.hosts.push(report);
    diagnostics.push(...findings);
  }

  let root: string | undefined;
  if (source) {
    const bundle = loadBundle(source);
    root = bundle.root;
    const rendered = renderBundle(bundle, targets, selectedProfiles);
    diagnostics.push(...rendered.diagnostics);

    // 3. Every rendered path must be one the target profile describes.
    //    Legacy plugins place assets at the output root, which target-relative
    //    patterns cannot bound, so the check does not apply to them.
    if (!bundle.legacy)
      for (const target of targets)
        for (const profile of selectedProfiles) {
          const prefix = `${target}/${profile}/`;
          for (const artifact of rendered.artifacts) {
            if (!artifact.path.startsWith(prefix)) continue;
            const relative = artifact.path.slice(prefix.length);
            // An overlay path is outside the profile by design — that is the
            // point of an overlay. Report it positively instead of as a defect.
            if (artifact.origin === "native") {
              doctor.overlays.push({ target, profile, path: relative });
              continue;
            }
            if (describesPath(profileFor(target), profile, relative)) continue;
            doctor.undeclared.push({ target, profile, path: relative });
            diagnostics.push(
              finding(
                "AB401",
                "error",
                `Rendered path '${relative}' is not described by the ${target} profile`,
                {
                  target,
                  profile,
                  path: relative,
                  remediation: "This is a Cairn defect; please report it.",
                },
              ),
            );
          }
        }

    // 4. An existing generated tree must still match the bundle.
    if (opts.output) {
      const output = path.resolve(opts.output);
      if (!fs.existsSync(output)) throw new Error(`Output directory does not exist: ${output}`);
      // The report is not part of the diff: a tree generated by an older CLI
      // may not have one at all, which is a notice (AB405), not drift.
      const diff = diffOutput(output, rendered.artifacts, targets, selectedProfiles);
      doctor.output = { root: output, ...diff };
      diagnostics.push(...outputFindings(output, diff, targets));
    }
  } else if (opts.output) {
    throw new Error("--output requires a bundle source to compare against");
  }

  const result: AgentResult = {
    command: "doctor",
    ok: !doctorHasFindings(diagnostics, Boolean(opts.strict)),
    ...(root ? { source: root } : {}),
    targets,
    profiles: selectedProfiles,
    artifacts: [],
    diagnostics,
    doctor,
  };
  outputDecidedResult(result, opts);
}
