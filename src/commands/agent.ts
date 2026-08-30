import fs from "node:fs";
import path from "node:path";
import { CommandExit, terminate } from "../command-result.js";
import { loadBundle } from "../agent/parser.js";
import { renderBundle, selected } from "../agent/render.js";
import type {
  AgentBundle,
  AgentProfile,
  AgentResult,
  AgentTarget,
  Artifact,
  DoctorReport,
  MarkdownComponent,
} from "../agent/types.js";
import type { AuditReport } from "../agent/audit/index.js";
import type { TestReport } from "../agent/test/index.js";
import type { InstallReport } from "../agent/install/index.js";
import type { MarketplaceReport } from "../agent/marketplace/index.js";
import { formatAgentSarif } from "../agent/sarif.js";
import { agentFormatsFor } from "../formats.js";
import type { OutputFormat } from "../types.js";
import { TARGETS } from "../agent/types.js";
import type { FeatureKey, SpecsPayload } from "../agent/targets/index.js";
import {
  FEATURE_KEYS,
  PROFILE_SCHEMA_VERSION,
  TARGET_PROFILES,
  compatibilityMatrix,
} from "../agent/targets/index.js";
import type { ConversionProvenance } from "../agent/output.js";
import { CONVERSION_REPORT, diffOutput, outputMatches } from "../agent/output.js";
import { writeArtifactsAtomically } from "../agent/writer.js";
import { packageName, packageVersion } from "../version.js";
import { jsonPayload } from "../result.js";

export interface AgentOptions {
  target?: string[];
  output?: string;
  profile?: string;
  strict?: boolean;
  force?: boolean;
  dryRun?: boolean;
  check?: boolean;
  format?: string;
  envelope?: boolean;
  report?: string;
}

export async function agentActionBoundary(
  command: AgentResult["command"],
  opts: AgentOptions,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CommandExit) throw error;
    if (opts.format === "json") {
      const result: AgentResult = {
        command,
        ok: false,
        targets: (opts.target ?? []).filter((target): target is AgentTarget =>
          TARGETS.includes(target as AgentTarget),
        ),
        artifacts: [],
        diagnostics: [
          {
            code: "AB000",
            severity: "error",
            message: (error as Error).message,
            quality: "unsupported",
            remediation: "Correct the invocation, paths, or filesystem condition and retry.",
          },
        ],
      };
      process.stdout.write(
        jsonPayload(`agent ${command}`, result, opts, { ok: false, exitCode: 1 }),
      );
      terminate(1);
    }
    throw error;
  }
}

export function resolveTargets(values: string[] | undefined, required = false): AgentTarget[] {
  const raw = values ?? [];
  if (required && raw.length === 0) throw new Error("At least one --target is required");
  const expanded = raw.includes("all") ? [...TARGETS] : raw;
  const unknown = expanded.filter((value) => !TARGETS.includes(value as AgentTarget));
  if (unknown.length) throw new Error(`Unknown target(s): ${unknown.join(", ")}`);
  return [...new Set(expanded)] as AgentTarget[];
}

export function profiles(value: string | undefined): AgentProfile[] {
  if (!value || value === "both") return ["plugin", "project"];
  if (value === "plugin" || value === "project") return [value];
  throw new Error(`Unknown profile: ${value}`);
}

/**
 * Renders the profiles as a readable digest. The full structure is reserved for
 * `--format json`, which is the form a consumer should depend on.
 */
function formatSpecs(specs: SpecsPayload): string[] {
  const lines = [`profile schema version: ${specs.schemaVersion}`];
  for (const [id, profile] of Object.entries(specs.targets)) {
    lines.push(
      "",
      `${id} (${profile.host.displayName})`,
      `  documentation revision: ${profile.host.documentationRevision}`,
      `  verified host range: ${profile.host.minimumVersion ?? "unrecorded"} .. ${profile.host.verifiedThrough ?? "unrecorded"}`,
      `  profiles: ${profile.profiles.join(", ")}`,
      "  features:",
    );
    for (const key of FEATURE_KEYS) {
      const feature = profile.features[key];
      lines.push(
        `    ${key.padEnd(13)} ${feature.support.padEnd(12)} ${feature.summary}` +
          (feature.profiles.length < profile.profiles.length
            ? ` [${feature.profiles.join(", ")} only]`
            : ""),
      );
    }
  }
  return lines;
}

function formatDoctor(doctor: DoctorReport): string[] {
  const lines = ["hosts:"];
  for (const host of doctor.hosts)
    lines.push(
      `  ${host.target.padEnd(12)} ${host.status.padEnd(14)} installed: ${host.requested ?? "unknown"}` +
        `  verified: ${host.minimumVersion ?? "unrecorded"} .. ${host.verifiedThrough ?? "unrecorded"}` +
        `  profile: ${host.documentationRevision}`,
    );
  if (doctor.output) {
    const { root, missing, changed, unmanaged } = doctor.output;
    lines.push(
      "",
      `output: ${root}`,
      `  missing: ${missing.length}  changed: ${changed.length}  unmanaged: ${unmanaged.length}`,
    );
  }
  if (doctor.overlays.length) lines.push("", `overlay paths: ${doctor.overlays.length}`);
  if (doctor.undeclared.length)
    lines.push(
      "",
      `undeclared paths: ${doctor.undeclared.length}`,
      ...doctor.undeclared.map((item) => `  ${item.target}/${item.profile}/${item.path}`),
    );
  return lines;
}

/**
 * Renders the review surface. The findings themselves are the diagnostics, so
 * this reports what was inspected — which is what makes "no findings" mean
 * something.
 */
function formatAudit(audit: AuditReport): string[] {
  const { surface } = audit;
  const lines = [
    `checks: ${audit.checks.length}  errors: ${audit.counts.error}  warnings: ${audit.counts.warning}  notices: ${audit.counts.notice}`,
    `surface: ${surface.files} files (${surface.bytes} bytes), ${surface.executables} executable, ` +
      `${surface.binaries} binary, ${surface.symlinks} symlink`,
    `declared: hook commands ${surface.hooks}, MCP servers ${surface.mcpServers}, policy files ${surface.policies}`,
  ];
  if (audit.commands.length) {
    lines.push("", "commands:");
    for (const item of audit.commands)
      lines.push(
        `  ${item.origin}/${item.name}${item.target ? ` (${item.target})` : ""}: ${[item.command, ...(item.args ?? [])].join(" ")}`,
      );
  }
  if (audit.baseline) {
    const { compared, added, removed, changed, modeChanged } = audit.baseline;
    lines.push(
      "",
      `baseline: ${audit.baseline.path}`,
      `  compared: ${compared}  added: ${added.length}  removed: ${removed.length}  changed: ${changed.length}  mode: ${modeChanged.length}`,
    );
  }
  return [...lines, "", ...audit.limitations.map((item) => `note: ${item}`)];
}

/**
 * Renders the case results. The unmet expectations themselves are the
 * diagnostics, so this reports what ran — which is what makes "0 failed" mean
 * something rather than "nothing was asserted".
 */
function formatTest(report: TestReport): string[] {
  const { counts } = report;
  const lines = [
    `cases: ${counts.cases}  passed: ${counts.passed}  failed: ${counts.failed}  skipped: ${counts.skipped}  assertions: ${counts.assertions}`,
    `test files: ${report.files.length ? report.files.join(", ") : "none"}`,
  ];
  if (report.cases.length) {
    lines.push("", "cases:");
    for (const item of report.cases)
      lines.push(
        `  ${item.status.padEnd(7)} ${item.name}` +
          (item.targets.length ? ` [${item.targets.join(", ")}/${item.profiles.join(", ")}]` : "") +
          (item.reason ? ` (${item.reason})` : "") +
          `  ${item.assertions.passed}/${item.assertions.total} assertions`,
      );
  }
  return lines;
}

function formatInstall(report: InstallReport): string[] {
  if (!report.installs.length) return ["installs: none"];
  return [
    "installs:",
    ...report.installs.map((entry) => {
      const flags: string[] = [entry.layout, entry.mode, entry.scope];
      if (entry.registered) flags.push("registered");
      return `  ${entry.name}@${entry.version}  ${entry.target}/${entry.profile}  ${flags.join(" ")}  ${entry.destination}  ${entry.files} files`;
    }),
  ];
}

function formatMarketplace(report: MarketplaceReport): string[] {
  const lines = [`marketplace: ${report.name}@${report.version}`];
  for (const entry of report.targets) {
    lines.push(`  ${entry.target}: ${entry.catalog ?? "no catalog"}`);
    for (const plugin of entry.plugins)
      lines.push(`    ${plugin.name}@${plugin.version}  ${plugin.source}`);
    if (!entry.plugins.length) lines.push("    no plugins");
  }
  if (report.archives.length) lines.push(`  archives: ${report.archives.length}`);
  return lines;
}

function formatResult(result: AgentResult, opts: AgentOptions): string {
  const format = opts.format;
  // Keyed off the command so the message stays byte-identical for the
  // subcommands that accept only the base formats.
  if (format && !agentFormatsFor(result.command).includes(format as OutputFormat))
    throw new Error(`Invalid output format: ${format}`);
  if (format === "sarif") return formatAgentSarif(result.diagnostics, result.source);
  if (format === "json")
    return jsonPayload(`agent ${result.command}`, result, opts, {
      ok: result.ok,
      exitCode: result.ok ? 0 : 2,
    });
  const lines = [`${result.command}: ${result.ok ? "ok" : "findings"}`];
  if (result.source) lines.push(`source: ${result.source}`);
  if (result.targets.length) lines.push(`targets: ${result.targets.join(", ")}`);
  if (result.profiles) lines.push(`profiles: ${result.profiles.join(", ")}`);
  if (result.artifacts.length) lines.push(`artifacts: ${result.artifacts.length}`);
  if (result.dryRun) lines.push("dry run: no files written");
  if (result.check) lines.push(`check: ${result.stale ? "stale" : "current"}`);
  if (result.bundle) lines.push("", JSON.stringify(result.bundle, null, 2));
  if (result.compatibility) lines.push("", JSON.stringify(result.compatibility, null, 2));
  if (result.specs) lines.push("", ...formatSpecs(result.specs as SpecsPayload));
  if (result.doctor) lines.push("", ...formatDoctor(result.doctor));
  if (result.audit) lines.push("", ...formatAudit(result.audit));
  if (result.test) lines.push("", ...formatTest(result.test));
  if (result.install) lines.push("", ...formatInstall(result.install));
  if (result.marketplace) lines.push("", ...formatMarketplace(result.marketplace));
  if (result.diagnostics.length) {
    lines.push("", "diagnostics:");
    for (const item of result.diagnostics) {
      const location = [item.target, item.profile, item.component, item.path]
        .filter(Boolean)
        .join("/");
      lines.push(
        `- ${item.severity} ${item.code} [${item.quality}]${location ? ` ${location}:` : ":"} ${item.message}${item.remediation ? ` Remediation: ${item.remediation}` : ""}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function artifactInfo(artifacts: Artifact[]): AgentResult["artifacts"] {
  return artifacts.map((item) => ({
    path: item.path,
    bytes: item.content.length,
    mode: `0${item.mode.toString(8)}`,
    // Emitted only for overlay artifacts. Always emitting it would change
    // conversion-report.json bytes for every bundle that has no overlay.
    ...(item.origin === "native" ? { origin: item.origin } : {}),
  }));
}

function hasFindings(result: AgentResult, strict = false): boolean {
  return (
    result.stale === true ||
    result.diagnostics.some(
      (item) =>
        item.severity === "error" ||
        item.quality === "unsupported" ||
        item.quality === "approximate" ||
        (strict && item.severity === "warning"),
    )
  );
}

export function outputResult(result: AgentResult, opts: AgentOptions): void {
  result.ok = !hasFindings(result, Boolean(opts.strict));
  process.stdout.write(formatResult(result, opts));
  if (!result.ok) terminate(2);
}

/**
 * Writes a result whose `ok` has already been decided by the caller. `doctor`
 * needs this because {@link hasFindings} fails on any approximate mapping even
 * without `--strict`, which would make every codex bundle a doctor failure.
 */
export function outputDecidedResult(result: AgentResult, opts: AgentOptions): void {
  process.stdout.write(formatResult(result, opts));
  if (!result.ok) terminate(2);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveThroughExistingAncestors(candidate: string): string {
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing))
    existing = path.dirname(existing);
  return path.resolve(fs.realpathSync(existing), path.relative(existing, candidate));
}

function compareOutput(
  output: string,
  artifacts: Artifact[],
  targets: AgentTarget[],
  selectedProfiles: AgentProfile[],
): boolean {
  return outputMatches(diffOutput(output, artifacts, targets, selectedProfiles));
}

function writeAtomically(
  output: string,
  artifacts: Artifact[],
  targets: AgentTarget[],
  selectedProfiles: AgentProfile[],
  force: boolean,
): void {
  writeArtifactsAtomically(output, artifacts, {
    managedRoots: targets.flatMap((target) =>
      selectedProfiles.map((profile) => path.join(target, profile)),
    ),
    looseFiles: [CONVERSION_REPORT],
    force,
  });
}

/**
 * Writes the conversion report to an explicitly named path.
 *
 * Same document as `conversion-report.json`, provenance included, so a consumer
 * has one shape to learn. It differs in exactly two ways, both toward honesty:
 * `dryRun` and `check` carry their real values, because this describes a *run*
 * rather than the tree it sits beside, and `stale` is present, which the
 * in-tree artifact misses only because it is serialized before `--check` runs.
 *
 * It is never added to `artifacts`. Doing so would change
 * `conversion-report.json`'s own bytes — the report contains its artifact list,
 * and `diffOutput` compares that file by existence only, so the divergence
 * would be silent.
 */
function resolveReportPath(file: string, output: string, bundleRoot: string): string {
  const target = path.resolve(file);
  const resolved = resolveThroughExistingAncestors(target);
  if (isInside(fs.realpathSync(bundleRoot), resolved))
    throw new Error("--report must not be inside the source tree");
  // An unmanaged file under the output root is drift as far as `--check` and
  // `agent doctor --output` are concerned.
  if (isInside(resolveThroughExistingAncestors(output), resolved))
    throw new Error("--report must not be inside the output directory");
  if (fs.existsSync(target) && fs.statSync(target).isDirectory())
    throw new Error(`--report is a directory: ${target}`);
  return target;
}

function writeReportFile(target: string, report: AgentResult, targets: AgentTarget[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = JSON.stringify({ ...report, ...conversionProvenance(targets) }, null, 2) + "\n";
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o644 });
  fs.renameSync(temporary, target);
}

/** The bundle sections `agent inspect` reports, in feature-profile terms. */
const INSPECTED_FEATURES: FeatureKey[] = [
  "skills",
  "agents",
  "rules",
  "hooks",
  "policies",
  "mcp",
  "assets",
];

/** What `agent inspect --target`/`--profile` narrowed away. */
interface InspectFilter {
  targets: AgentTarget[];
  profiles: AgentProfile[];
  excluded: { skills: string[]; agents: string[]; rules: string[] };
  /** Sections no selected target and profile emits at all. */
  unsupported: FeatureKey[];
}

interface InspectSelection {
  targets: AgentTarget[];
  profiles: AgentProfile[];
}

/**
 * Whether any selected target emits a feature into any selected profile.
 *
 * Read from the target profiles rather than branched on the target name, so a
 * new target needs no change here.
 */
function featureVisible(feature: FeatureKey, selection: InspectSelection): boolean {
  return selection.targets.some((target) => {
    const profile = TARGET_PROFILES[target].features[feature];
    return (
      profile.support !== "unsupported" &&
      profile.profiles.some((value) => selection.profiles.includes(value))
    );
  });
}

function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function publicBundle(bundle: AgentBundle, selection?: InspectSelection): unknown {
  // A component is kept when it reaches *any* selected target: it is relevant
  // to the selection if it reaches part of it.
  const reaches = (component: MarkdownComponent): boolean =>
    !selection || selection.targets.some((target) => selected(component, target));
  const visible = (feature: FeatureKey): boolean =>
    !selection || featureVisible(feature, selection);

  const skills = bundle.skills.filter(reaches);
  const agents = bundle.agents.filter(reaches);
  const rules = bundle.rules.filter(reaches);
  const kept = new Set([...skills, ...agents].map((component) => component.name));
  const keptSkills = new Set(skills.map((skill) => skill.name));

  const filter: InspectFilter | undefined = selection
    ? {
        targets: selection.targets,
        profiles: selection.profiles,
        excluded: {
          skills: bundle.skills
            .filter((c) => !reaches(c))
            .map((c) => c.name)
            .sort(byBytes),
          agents: bundle.agents
            .filter((c) => !reaches(c))
            .map((c) => c.name)
            .sort(byBytes),
          rules: bundle.rules
            .filter((c) => !reaches(c))
            .map((c) => c.name)
            .sort(byBytes),
        },
        unsupported: INSPECTED_FEATURES.filter(
          (feature) => !featureVisible(feature, selection),
        ).sort(byBytes),
      }
    : undefined;

  return {
    schemaVersion: bundle.schemaVersion,
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
    legacy: bundle.legacy,
    components: {
      ...(visible("skills")
        ? {
            skills: skills.map(({ name, description, path: source, metadata }) => ({
              name,
              description,
              source,
              metadata,
            })),
          }
        : {}),
      ...(visible("agents")
        ? {
            agents: agents.map(({ name, description, path: source, metadata }) => ({
              name,
              description,
              source,
              metadata,
            })),
          }
        : {}),
      ...(visible("rules")
        ? {
            rules: rules.map(
              ({ name, description, path: source, activation, globs, metadata }) => ({
                name,
                description,
                source,
                activation,
                globs,
                metadata,
              }),
            ),
          }
        : {}),
      // Hooks are plugin-profile only on every target, so `--profile project`
      // drops the section rather than showing something that is never emitted.
      ...(visible("hooks")
        ? { hooks: bundle.hooks, hookFiles: bundle.hookFiles.map((file) => file.path) }
        : {}),
      ...(visible("policies") ? { policies: bundle.policies } : {}),
      ...(visible("mcp") ? { mcp: bundle.mcp } : {}),
      // Policies, assets, and hook files carry no per-target metadata, so a
      // target filter cannot narrow them further than the feature check does.
      ...(visible("assets") ? { assets: bundle.assets.map((asset) => asset.path) } : {}),
    },
    graph: selection
      ? Object.fromEntries(
          Object.entries(bundle.graph)
            .filter(([node]) => kept.has(node))
            .map(([node, refs]) => [node, refs.filter((ref) => keptSkills.has(ref))]),
        )
      : bundle.graph,
    targets: selection
      ? Object.fromEntries(
          Object.entries(bundle.manifest.targets ?? {}).filter(([name]) =>
            selection.targets.includes(name as AgentTarget),
          ),
        )
      : (bundle.manifest.targets ?? {}),
    // Omitted rather than null on a v1 bundle, so existing inspect output is
    // byte-identical for every bundle that predates schemaVersion 2.
    ...(bundle.marketplace ? { marketplace: bundle.marketplace } : {}),
    ...(filter ? { filter } : {}),
  };
}

/**
 * Records which generator and target profile revisions produced a tree, so a
 * later `agent doctor` can flag output that predates the current profiles.
 */
function conversionProvenance(targets: AgentTarget[]): ConversionProvenance {
  return {
    generator: { name: packageName, version: packageVersion },
    profileSchemaVersion: PROFILE_SCHEMA_VERSION,
    targetProfiles: Object.fromEntries(
      targets.map((target) => [
        target,
        { documentationRevision: TARGET_PROFILES[target].host.documentationRevision },
      ]),
    ),
  };
}

export async function agentConvertAction(source: string, opts: AgentOptions): Promise<void> {
  const targets = resolveTargets(opts.target, true);
  const selectedProfiles = profiles(opts.profile);
  if (!opts.output) throw new Error("--output is required");
  if (opts.check && opts.dryRun) throw new Error("--check and --dry-run cannot be used together");
  const bundle = loadBundle(source);
  const output = path.resolve(opts.output);
  if (isInside(fs.realpathSync(bundle.root), resolveThroughExistingAncestors(output)))
    throw new Error("Output directory must not be inside the source tree");
  // Resolved before anything is rendered or written, so an unusable --report
  // path fails the invocation rather than a run that already touched the tree.
  const reportPath = opts.report ? resolveReportPath(opts.report, output, bundle.root) : undefined;
  const rendered = renderBundle(bundle, targets, selectedProfiles);
  const report: AgentResult = {
    command: "convert",
    ok: true,
    source: bundle.root,
    targets,
    profiles: selectedProfiles,
    artifacts: artifactInfo(rendered.artifacts),
    diagnostics: rendered.diagnostics,
    dryRun: Boolean(opts.dryRun),
    check: Boolean(opts.check),
  };
  report.ok = !hasFindings(report, Boolean(opts.strict));
  const persistedReport = {
    ...report,
    dryRun: false,
    check: false,
    ...conversionProvenance(targets),
  };
  const reportArtifact: Artifact = {
    path: CONVERSION_REPORT,
    content: Buffer.from(JSON.stringify(persistedReport, null, 2) + "\n"),
    mode: 0o644,
  };
  const artifacts = [...rendered.artifacts, reportArtifact];
  report.artifacts = artifactInfo(artifacts);
  if (opts.check) report.stale = !compareOutput(output, artifacts, targets, selectedProfiles);
  else if (!opts.dryRun) {
    const hardValidation = report.diagnostics.some((item) => item.severity === "error");
    const strictFailure =
      Boolean(opts.strict) && report.diagnostics.some((item) => item.quality !== "exact");
    if (!hardValidation && !strictFailure)
      writeAtomically(output, artifacts, targets, selectedProfiles, Boolean(opts.force));
  }
  if (reportPath) {
    // Written in every mode, including --dry-run, --check, and a strict
    // failure. Those modes suppress *artifacts*; an explicitly named path is a
    // request for diagnostic output, and a failing run is when it matters most.
    // `ok` is recomputed first because `hasFindings` reads `stale`, which is
    // only known now.
    report.ok = !hasFindings(report, Boolean(opts.strict));
    writeReportFile(reportPath, report, targets);
  }
  outputResult(report, opts);
}

export async function agentValidateAction(source: string, opts: AgentOptions): Promise<void> {
  const targets = resolveTargets(opts.target);
  const bundle = loadBundle(source);
  const diagnostics = targets.length
    ? renderBundle(bundle, targets, ["plugin", "project"]).diagnostics
    : bundle.diagnostics;
  outputResult(
    { command: "validate", ok: true, source: bundle.root, targets, artifacts: [], diagnostics },
    opts,
  );
}

export async function agentInspectAction(source: string, opts: AgentOptions): Promise<void> {
  const targets = resolveTargets(opts.target);
  // Profile support is a property of a target, so a profile filter with no
  // target has no defined meaning. Refusing beats guessing.
  if (opts.profile && !targets.length) throw new Error("--profile requires --target");
  const selection: InspectSelection | undefined = targets.length
    ? { targets, profiles: profiles(opts.profile) }
    : undefined;
  const bundle = loadBundle(source);
  outputResult(
    {
      command: "inspect",
      ok: true,
      source: bundle.root,
      // Left empty without a filter, so unfiltered output is byte-identical.
      targets: selection ? selection.targets : [],
      ...(selection ? { profiles: selection.profiles } : {}),
      artifacts: [],
      diagnostics: bundle.diagnostics,
      bundle: publicBundle(bundle, selection),
    },
    opts,
  );
}

export async function agentCompatAction(
  source: string | undefined,
  opts: AgentOptions,
): Promise<void> {
  const selected = resolveTargets(opts.target);
  const targets = selected.length ? selected : [...TARGETS];
  const compatibility = compatibilityMatrix(targets);
  if (!source) {
    outputResult(
      { command: "compat", ok: true, targets, artifacts: [], diagnostics: [], compatibility },
      opts,
    );
    return;
  }
  const bundle = loadBundle(source);
  const rendered = renderBundle(bundle, targets, ["plugin", "project"]);
  outputResult(
    {
      command: "compat",
      ok: true,
      source: bundle.root,
      targets,
      artifacts: [],
      diagnostics: rendered.diagnostics,
      compatibility,
    },
    opts,
  );
}
