import fs from "node:fs";
import path from "node:path";
import type { AgentDiagnostic, AgentResult, Artifact } from "../agent/types.js";
import { TARGETS, diagnostic } from "../agent/types.js";
import type { AgentProfile } from "../agent/types.js";
import { loadBundle } from "../agent/parser.js";
import { renderBundle } from "../agent/render.js";
import { planUpgrade } from "../agent/upgrade.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult } from "./agent.js";

export interface AgentUpgradeOptions extends AgentOptions {
  toSchema?: string;
}

const PROFILES: AgentProfile[] = ["plugin", "project"];

/** Every artifact reduced to a comparable shape, for the byte-identity guard. */
function fingerprint(artifacts: Artifact[]): string[] {
  return artifacts
    .map((artifact) => `${artifact.path} ${artifact.mode} ${artifact.content.toString("base64")}`)
    .sort();
}

/**
 * Rewrites one file in place, atomically.
 *
 * A rename within a directory is atomic on POSIX, so a reader never observes a
 * partial manifest. This is deliberately not `writeArtifactsAtomically`, which
 * is directory-shaped and would replace roots this command does not own.
 */
function writeFileAtomically(destination: string, content: Buffer, mode: number): void {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.cairn-${process.pid}.tmp`,
  );
  fs.writeFileSync(temporary, content, { mode, flag: "wx" });
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export async function agentUpgradeAction(source: string, opts: AgentUpgradeOptions): Promise<void> {
  if (opts.check && opts.dryRun) throw new Error("--check and --dry-run cannot be used together");
  // Required rather than defaulted: an implicit "latest" would make a CI run's
  // result depend on which Cairn version happened to be installed.
  if (!opts.toSchema) throw new Error("--to-schema is required, for example --to-schema 2");

  const bundle = loadBundle(source);
  const manifestPath = path.join(bundle.root, "agent-bundle.yaml");
  const original = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
  const plan = planUpgrade(bundle, original, opts.toSchema);
  const diagnostics: AgentDiagnostic[] = [...plan.diagnostics];

  // The byte-identity guard. Schema 2 is a strict superset, so a migration that
  // changes any rendered byte is a defect — proven here by rendering both
  // manifests in memory rather than trusted to a test.
  if (plan.content) {
    const before = fingerprint(renderBundle(bundle, [...TARGETS], PROFILES).artifacts);
    const after = fingerprintMigrated(bundle.root, plan.content, manifestPath, original);
    if (before.join("\n") !== after.join("\n"))
      diagnostics.push({
        ...diagnostic(
          "AB224",
          "The migration would change generated output, which schema 2 must never do",
          "unsupported",
          {
            path: manifestPath,
            remediation: "This is a Cairn defect; please report it.",
          },
        ),
        severity: "error",
      });
  }

  const blocked = diagnostics.some((item) => item.severity === "error");
  const stale = plan.content !== null;
  const readOnly = Boolean(opts.dryRun) || Boolean(opts.check);
  if (!readOnly && !blocked && plan.content) writeFileAtomically(manifestPath, plan.content, 0o644);

  const result: AgentResult = {
    command: "upgrade",
    // An AB221 human-judgment notice is not a failure; only errors and a
    // stale --check are. `hasFindings` would fail on any approximate mapping,
    // which is why this decides its own status like `agent doctor` does.
    ok: !blocked && !(opts.check && stale),
    source: bundle.root,
    targets: [],
    artifacts: plan.content
      ? [
          {
            path: "agent-bundle.yaml",
            bytes: plan.content.length,
            mode: "0644",
          },
        ]
      : [],
    diagnostics,
    upgrade: plan.report,
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.check ? { check: true, stale } : {}),
  };
  outputDecidedResult(result, opts);
}

/**
 * Renders the bundle as if the migrated manifest were already in place.
 *
 * The manifest is swapped, rendered, and restored, because `loadBundle` reads
 * from disk. The original bytes are written back in a `finally`, so an
 * interrupted run cannot leave a half-migrated manifest behind.
 */
function fingerprintMigrated(
  root: string,
  migrated: Buffer,
  manifestPath: string,
  original: string,
): string[] {
  fs.writeFileSync(manifestPath, migrated);
  try {
    return fingerprint(renderBundle(loadBundle(root), [...TARGETS], PROFILES).artifacts);
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
}
