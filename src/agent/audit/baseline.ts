import crypto from "node:crypto";
import fs from "node:fs";
import type { AgentDiagnostic, AgentProfile, AgentTarget, Artifact } from "../types.js";
import { diagnostic } from "../types.js";
import { classify } from "../package/index.js";

/** The `sbom.json` format `agent package` writes. */
export const BASELINE_FORMAT = "cairn-inventory";

/** The pre-rename discriminator, still accepted on committed inventories. */
export const LEGACY_BASELINE_FORMAT = "claude-cli-inventory";

export interface BaselineComponent {
  path: string;
  type: string;
  sha256: string;
  bytes: number;
  mode: string;
  origin: string;
}

export interface BaselineDocument {
  bomFormat?: string;
  generator?: { name: string; version: string };
  subject?: { name: string; version: string };
  components?: BaselineComponent[];
}

export interface AuditBaseline {
  path: string;
  subject: { name: string; version: string } | null;
  generator: { name: string; version: string } | null;
  /** Paths compared, after narrowing to the executable set. */
  compared: number;
  added: string[];
  removed: string[];
  changed: string[];
  modeChanged: Array<{ path: string; from: string; to: string }>;
}

/**
 * Reads a previous package inventory.
 *
 * A missing or unparseable file throws, matching how `agent package
 * --from-dist` and `agent doctor --output` treat a path that is not there. A
 * *foreign* document is a finding instead (AB654), because guessing at another
 * tool's schema would produce drift reports nobody can trust.
 */
export function readBaseline(file: string): BaselineDocument {
  if (!fs.existsSync(file)) throw new Error(`--baseline file does not exist: ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`--baseline is not valid JSON: ${file}`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`--baseline is not an inventory document: ${file}`);
  return parsed as BaselineDocument;
}

function mode(value: number): string {
  return `0${value.toString(8)}`;
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Compares the executable surface of a package against a previous inventory.
 *
 * Scope is deliberately the executable set — baseline components typed `script`
 * or `executable`, plus anything currently carrying an execute bit. That is
 * exactly the question ("what can run, and did it change?"), and it drops
 * `checksums.sha256`, `sbom.json`, `package-report.json`, and the marketplace
 * catalogs for free, so a differently-packaged run never reports them as
 * removed.
 */
export function diffBaseline(
  document: BaselineDocument,
  file: string,
  artifacts: Artifact[],
  targets: AgentTarget[],
  profiles: AgentProfile[],
): { diagnostics: AgentDiagnostic[]; report: AuditBaseline } {
  const report: AuditBaseline = {
    path: file,
    subject: document.subject ?? null,
    generator: document.generator ?? null,
    compared: 0,
    added: [],
    removed: [],
    changed: [],
    modeChanged: [],
  };

  if (document.bomFormat !== BASELINE_FORMAT && document.bomFormat !== LEGACY_BASELINE_FORMAT)
    return {
      report,
      diagnostics: [
        diagnostic(
          "AB654",
          `--baseline is not a ${BASELINE_FORMAT} document; drift checks were skipped`,
          "approximate",
          {
            path: file,
            remediation: "Pass the sbom.json that agent package wrote.",
          },
        ),
      ],
    };

  // The selected scope, so a plugin-only audit does not report every project
  // path in the baseline as removed.
  const prefixes = targets.flatMap((target) => profiles.map((profile) => `${target}/${profile}/`));
  const inScope = (candidate: string): boolean =>
    prefixes.some((prefix) => candidate.startsWith(prefix));

  const before = new Map<string, BaselineComponent>();
  for (const component of document.components ?? [])
    if (inScope(component.path) && (component.type === "script" || component.type === "executable"))
      before.set(component.path, component);

  // Anything the baseline tracked stays in scope even if it is no longer
  // executable, so losing the execute bit is reported as the mode change it is
  // rather than as a removal.
  const after = new Map<string, Artifact>();
  for (const artifact of artifacts)
    if (
      inScope(artifact.path) &&
      (before.has(artifact.path) || ["script", "executable"].includes(classify(artifact)))
    )
      after.set(artifact.path, artifact);

  const diagnostics: AgentDiagnostic[] = [];
  for (const [candidate, artifact] of after) {
    const previous = before.get(candidate);
    if (!previous) {
      report.added.push(candidate);
      diagnostics.push(
        diagnostic("AB652", `New executable since the baseline: ${candidate}`, "approximate", {
          path: candidate,
          remediation: "Confirm the addition is intended before publishing.",
        }),
      );
      continue;
    }
    report.compared += 1;
    const current = sha256(artifact.content);
    if (previous.sha256 !== current) {
      report.changed.push(candidate);
      diagnostics.push(
        diagnostic("AB650", `Executable content changed: ${candidate}`, "approximate", {
          path: candidate,
          remediation: "Review the diff against the released version.",
        }),
      );
    }
    const now = mode(artifact.mode);
    if (previous.mode !== now) {
      report.modeChanged.push({ path: candidate, from: previous.mode, to: now });
      const gained =
        (artifact.mode & 0o111) !== 0 && (Number.parseInt(previous.mode, 8) & 0o111) === 0;
      diagnostics.push(
        diagnostic(
          "AB651",
          `Mode changed ${previous.mode} → ${now}${gained ? " (gained the execute bit)" : ""}: ${candidate}`,
          "approximate",
          { path: candidate },
        ),
      );
    }
  }

  for (const candidate of before.keys())
    if (!after.has(candidate)) {
      report.removed.push(candidate);
      diagnostics.push(
        diagnostic("AB653", `Executable removed since the baseline: ${candidate}`, "exact", {
          path: candidate,
        }),
      );
    }

  report.added = sorted(report.added);
  report.removed = sorted(report.removed);
  report.changed = sorted(report.changed);
  report.modeChanged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { diagnostics, report };
}
