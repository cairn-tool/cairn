import fs from "node:fs";
import path from "node:path";
import type {
  AgentPlan,
  AgentResult,
  AgentTarget,
  Artifact,
  PlanOperation,
} from "../agent/types.js";
import { TARGETS, diagnostic } from "../agent/types.js";
import type { AgentDiagnostic } from "../agent/types.js";
import type { ComponentKind, ComponentScaffoldSpec } from "../agent/scaffold.js";
import {
  COMPONENT_KINDS,
  DEFAULT_ROOTS,
  applyManifestEdits,
  scaffoldBundle,
  scaffoldComponent,
  sortArtifacts,
} from "../agent/scaffold.js";
import { PORTABLE_HOOK_EVENTS } from "../agent/targets/schema.js";
import { writeArtifactsAtomically } from "../agent/writer.js";
import type { AgentOptions } from "./agent.js";
import { outputDecidedResult, profiles, resolveTargets } from "./agent.js";

export interface AgentInitOptions extends AgentOptions {
  description?: string;
  bundleVersion?: string;
  license?: string;
  component?: string[];
  overlays?: boolean;
}

export interface AgentAddOptions extends AgentOptions {
  description?: string;
  path?: string;
  activation?: string;
  glob?: string[];
  command?: string;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function error(code: string, message: string, remediation?: string): AgentDiagnostic {
  return {
    ...diagnostic(code, message, "unsupported", remediation ? { remediation } : {}),
    severity: "error",
  };
}

function requireName(value: string, label: string): void {
  if (!NAME.test(value))
    throw new Error(`Invalid ${label} '${value}': use lowercase kebab-case, e.g. my-${label}`);
}

/**
 * Compares planned artifacts against what is already on disk.
 *
 * `create` and `update` are both writes; the distinction exists so `--check`
 * and a JSON plan can say which files already matched.
 */
function planFor(root: string, artifacts: Artifact[], kind: (path: string) => string): AgentPlan {
  const operations: PlanOperation[] = artifacts.map((artifact) => {
    const destination = path.join(root, artifact.path);
    const exists = fs.existsSync(destination) && fs.statSync(destination).isFile();
    const identical = exists && fs.readFileSync(destination).equals(artifact.content);
    return {
      action: identical ? "skip" : exists ? "update" : "create",
      path: artifact.path,
      kind: kind(artifact.path),
      bytes: artifact.content.length,
      mode: `0${artifact.mode.toString(8)}`,
      ...(identical ? { reason: "already matches the scaffold" } : {}),
    };
  });
  return { root, operations };
}

function willChange(plan: AgentPlan): boolean {
  return plan.operations.some((operation) => operation.action !== "skip");
}

function kindOf(relative: string): string {
  if (relative === "agent-bundle.yaml") return "manifest";
  const root = relative.split("/")[0];
  const match = COMPONENT_KINDS.find((kind) => DEFAULT_ROOTS[kind] === root);
  return match ?? "asset";
}

/** Shared tail: emit the plan, write unless read-only, and decide the exit status. */
function finish(
  command: AgentResult["command"],
  root: string,
  artifacts: Artifact[],
  plan: AgentPlan,
  diagnostics: AgentDiagnostic[],
  opts: AgentOptions,
  managed: { managedRoots: string[]; looseFiles?: string[] },
): void {
  const readOnly = Boolean(opts.dryRun) || Boolean(opts.check);
  const stale = willChange(plan);
  const blocked = diagnostics.some((item) => item.severity === "error");
  if (!readOnly && !blocked) writeArtifactsAtomically(root, artifacts, { ...managed, force: true });
  const result: AgentResult = {
    command,
    // `--check` reports drift, so a plan that would change something fails it.
    // Without `--check` a pending change is the normal case, not a finding.
    ok: !blocked && !(opts.check && stale),
    source: root,
    targets: [],
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      bytes: artifact.content.length,
      mode: `0${artifact.mode.toString(8)}`,
    })),
    diagnostics,
    plan,
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.check ? { check: true, stale } : {}),
  };
  outputDecidedResult(result, opts);
}

export async function agentInitAction(name: string, opts: AgentInitOptions): Promise<void> {
  requireName(name, "bundle name");
  if (opts.check && opts.dryRun) throw new Error("--check and --dry-run cannot be used together");
  const output = path.resolve(opts.output ?? `./${name}`);
  const components = parseComponents(opts.component);
  const selected = resolveTargets(opts.target);
  const targets: AgentTarget[] = selected.length ? selected : [...TARGETS];
  // `--profile` is accepted for symmetry with the other agent commands and is
  // validated here even though a scaffold has no per-profile content yet.
  profiles(opts.profile);

  const diagnostics: AgentDiagnostic[] = [];
  if (!opts.dryRun && !opts.check && nonempty(output) && !opts.force)
    diagnostics.push(
      error(
        "AB200",
        `Destination is nonempty: ${output}`,
        "Pass --force to scaffold into it anyway.",
      ),
    );

  const { artifacts } = scaffoldBundle({
    name,
    version: opts.bundleVersion ?? "0.1.0",
    description: opts.description ?? `${name} agent bundle`,
    license: opts.license ?? "MIT",
    components,
    targets,
    overlays: Boolean(opts.overlays),
  });
  const plan = planFor(output, artifacts, kindOf);
  // `init` creates the bundle, so it owns the whole root — with --force that
  // means replacing whatever was there, the same meaning --force has elsewhere.
  finish("init", output, artifacts, plan, diagnostics, opts, { managedRoots: ["."] });
}

function parseComponents(values: string[] | undefined): ComponentKind[] {
  const raw = values ?? [];
  if (!raw.length) return ["skill"];
  if (raw.includes("none")) return [];
  const unknown = raw.filter((value) => !COMPONENT_KINDS.includes(value as ComponentKind));
  if (unknown.length)
    throw new Error(
      `Unknown component kind(s): ${unknown.join(", ")}. Use one of: ${COMPONENT_KINDS.join(", ")}, none.`,
    );
  return [...new Set(raw)] as ComponentKind[];
}

function nonempty(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  return !fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length > 0;
}

export async function agentAddAction(
  kind: string,
  name: string,
  source: string | undefined,
  opts: AgentAddOptions,
): Promise<void> {
  if (!COMPONENT_KINDS.includes(kind as ComponentKind))
    throw new Error(`Unknown component kind '${kind}'. Use one of: ${COMPONENT_KINDS.join(", ")}.`);
  if (opts.check && opts.dryRun) throw new Error("--check and --dry-run cannot be used together");
  const componentKind = kind as ComponentKind;
  const root = path.resolve(source ?? ".");
  const manifestPath = path.join(root, "agent-bundle.yaml");
  if (!fs.existsSync(manifestPath))
    throw new Error(`No agent-bundle.yaml found in ${root}. Run 'cairn agent init' first.`);

  const diagnostics: AgentDiagnostic[] = [];
  // A hook is named by its event, not freely, so it is validated against the
  // portable event list rather than the kebab-case component rule.
  if (componentKind === "hook") {
    if (!(PORTABLE_HOOK_EVENTS as readonly string[]).includes(name))
      diagnostics.push(
        error(
          "AB202",
          `'${name}' is not a portable hook event`,
          `Use one of: ${PORTABLE_HOOK_EVENTS.join(", ")}.`,
        ),
      );
  } else requireName(name, "component name");

  const overlayTarget = resolveTargets(opts.target);
  if (componentKind === "overlay" && overlayTarget.length !== 1)
    throw new Error("agent add overlay requires exactly one --target");

  const spec: ComponentScaffoldSpec = {
    kind: componentKind,
    name,
    description: opts.description ?? `${name} ${componentKind}`,
    root: opts.path,
    activation: opts.activation ?? "always",
    globs: opts.glob ?? [],
    command: opts.command,
    target: overlayTarget[0],
    profile: opts.profile === "project" ? "project" : "plugin",
  };
  const { artifacts, edits } = scaffoldComponent(spec);

  for (const artifact of artifacts) {
    const destination = path.join(root, artifact.path);
    if (fs.existsSync(destination) && !opts.force && !opts.dryRun && !opts.check)
      diagnostics.push(
        error(
          "AB201",
          `Component already exists: ${artifact.path}`,
          "Pass --force to replace it, or choose another name.",
        ),
      );
  }

  const planned = [...artifacts];
  if (edits.length) {
    const applied = applyManifestEdits(fs.readFileSync(manifestPath, "utf8"), edits);
    if (applied.changed) {
      planned.push({ path: "agent-bundle.yaml", content: applied.content, mode: 0o644 });
      if (applied.reformatted)
        diagnostics.push(
          diagnostic(
            "AB203",
            "agent-bundle.yaml will be reformatted by the manifest edit",
            "exact",
            {
              path: manifestPath,
              remediation: "Incidental whitespace is normalized; comments and key order are kept.",
            },
          ),
        );
    }
  }

  const sorted = sortArtifacts(planned);
  const plan = planFor(root, sorted, kindOf);
  // `agent add` writes into an existing bundle, so it owns individual files
  // rather than any directory — a managed root would delete their siblings.
  finish("add", root, sorted, plan, diagnostics, opts, {
    managedRoots: [],
    looseFiles: sorted.map((artifact) => artifact.path),
  });
}
