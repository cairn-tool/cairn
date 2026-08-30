import type { BundleMarketplace } from "./manifest.js";
import type { UpgradeReport } from "./upgrade.js";
import type { ImportReport } from "./import/normalize.js";
import type { PackageReport } from "./package/index.js";
import type { AuditReport } from "./audit/index.js";
import type { TestReport } from "./test/index.js";
import type { InstallReport } from "./install/index.js";
import type { MarketplaceReport } from "./marketplace/index.js";
import type { VerifyReport } from "./verify/index.js";

export const TARGETS = ["claude-code", "codex", "cursor", "antigravity", "opencode"] as const;
export type AgentTarget = (typeof TARGETS)[number];
export type AgentProfile = "plugin" | "project";
export type MappingQuality = "exact" | "approximate" | "unsupported";

export interface AgentDiagnostic {
  code: string;
  severity: "notice" | "warning" | "error";
  message: string;
  component?: string;
  path?: string;
  target?: AgentTarget;
  profile?: AgentProfile;
  quality: MappingQuality;
  remediation?: string;
}

export interface SourceFile {
  path: string;
  content: Buffer;
  mode: number;
}

export interface MarkdownComponent {
  name: string;
  description: string;
  path: string;
  metadata: Record<string, unknown>;
  body: string;
  files: SourceFile[];
}

export interface BundleRule extends MarkdownComponent {
  activation: "always" | "files" | "model" | "manual";
  globs: string[];
}

/**
 * A target-native overlay: files copied verbatim into one target's output,
 * keyed by the output profile they belong to. This is how a platform-only
 * feature reaches the generated tree without being given a false portable
 * abstraction.
 */
export interface NativeOverlay {
  target: AgentTarget;
  /** Absolute path to the overlay root. */
  root: string;
  /** Overlay files, POSIX-relative to `root/<profile>`, per output profile. */
  files: Record<AgentProfile, SourceFile[]>;
  /** `native/<target>/manifest.json`, merged over the generated plugin manifest. */
  manifest?: Record<string, unknown>;
  /**
   * What happens when an overlay file claims a path a portable artifact already
   * produced. Defaults to `overlay-wins`: an overlay is a deliberate,
   * target-specific statement, so honoring it and reporting AB181 beats
   * discarding it silently. `error` refuses the whole conversion instead.
   */
  onCollision: "overlay-wins" | "error";
}

export interface AgentBundle {
  schemaVersion: string;
  name: string;
  version: string;
  description: string;
  root: string;
  legacy: boolean;
  manifest: Record<string, unknown>;
  /** Declared listing metadata. Read by `agent package`; ignored by `agent convert`. */
  marketplace?: BundleMarketplace;
  /** Loaded native overlays. Always empty on a v1 or legacy bundle. */
  overlays: NativeOverlay[];
  skills: MarkdownComponent[];
  agents: MarkdownComponent[];
  rules: BundleRule[];
  hooks?: { path: string; value: Record<string, unknown> };
  hookFiles: SourceFile[];
  policies: Array<{ path: string; value: Record<string, unknown> }>;
  mcp?: { path: string; value: Record<string, unknown> };
  assets: SourceFile[];
  diagnostics: AgentDiagnostic[];
  graph: Record<string, string[]>;
}

export type ArtifactOrigin = "portable" | "native";

export interface Artifact {
  path: string;
  content: Buffer;
  mode: number;
  /**
   * Absent means "portable". Only overlay-sourced artifacts set it, which is
   * what keeps `conversion-report.json` byte-identical for every bundle that
   * has no overlay.
   */
  origin?: ArtifactOrigin;
}

export type HostStatus = "unknown" | "unverified" | "below-minimum" | "verified" | "newer";

export interface HostReport {
  target: AgentTarget;
  /** The version supplied via `--host-version`, or `null` when none was given. */
  requested: string | null;
  minimumVersion: string | null;
  verifiedThrough: string | null;
  documentationRevision: string;
  status: HostStatus;
}

export interface DoctorReport {
  /** One row per selected target, present even when no host version is known. */
  hosts: HostReport[];
  /** Populated only when `--output` was given. */
  output?: { root: string; missing: string[]; changed: string[]; unmanaged: string[] };
  /** Rendered paths no target profile describes. */
  undeclared: Array<{ target: AgentTarget; profile: AgentProfile; path: string }>;
  /**
   * Paths contributed by a native overlay. These are exempt from the declared
   * path check by design — being outside the profile is what an overlay is for —
   * so they are reported positively here rather than as `undeclared` findings.
   */
  overlays: Array<{ target: AgentTarget; profile: AgentProfile; path: string }>;
  /**
   * Reserved for evidence from a host's own validator. Always empty in this
   * release: `agent doctor` never spawns a process, so its result does not
   * depend on what happens to be installed.
   */
  native: never[];
}

export type PlanAction = "create" | "update" | "skip";

export interface PlanOperation {
  action: PlanAction;
  /** POSIX path relative to the plan root. */
  path: string;
  kind: string;
  bytes: number;
  /** Octal file mode, spelled as in `artifacts[].mode`. */
  mode: string;
  /** Why a `skip`, or what an `update` changes. */
  reason?: string;
}

export interface AgentPlan {
  root: string;
  operations: PlanOperation[];
}

export interface AgentResult {
  command:
    | "convert"
    | "validate"
    | "inspect"
    | "compat"
    | "doctor"
    | "specs"
    | "init"
    | "add"
    | "upgrade"
    | "import"
    | "package"
    | "audit"
    | "test"
    | "install"
    | "uninstall"
    | "installed"
    | "marketplace"
    | "verify";
  ok: boolean;
  source?: string;
  targets: AgentTarget[];
  profiles?: AgentProfile[];
  artifacts: Array<{ path: string; bytes: number; mode: string }>;
  diagnostics: AgentDiagnostic[];
  bundle?: unknown;
  compatibility?: unknown;
  /** The full target conformance profiles, emitted by `agent specs`. */
  specs?: unknown;
  /** Conformance findings, emitted by `agent doctor`. */
  doctor?: DoctorReport;
  /** What a writing command did or would do, emitted by `agent init` and `agent add`. */
  plan?: AgentPlan;
  /** Migration result, emitted by `agent upgrade`. */
  upgrade?: UpgradeReport;
  /** Provenance report, emitted by `agent import`. */
  import?: ImportReport;
  /** Packaging result, emitted by `agent package`. */
  package?: PackageReport;
  /** Review surface and findings summary, emitted by `agent audit`. */
  audit?: AuditReport;
  /** Contract test results, emitted by `agent test`. */
  test?: TestReport;
  /** Install, uninstall, or listing result, emitted by the install commands. */
  install?: InstallReport;
  /** Collection build result, emitted by `agent marketplace`. */
  marketplace?: MarketplaceReport;
  /** Drift and pin result, emitted by `agent verify`. */
  verify?: VerifyReport;
  dryRun?: boolean;
  check?: boolean;
  stale?: boolean;
}

export function diagnostic(
  code: string,
  message: string,
  quality: MappingQuality,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  return {
    code,
    severity:
      quality === "unsupported" ? "warning" : quality === "approximate" ? "warning" : "notice",
    message,
    quality,
    ...extra,
  };
}
