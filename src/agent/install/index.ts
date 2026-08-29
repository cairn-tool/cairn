import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentBundle,
  AgentDiagnostic,
  AgentProfile,
  AgentTarget,
  Artifact,
} from "../types.js";
import { diagnostic } from "../types.js";
import type { FeatureKey, InstallLayout, InstallLocation } from "../targets/index.js";
import { FEATURE_KEYS, profileFor } from "../targets/index.js";
import { isInside } from "../../config-schema.js";
import { renderBundle } from "../render.js";
import {
  buildCatalogs,
  checkAssets,
  checkCaseCollisions,
  checkExecutables,
  checkPinning,
} from "../package/index.js";
import { placeSymlink, writeArtifactsAtomically } from "../writer.js";
import { packageName, packageVersion } from "../../version.js";

export const INSTALL_MANIFEST = ".cairn-install.json";

/** The pre-rename manifest, still read so existing installs stay removable. */
export const LEGACY_INSTALL_MANIFEST = ".claude-cli-install.json";

/**
 * The manifest file in `destination`, preferring the current name.
 *
 * Only the paths this module reads off *disk* go through here. Comparisons
 * against `artifact.path` elsewhere in this file stay exact equality against
 * `INSTALL_MANIFEST` on purpose: those artifacts come from a plan this run just
 * built, which never emits the legacy name.
 */
export function installManifestIn(destination: string): string | undefined {
  for (const name of [INSTALL_MANIFEST, LEGACY_INSTALL_MANIFEST]) {
    const candidate = path.join(destination, name);
    if (existsAt(candidate)) return candidate;
  }
  return undefined;
}
export const INSTALL_CACHE = ".install";

export const INSTALL_SCOPES = ["user", "project"] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];
export type InstallMode = "copy" | "link";

export interface InstallEntry {
  name: string;
  version: string;
  target: AgentTarget;
  profile: AgentProfile;
  scope: InstallScope;
  layout: InstallLayout;
  mode: InstallMode;
  destination: string;
  registered: boolean;
  files: number;
}

export interface InstallReport {
  installs: InstallEntry[];
}

export interface InstallInventoryEntry {
  path: string;
  mode: string;
  sha256: string;
}

export interface InstallRegistration {
  file: string;
  marketplaceKey: string;
  pluginKey: string;
}

export interface InstallManifest {
  generator: { name: string; version: string };
  bundle: { name: string; version: string };
  target: AgentTarget;
  profile: AgentProfile;
  scope: InstallScope;
  layout: InstallLayout;
  mode: InstallMode;
  destination: string;
  files: InstallInventoryEntry[];
  materialized?: string;
  registration?: InstallRegistration;
}

export interface InstallContext {
  home?: string;
  cwd?: string;
}

export interface ResolvedInstall {
  location: InstallLocation;
  locationRoot: string;
  destination: string;
}

export interface InstallPlan {
  bundle: AgentBundle;
  target: AgentTarget;
  profile: AgentProfile;
  scope: InstallScope;
  layout: InstallLayout;
  mode: InstallMode;
  destination: string;
  artifacts: Artifact[];
  manifest: InstallManifest;
  diagnostics: AgentDiagnostic[];
  register: boolean;
  settings?: { file: string; marketplaceKey: string; pluginKey: string };
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function error(
  code: string,
  message: string,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  return { ...diagnostic(code, message, "unsupported", extra), severity: "error" };
}

function existsAt(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function isResolved(value: ResolvedInstall | AgentDiagnostic): value is ResolvedInstall {
  return "location" in value;
}

function toEntry(manifest: InstallManifest): InstallEntry {
  return {
    name: manifest.bundle.name,
    version: manifest.bundle.version,
    target: manifest.target,
    profile: manifest.profile,
    scope: manifest.scope,
    layout: manifest.layout,
    mode: manifest.mode,
    destination: manifest.destination,
    registered: Boolean(manifest.registration),
    files: manifest.files.length,
  };
}

export function resolveScope(value: string | undefined, fallback?: InstallScope): InstallScope {
  const scope = value ?? fallback;
  if (!scope) throw new Error("Unknown --scope. Use user or project.");
  if (scope !== "user" && scope !== "project")
    throw new Error(`Unknown --scope '${scope}'. Use user or project.`);
  return scope;
}

/**
 * Expands a profile install root. `~` is the caller's home, `.` is `cwd`, and
 * anything else is resolved against `cwd`.
 */
export function expandInstallRoot(root: string, context: InstallContext = {}): string {
  const home = context.home ?? os.homedir();
  const cwd = context.cwd ?? process.cwd();
  if (root === "~") return home;
  if (root.startsWith("~/")) return path.resolve(home, root.slice(2));
  if (root === ".") return path.resolve(cwd);
  return path.resolve(cwd, root);
}

export function locationFor(target: AgentTarget, scope: InstallScope): InstallLocation | null {
  return profileFor(target).install?.[scope] ?? null;
}

/**
 * True when `relative` would land outside `root`. Lexical: a `..` segment or an
 * absolute path is enough, matching the overlay boundary.
 */
export function pathEscapesRoot(root: string, relative: string): boolean {
  const normalized = relative.split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return true;
  if (normalized.includes("\\") || normalized.includes("\0")) return true;
  if (normalized.split("/").some((segment) => segment === ".." || segment === ".")) return true;
  const resolved = path.resolve(root, ...normalized.split("/"));
  return !isInside(path.resolve(root), resolved);
}

function relocate(artifacts: Artifact[], prefix: string): Artifact[] {
  const head = `${prefix}/`;
  return artifacts
    .filter((artifact) => artifact.path.startsWith(head))
    .map((artifact) => ({ ...artifact, path: artifact.path.slice(head.length) }))
    .sort(byPath);
}

function retargetCatalog(artifacts: Artifact[], entriesKey: string, source: string): Artifact[] {
  return artifacts.map((artifact) => {
    if (!artifact.path.endsWith("/marketplace.json") && artifact.path !== "marketplace.json")
      return artifact;
    const document = JSON.parse(artifact.content.toString()) as Record<string, unknown>;
    const entries = document[entriesKey];
    if (!Array.isArray(entries)) return artifact;
    const next = {
      ...document,
      [entriesKey]: entries.map((entry) =>
        entry && typeof entry === "object" ? { ...entry, source } : entry,
      ),
    };
    return { ...artifact, content: Buffer.from(JSON.stringify(next, null, 2) + "\n") };
  });
}

function bundleProvides(bundle: AgentBundle, key: FeatureKey): boolean {
  switch (key) {
    case "skills":
      return bundle.skills.length > 0;
    case "agents":
      return bundle.agents.length > 0;
    case "rules":
      return bundle.rules.length > 0;
    case "hooks":
      return Boolean(bundle.hooks) || bundle.hookFiles.length > 0;
    case "policies":
      return bundle.policies.length > 0;
    case "mcp":
      return Boolean(bundle.mcp);
    case "assets":
      return bundle.assets.length > 0;
    case "placeholders":
    case "native":
      return false;
  }
}

function featureDiagnostics(
  bundle: AgentBundle,
  target: AgentTarget,
  profile: AgentProfile,
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const features = profileFor(target).features;
  for (const key of FEATURE_KEYS) {
    if (!bundleProvides(bundle, key)) continue;
    if (features[key].profiles.includes(profile)) continue;
    diagnostics.push(
      diagnostic(
        "AB803",
        `Bundle feature '${key}' does not render in the ${profile} profile`,
        "unsupported",
        {
          target,
          profile,
          remediation: `Install a scope that uses a profile '${key}' reaches, or drop the component.`,
        },
      ),
    );
  }
  return diagnostics;
}

function inventoryOf(artifacts: Artifact[]): InstallInventoryEntry[] {
  return artifacts
    .filter((artifact) => artifact.path !== INSTALL_MANIFEST)
    .map((artifact) => ({
      path: artifact.path,
      mode: octal(artifact.mode),
      sha256: sha256(artifact.content),
    }))
    .sort(byPath);
}

function parseManifest(value: unknown): InstallManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const generator = doc.generator as Record<string, unknown> | undefined;
  const bundle = doc.bundle as Record<string, unknown> | undefined;
  const files = doc.files;
  if (
    !generator ||
    typeof generator.name !== "string" ||
    typeof generator.version !== "string" ||
    !bundle ||
    typeof bundle.name !== "string" ||
    typeof bundle.version !== "string" ||
    typeof doc.target !== "string" ||
    typeof doc.profile !== "string" ||
    typeof doc.scope !== "string" ||
    typeof doc.layout !== "string" ||
    typeof doc.mode !== "string" ||
    typeof doc.destination !== "string" ||
    !Array.isArray(files)
  )
    return null;
  const inventory: InstallInventoryEntry[] = [];
  for (const entry of files) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.path !== "string" ||
      typeof row.mode !== "string" ||
      typeof row.sha256 !== "string"
    )
      return null;
    inventory.push({ path: row.path, mode: row.mode, sha256: row.sha256 });
  }
  const registration = doc.registration as Record<string, unknown> | undefined;
  const parsedRegistration =
    registration &&
    typeof registration.file === "string" &&
    typeof registration.marketplaceKey === "string" &&
    typeof registration.pluginKey === "string"
      ? {
          file: registration.file,
          marketplaceKey: registration.marketplaceKey,
          pluginKey: registration.pluginKey,
        }
      : undefined;
  return {
    generator: { name: generator.name, version: generator.version },
    bundle: { name: bundle.name, version: bundle.version },
    target: doc.target as AgentTarget,
    profile: doc.profile as AgentProfile,
    scope: doc.scope as InstallScope,
    layout: doc.layout as InstallLayout,
    mode: doc.mode as InstallMode,
    destination: doc.destination,
    files: inventory,
    ...(typeof doc.materialized === "string" ? { materialized: doc.materialized } : {}),
    ...(parsedRegistration ? { registration: parsedRegistration } : {}),
  };
}

export function readInstallManifest(
  destination: string,
): InstallManifest | "missing" | "malformed" {
  // Two manifests in one destination is the "two matches is an error rather than
  // a guess" rule again: only a hand edit produces it, and picking one would
  // silently orphan the other install's file list.
  if (
    existsAt(path.join(destination, INSTALL_MANIFEST)) &&
    existsAt(path.join(destination, LEGACY_INSTALL_MANIFEST))
  )
    return "malformed";
  const file = installManifestIn(destination);
  if (!file) return "missing";
  try {
    const parsed = parseManifest(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed ?? "malformed";
  } catch {
    return "malformed";
  }
}

export function resolveInstallDestination(
  target: AgentTarget,
  scope: InstallScope,
  name: string,
  options: { into?: string } & InstallContext = {},
): ResolvedInstall | AgentDiagnostic {
  const location = locationFor(target, scope);
  if (!location)
    return error("AB800", `No recorded install location for ${target} ${scope} scope`, {
      target,
      remediation:
        scope === "user" && target === "codex"
          ? "Codex has no user-scope install; use --scope project, or pick another target."
          : "Use a target and scope the profile declares, or pass --into only after one exists.",
    });
  const locationRoot = options.into
    ? path.resolve(options.into)
    : expandInstallRoot(location.root, options);
  const destination = location.layout === "merge" ? locationRoot : path.join(locationRoot, name);
  return { location, locationRoot, destination };
}

function occupied(
  destination: string,
  layout: InstallLayout,
  artifacts: Artifact[],
  prior: InstallManifest | "missing" | "malformed",
  bundleName: string,
): boolean {
  if (layout === "merge") {
    if (prior !== "missing" && prior !== "malformed" && prior.bundle.name !== bundleName)
      return true;
    const owned =
      prior !== "missing" && prior !== "malformed" && prior.bundle.name === bundleName
        ? new Set(prior.files.map((file) => file.path))
        : new Set<string>();
    return artifacts.some((artifact) => {
      if (artifact.path === INSTALL_MANIFEST) return false;
      if (owned.has(artifact.path)) return false;
      return existsAt(path.join(destination, artifact.path));
    });
  }
  if (!existsAt(destination)) return false;
  if (prior !== "missing" && prior !== "malformed" && prior.bundle.name === bundleName)
    return false;
  const listing = fs.lstatSync(destination);
  if (listing.isDirectory() && fs.readdirSync(destination).length === 0) return false;
  return true;
}

function writeJsonAtomically(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(temporary, file);
}

function readJsonObject(file: string): Record<string, unknown> {
  if (!existsAt(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Activation file is not a JSON object: ${file}`);
  return parsed as Record<string, unknown>;
}

function applyRegistration(
  settings: NonNullable<InstallPlan["settings"]>,
  destination: string,
): void {
  const current = readJsonObject(settings.file);
  const extra = {
    ...((current.extraKnownMarketplaces as Record<string, unknown> | undefined) ?? {}),
  };
  extra[settings.marketplaceKey] = {
    source: { source: "directory", path: destination },
  };
  const enabled = {
    ...((current.enabledPlugins as Record<string, unknown> | undefined) ?? {}),
  };
  enabled[settings.pluginKey] = true;
  writeJsonAtomically(settings.file, {
    ...current,
    extraKnownMarketplaces: extra,
    enabledPlugins: enabled,
  });
}

function revertRegistration(registration: InstallRegistration, destination: string): void {
  if (!existsAt(registration.file)) return;
  const current = readJsonObject(registration.file);
  const extra = {
    ...((current.extraKnownMarketplaces as Record<string, unknown> | undefined) ?? {}),
  };
  const listed = extra[registration.marketplaceKey] as { source?: { path?: unknown } } | undefined;
  if (listed?.source?.path === destination) delete extra[registration.marketplaceKey];
  const enabled = {
    ...((current.enabledPlugins as Record<string, unknown> | undefined) ?? {}),
  };
  delete enabled[registration.pluginKey];
  writeJsonAtomically(registration.file, {
    ...current,
    extraKnownMarketplaces: extra,
    enabledPlugins: enabled,
  });
}

function registrationCurrent(
  settings: NonNullable<InstallPlan["settings"]>,
  destination: string,
): boolean {
  if (!existsAt(settings.file)) return false;
  try {
    const current = readJsonObject(settings.file);
    const extra = current.extraKnownMarketplaces as
      Record<string, { source?: { path?: unknown } }> | undefined;
    const enabled = current.enabledPlugins as Record<string, unknown> | undefined;
    return (
      extra?.[settings.marketplaceKey]?.source?.path === destination &&
      enabled?.[settings.pluginKey] === true
    );
  } catch {
    return false;
  }
}

function pruneEmptyAncestors(root: string, relative: string): void {
  let current = path.dirname(path.join(root, relative));
  const stop = path.resolve(root);
  while (current !== stop && isInside(stop, current)) {
    if (!existsAt(current) || !fs.statSync(current).isDirectory()) break;
    if (fs.readdirSync(current).length) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function payloadMatches(destination: string, artifacts: Artifact[]): boolean {
  for (const artifact of artifacts) {
    if (artifact.path === INSTALL_MANIFEST) {
      if (!existsAt(path.join(destination, artifact.path))) return false;
      continue;
    }
    const file = path.join(destination, artifact.path);
    if (!existsAt(file)) return false;
    if (!fs.readFileSync(file).equals(artifact.content)) return false;
  }
  return true;
}

export function installIsCurrent(plan: InstallPlan): boolean {
  if (!payloadMatches(plan.destination, plan.artifacts)) return false;
  if (plan.register && plan.settings && !registrationCurrent(plan.settings, plan.destination))
    return false;
  return true;
}

function buildPayload(
  bundle: AgentBundle,
  target: AgentTarget,
  profile: AgentProfile,
  layout: InstallLayout,
): { artifacts: Artifact[]; diagnostics: AgentDiagnostic[] } {
  const rendered = renderBundle(bundle, [target], [profile]);
  const prefix = `${target}/${profile}`;
  const diagnostics = [...rendered.diagnostics];
  let artifacts = relocate(rendered.artifacts, prefix);
  if (layout === "marketplace") {
    const catalogs = buildCatalogs(bundle, [target], [profile], "local");
    diagnostics.push(...catalogs.diagnostics);
    const relocated = retargetCatalog(
      relocate(catalogs.artifacts, prefix),
      profileFor(target).marketplace?.entriesKey ?? "plugins",
      "./",
    );
    artifacts = [...artifacts, ...relocated].sort(byPath);
    diagnostics.push(...checkAssets(bundle, [target], artifacts));
  }
  diagnostics.push(
    ...checkExecutables(artifacts),
    ...checkCaseCollisions(artifacts),
    ...checkPinning(bundle),
    ...featureDiagnostics(bundle, target, profile),
  );
  return { artifacts, diagnostics };
}

function manifestArtifact(manifest: InstallManifest): Artifact {
  return {
    path: INSTALL_MANIFEST,
    content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    mode: 0o644,
  };
}

/**
 * Plans an install: renders and packages in memory, resolves the destination
 * from profile data, and records AB8xx findings. Nothing is written.
 */
export function planInstall(
  bundle: AgentBundle,
  target: AgentTarget,
  options: {
    scope?: string;
    into?: string;
    profile?: string;
    link?: boolean;
    register?: boolean;
    force?: boolean;
  } & InstallContext,
): InstallPlan {
  const scope = resolveScope(options.scope, "user");
  const resolved = resolveInstallDestination(target, scope, bundle.name, options);
  const diagnostics: AgentDiagnostic[] = [];
  if (!isResolved(resolved)) {
    return {
      bundle,
      target,
      profile: "plugin",
      scope,
      layout: "plugin-dir",
      mode: options.link ? "link" : "copy",
      destination: "",
      artifacts: [],
      manifest: {
        generator: { name: packageName, version: packageVersion },
        bundle: { name: bundle.name, version: bundle.version },
        target,
        profile: "plugin",
        scope,
        layout: "plugin-dir",
        mode: "copy",
        destination: "",
        files: [],
      },
      diagnostics: [resolved],
      register: Boolean(options.register),
    };
  }

  const { location, destination } = resolved;
  if (options.profile && options.profile !== "both" && options.profile !== location.profile)
    throw new Error(`Install location for ${target}/${scope} uses the ${location.profile} profile`);
  if (options.profile === "both")
    throw new Error(
      "Install uses one profile per destination; pass plugin or project, or omit --profile",
    );

  const mode: InstallMode = options.link ? "link" : "copy";
  const built = buildPayload(bundle, target, location.profile, location.layout);
  diagnostics.push(...built.diagnostics);

  for (const artifact of built.artifacts)
    if (pathEscapesRoot(destination, artifact.path))
      diagnostics.push(
        error("AB804", `Destination path escapes the install root: ${artifact.path}`, {
          path: artifact.path,
          target,
          profile: location.profile,
        }),
      );

  const prior = existsAt(destination) ? readInstallManifest(destination) : "missing";
  if (occupied(destination, location.layout, built.artifacts, prior, bundle.name)) {
    if (!options.force)
      diagnostics.push(
        error(
          "AB801",
          `Destination is occupied by something that is not a prior install of '${bundle.name}'`,
          {
            path: destination,
            target,
            remediation: "Pass --force to replace it, or uninstall the occupant first.",
          },
        ),
      );
  } else if (prior !== "missing" && prior !== "malformed" && prior.bundle.name === bundle.name)
    diagnostics.push(
      diagnostic(
        "AB802",
        `Replacing existing install of ${prior.bundle.name} ${prior.bundle.version} with ${bundle.version}`,
        "exact",
        { target, profile: location.profile, path: destination },
      ),
    );

  const settingsFile = location.activation
    ? expandInstallRoot(location.activation.file, options)
    : undefined;
  const settings =
    location.layout === "marketplace" && settingsFile
      ? {
          file: settingsFile,
          marketplaceKey: bundle.name,
          pluginKey: `${bundle.name}@${bundle.name}`,
        }
      : undefined;
  const register = Boolean(options.register) && Boolean(settings);
  if (settings && !options.register)
    diagnostics.push(
      diagnostic(
        "AB805",
        `Host activation edit required but --register was not given. Add extraKnownMarketplaces.${bundle.name} (directory ${destination}) and enabledPlugins["${bundle.name}@${bundle.name}"] to ${settingsFile}.`,
        "unsupported",
        {
          target,
          path: settingsFile,
          remediation: "Re-run with --register, or apply the edit yourself.",
        },
      ),
    );
  if (mode === "link")
    diagnostics.push(
      diagnostic(
        "AB807",
        "--link is in use; edits to the materialized tree are live and the host may not follow symlinks",
        "exact",
        { target, profile: location.profile, path: destination },
      ),
    );

  const materialized =
    mode === "link" ? path.join(bundle.root, INSTALL_CACHE, target, location.profile) : undefined;
  const manifest: InstallManifest = {
    generator: { name: packageName, version: packageVersion },
    bundle: { name: bundle.name, version: bundle.version },
    target,
    profile: location.profile,
    scope,
    layout: location.layout,
    mode,
    destination,
    files: inventoryOf(built.artifacts),
    ...(materialized ? { materialized } : {}),
    ...(register && settings ? { registration: settings } : {}),
  };
  const artifacts = [...built.artifacts, manifestArtifact(manifest)].sort(byPath);
  return {
    bundle,
    target,
    profile: location.profile,
    scope,
    layout: location.layout,
    mode,
    destination,
    artifacts,
    manifest,
    diagnostics,
    register,
    settings,
  };
}

function writeCopy(plan: InstallPlan): void {
  const payload = plan.artifacts;
  if (plan.layout === "merge")
    writeArtifactsAtomically(plan.destination, payload, {
      managedRoots: [],
      looseFiles: payload.map((artifact) => artifact.path),
      force: true,
    });
  else writeArtifactsAtomically(plan.destination, payload, { managedRoots: ["."], force: true });
}

function writeLink(plan: InstallPlan): void {
  const materialized = plan.manifest.materialized;
  if (!materialized) throw new Error("Link install is missing a materialized tree");
  writeArtifactsAtomically(materialized, plan.artifacts, { managedRoots: ["."], force: true });
  if (plan.layout === "merge") {
    for (const artifact of plan.artifacts) {
      if (artifact.path === INSTALL_MANIFEST) continue;
      placeSymlink(
        path.join(plan.destination, artifact.path),
        path.join(materialized, artifact.path),
      );
    }
    const manifest = plan.artifacts.find((artifact) => artifact.path === INSTALL_MANIFEST);
    if (manifest)
      writeArtifactsAtomically(plan.destination, [manifest], {
        managedRoots: [],
        looseFiles: [INSTALL_MANIFEST],
        force: true,
      });
  } else placeSymlink(plan.destination, materialized);
}

function retirePrior(plan: InstallPlan): void {
  if (!existsAt(plan.destination)) return;
  const prior = readInstallManifest(plan.destination);
  if (prior === "missing" || prior === "malformed") return;
  const next = new Set(plan.manifest.files.map((file) => file.path));
  if (prior.bundle.name !== plan.manifest.bundle.name) {
    commitUninstall({
      name: prior.bundle.name,
      target: prior.target,
      destination: plan.destination,
      manifest: prior,
      diagnostics: [],
      missing: false,
    });
    return;
  }
  for (const file of prior.files) {
    if (next.has(file.path)) continue;
    removePath(path.join(plan.destination, file.path));
    pruneEmptyAncestors(plan.destination, file.path);
  }
  if (prior.materialized && prior.materialized !== plan.manifest.materialized)
    removePath(prior.materialized);
  if (prior.registration && !plan.manifest.registration)
    revertRegistration(prior.registration, plan.destination);
}

/** Writes a planned install. Caller must have already decided the run is not blocked. */
export function commitInstall(plan: InstallPlan): void {
  retirePrior(plan);
  if (plan.mode === "link") writeLink(plan);
  else writeCopy(plan);
  if (plan.register && plan.settings) applyRegistration(plan.settings, plan.destination);
}

export function planToEntry(plan: InstallPlan): InstallEntry {
  return toEntry(plan.manifest);
}

export interface UninstallPlan {
  name: string;
  target: AgentTarget;
  destination: string;
  manifest: InstallManifest | null;
  diagnostics: AgentDiagnostic[];
  missing: boolean;
}

function candidatesFor(
  target: AgentTarget,
  name: string,
  scopes: InstallScope[],
  options: { into?: string } & InstallContext,
): Array<{ scope: InstallScope; destination: string }> {
  const found: Array<{ scope: InstallScope; destination: string }> = [];
  for (const scope of scopes) {
    const resolved = resolveInstallDestination(target, scope, name, options);
    if (!isResolved(resolved)) continue;
    found.push({ scope, destination: resolved.destination });
  }
  return found;
}

/**
 * Locates a named install. `--scope` is optional: when omitted, both scopes
 * are searched and two matches is an error rather than a guess.
 */
export function planUninstall(
  name: string,
  target: AgentTarget,
  options: { scope?: string; into?: string } & InstallContext,
): UninstallPlan {
  const scopes: InstallScope[] = options.scope
    ? [resolveScope(options.scope)]
    : [...INSTALL_SCOPES];
  const diagnostics: AgentDiagnostic[] = [];
  const matches: Array<{ scope: InstallScope; destination: string; manifest: InstallManifest }> =
    [];
  for (const candidate of candidatesFor(target, name, scopes, options)) {
    const read = existsAt(candidate.destination)
      ? readInstallManifest(candidate.destination)
      : "missing";
    if (read === "malformed")
      diagnostics.push(
        error("AB806", `Install manifest missing or malformed at ${candidate.destination}`, {
          path:
            installManifestIn(candidate.destination) ??
            path.join(candidate.destination, INSTALL_MANIFEST),
          target,
          remediation: "Inspect the destination; uninstall refuses to guess.",
        }),
      );
    else if (read !== "missing" && read.bundle.name === name)
      matches.push({ ...candidate, manifest: read });
  }
  if (diagnostics.length)
    return { name, target, destination: "", manifest: null, diagnostics, missing: false };
  if (matches.length > 1)
    throw new Error(
      `Install '${name}' exists in more than one scope for ${target}; pass --scope user or --scope project.`,
    );
  if (!matches.length) {
    if (scopes.length === 1) {
      const resolved = resolveInstallDestination(target, scopes[0], name, options);
      if (!isResolved(resolved))
        return {
          name,
          target,
          destination: "",
          manifest: null,
          diagnostics: [resolved],
          missing: false,
        };
      return {
        name,
        target,
        destination: resolved.destination,
        manifest: null,
        diagnostics: [],
        missing: true,
      };
    }
    return {
      name,
      target,
      destination: "",
      manifest: null,
      diagnostics: [],
      missing: true,
    };
  }
  return {
    name,
    target,
    destination: matches[0].destination,
    manifest: matches[0].manifest,
    diagnostics: [],
    missing: false,
  };
}

export function missingInstallDiagnostic(
  name: string,
  target: AgentTarget,
  destination: string,
): AgentDiagnostic {
  return error(
    "AB806",
    destination
      ? `Install manifest missing or malformed at ${destination}`
      : `No install named '${name}' for ${target}`,
    {
      ...(destination
        ? { path: installManifestIn(destination) ?? path.join(destination, INSTALL_MANIFEST) }
        : {}),
      target,
      remediation: "Nothing to uninstall, or the destination is not a Cairn install.",
    },
  );
}

function removePath(file: string): void {
  if (existsAt(file)) fs.rmSync(file, { recursive: true, force: true });
}

export function commitUninstall(plan: UninstallPlan): void {
  const manifest = plan.manifest;
  if (!manifest) return;
  const destination = plan.destination;
  const listing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (listing?.isSymbolicLink()) removePath(destination);
  else {
    for (const file of manifest.files) {
      removePath(path.join(destination, file.path));
      pruneEmptyAncestors(destination, file.path);
    }
    const manifestFile = installManifestIn(destination);
    if (manifestFile) removePath(manifestFile);
    if (
      manifest.layout !== "merge" &&
      existsAt(destination) &&
      fs.statSync(destination).isDirectory() &&
      fs.readdirSync(destination).length === 0
    )
      fs.rmdirSync(destination);
  }
  if (manifest.materialized) removePath(manifest.materialized);
  if (manifest.registration) revertRegistration(manifest.registration, destination);
}

function scanRoot(
  target: AgentTarget,
  scope: InstallScope,
  location: InstallLocation,
  locationRoot: string,
): InstallEntry[] {
  const entries: InstallEntry[] = [];
  if (location.layout === "merge") {
    const read = existsAt(locationRoot) ? readInstallManifest(locationRoot) : "missing";
    if (
      read !== "missing" &&
      read !== "malformed" &&
      read.target === target &&
      read.scope === scope
    )
      entries.push(toEntry({ ...read, destination: locationRoot }));
    return entries;
  }
  if (!existsAt(locationRoot) || !fs.statSync(locationRoot).isDirectory()) return entries;
  for (const name of fs.readdirSync(locationRoot).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const destination = path.join(locationRoot, name);
    const listing = fs.lstatSync(destination);
    if (!listing.isDirectory() && !listing.isSymbolicLink()) continue;
    const read = readInstallManifest(destination);
    if (read === "missing" || read === "malformed") continue;
    if (read.target !== target || read.scope !== scope) continue;
    entries.push(toEntry({ ...read, destination }));
  }
  return entries;
}

/** Lists installs found at the roots the target profiles declare. */
export function listInstalled(
  targets: AgentTarget[],
  options: { scope?: string; into?: string } & InstallContext = {},
): InstallEntry[] {
  const scopes: InstallScope[] = options.scope
    ? [resolveScope(options.scope)]
    : [...INSTALL_SCOPES];
  const entries: InstallEntry[] = [];
  for (const target of targets) {
    for (const scope of scopes) {
      const location = locationFor(target, scope);
      if (!location) continue;
      const locationRoot = options.into
        ? path.resolve(options.into)
        : expandInstallRoot(location.root, options);
      entries.push(...scanRoot(target, scope, location, locationRoot));
    }
  }
  return entries.sort((a, b) => {
    const left = `${a.target}/${a.scope}/${a.name}`;
    const right = `${b.target}/${b.scope}/${b.name}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
