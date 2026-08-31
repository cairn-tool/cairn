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
  /** The single plugin key a bundle install enables. */
  pluginKey?: string;
  /**
   * Every plugin key a collection install enables. A collection registers one
   * marketplace offering many plugins, so it has no single primary key.
   */
  pluginKeys?: string[];
}

/**
 * The plugin keys a registration activates, whichever spelling recorded them.
 * A manifest written before collections carries only `pluginKey`.
 */
export function registeredPluginKeys(registration: InstallRegistration): string[] {
  return registration.pluginKeys ?? (registration.pluginKey ? [registration.pluginKey] : []);
}

/**
 * One install recorded in a destination's manifest.
 *
 * A destination may hold several: every target declares the same project-scope
 * merge root, so a repository installing for two hosts, or two bundles, records
 * them side by side. {@link installKey} is what tells them apart.
 */
export interface InstallRecord {
  /**
   * What was installed here: a single bundle, or a collection of them. Absent
   * means `"bundle"`, so every manifest written before collections still parses.
   */
  kind?: "bundle" | "collection";
  /**
   * The installed unit's identity — a bundle's, or a collection's. Uninstall,
   * the occupied-destination check, and `agent installed` all key off this, so
   * a collection reuses it rather than adding a parallel field they would have
   * to learn about.
   */
  bundle: { name: string; version: string };
  /** The plugins a collection install placed. Absent for a single bundle. */
  collection?: { plugins: Array<{ name: string; version: string }> };
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

/**
 * The `.cairn-install.json` document: which build wrote it, and every install
 * it accounts for.
 *
 * Serialized in one of two shapes — see {@link serializeDocument}. Both parse,
 * and a document that fails to parse in full is `malformed` rather than
 * partially trusted: its job is to be an *exhaustive* statement of what cairn
 * owns here, and a dropped entry would make that entry's files look unowned to
 * the occupancy check and to `retirePrior`, which is the destruction this shape
 * exists to prevent.
 */
export interface InstallDocument {
  generator: { name: string; version: string };
  installs: InstallRecord[];
}

/**
 * An install's identity within one destination.
 *
 * Keyed on the bundle **and** the target, which is the whole fix: keyed on the
 * bundle name alone, a second target's install read the first's inventory as
 * its own stale files and deleted them.
 *
 * NUL-separated for the reason `artifactKey` and `sessionKey` are — no half can
 * contain one. `profile` is redundant while `locationFor(target, scope)` fixes
 * it, and is included so a future target declaring two locations for one scope
 * does not silently collide. `destination` is deliberately absent: the key is
 * only ever compared within one manifest file.
 */
export function installKey(record: {
  bundle: { name: string };
  target: AgentTarget;
  profile: AgentProfile;
  scope: InstallScope;
}): string {
  return [record.bundle.name, record.target, record.profile, record.scope].join("\0");
}

/** Byte comparison, never `localeCompare`: these bytes are generated output. */
function sortRecords(records: InstallRecord[]): InstallRecord[] {
  return [...records].sort((a, b) => {
    const left = installKey(a);
    const right = installKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
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
  /**
   * The bundle a single-bundle install renders. Absent for a collection, which
   * installs many; nothing reads it, so a collection is not made to invent one.
   */
  bundle?: AgentBundle;
  target: AgentTarget;
  profile: AgentProfile;
  scope: InstallScope;
  layout: InstallLayout;
  mode: InstallMode;
  destination: string;
  artifacts: Artifact[];
  /** This install's own record. */
  record: InstallRecord;
  /**
   * The whole document this plan writes, siblings included. Byte-identical for
   * every plan sharing a destination in one batch.
   */
  document: InstallDocument;
  /**
   * The document as it stood when the plan was made.
   *
   * `retirePrior` prunes against this snapshot and never against a re-read at
   * commit time: every plan in a destination group writes the same merged
   * document, so once the first has committed, the file already lists the
   * second's record — a re-read would make the second find itself, compute an
   * empty stale set, and silently never prune. It also closes the window
   * between planning and committing.
   */
  prior: InstallDocument | "missing" | "malformed";
  diagnostics: AgentDiagnostic[];
  register: boolean;
  settings?: InstallRegistration;
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

function toEntry(manifest: InstallRecord): InstallEntry {
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

function parseRecord(value: unknown): InstallRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const bundle = doc.bundle as Record<string, unknown> | undefined;
  const files = doc.files;
  if (
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
  const keys = Array.isArray(registration?.pluginKeys)
    ? registration.pluginKeys.filter((key): key is string => typeof key === "string")
    : undefined;
  const parsedRegistration =
    registration &&
    typeof registration.file === "string" &&
    typeof registration.marketplaceKey === "string" &&
    (typeof registration.pluginKey === "string" || keys !== undefined)
      ? {
          file: registration.file,
          marketplaceKey: registration.marketplaceKey,
          ...(typeof registration.pluginKey === "string"
            ? { pluginKey: registration.pluginKey }
            : {}),
          ...(keys ? { pluginKeys: keys } : {}),
        }
      : undefined;
  const collection = doc.collection as Record<string, unknown> | undefined;
  const plugins =
    collection && Array.isArray(collection.plugins)
      ? collection.plugins.flatMap((entry) => {
          const row = entry as Record<string, unknown> | null;
          return row && typeof row.name === "string" && typeof row.version === "string"
            ? [{ name: row.name, version: row.version }]
            : [];
        })
      : undefined;
  return {
    ...(doc.kind === "collection" ? { kind: "collection" as const } : {}),
    bundle: { name: bundle.name, version: bundle.version },
    ...(plugins ? { collection: { plugins } } : {}),
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

/**
 * Both serializations of the manifest document.
 *
 * A `bundle` at the top level is the single-record shape — which is also every
 * manifest written before a destination could hold more than one, so an install
 * made by an older cairn stays removable. `installs` is the multi-record shape.
 * A document carrying both is `malformed` rather than a guess, the same rule as
 * two manifest filenames and two matching install scopes.
 */
function parseDocument(value: unknown): InstallDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const generator = doc.generator as Record<string, unknown> | undefined;
  if (!generator || typeof generator.name !== "string" || typeof generator.version !== "string")
    return null;
  const stamp = { name: generator.name, version: generator.version };
  if (doc.installs !== undefined && doc.bundle !== undefined) return null;
  if (doc.installs !== undefined) {
    if (!Array.isArray(doc.installs)) return null;
    const installs: InstallRecord[] = [];
    for (const entry of doc.installs) {
      const record = parseRecord(entry);
      // One unparseable entry poisons the whole file. See InstallDocument.
      if (!record) return null;
      installs.push(record);
    }
    return { generator: stamp, installs };
  }
  const single = parseRecord(doc);
  return single ? { generator: stamp, installs: [single] } : null;
}

/**
 * Writes the single-record shape while there is one record, and the `installs`
 * shape only from two.
 *
 * A cairn predating multi-record destinations reads an `installs` document as
 * `malformed`, which makes `agent uninstall` refuse (`AB806`) rather than
 * mis-remove — but makes `agent install --force` overwrite the file and orphan
 * every sibling's inventory. Keeping the old shape for the single-record case
 * confines that hazard to destinations that could not have existed before.
 */
function serializeDocument(document: InstallDocument): unknown {
  const [only] = document.installs;
  if (document.installs.length === 1) return { generator: document.generator, ...only };
  return { generator: document.generator, installs: document.installs };
}

function currentGenerator(): { name: string; version: string } {
  return { name: packageName, version: packageVersion };
}

export function readInstallDocument(
  destination: string,
): InstallDocument | "missing" | "malformed" {
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
    const parsed = parseDocument(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed ?? "malformed";
  } catch {
    return "malformed";
  }
}

/** The record matching `key` at `destination`, if the document records one. */
export function readInstallRecord(
  destination: string,
  key: string,
): InstallRecord | "missing" | "malformed" {
  const document = readInstallDocument(destination);
  if (document === "missing" || document === "malformed") return document;
  return document.installs.find((record) => installKey(record) === key) ?? "missing";
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

/**
 * What stands between this payload and its destination.
 *
 * Occupancy is a question about **paths**, not about which bundle was here
 * first. The previous rule — a merge destination recording any other bundle is
 * occupied — made a second bundle in a repository root an AB801 every time,
 * while a second *target* of the same bundle passed the check entirely and then
 * had its predecessor's files pruned as stale. Both fall out of asking per path
 * who owns it.
 */
interface Occupancy {
  /** A path this payload writes that exists on disk and no record accounts for. */
  foreign?: string;
  /**
   * Paths a *different* record at this destination owns with **different**
   * content. Two installs writing byte-identical content to one path — the
   * common case for a bundle's shared assets, which several targets each place
   * at the destination root — is co-ownership rather than a conflict: both
   * records list the path, and uninstalling one leaves it for the other.
   */
  conflicts: Array<{ path: string; owner: InstallRecord }>;
  /** This install's own prior record, when the destination records one. */
  mine?: InstallRecord;
}

function assessDestination(
  destination: string,
  layout: InstallLayout,
  payload: Artifact[],
  prior: InstallDocument | "missing" | "malformed",
  key: string,
): Occupancy {
  const records = prior === "missing" || prior === "malformed" ? [] : prior.installs;
  const mine = records.find((record) => installKey(record) === key);
  const owners = new Map<string, { record: InstallRecord; sha256: string }>();
  for (const record of records) {
    if (installKey(record) === key) continue;
    for (const file of record.files) owners.set(file.path, { record, sha256: file.sha256 });
  }
  const result: Occupancy = { conflicts: [], ...(mine ? { mine } : {}) };
  const ours = new Set(mine?.files.map((file) => file.path) ?? []);

  // A destination that records nothing and is not empty is occupied wholesale
  // for the layouts that own their directory. Merge shares its root by design,
  // so it is only ever assessed per path.
  if (layout !== "merge" && !records.length && existsAt(destination)) {
    const listing = fs.lstatSync(destination);
    if (!listing.isDirectory() || fs.readdirSync(destination).length)
      return { ...result, foreign: destination };
  }

  for (const artifact of payload) {
    if (artifact.path === INSTALL_MANIFEST) continue;
    const owner = owners.get(artifact.path);
    if (owner) {
      if (owner.sha256 !== sha256(artifact.content))
        result.conflicts.push({ path: artifact.path, owner: owner.record });
      continue;
    }
    if (ours.has(artifact.path)) continue;
    if (!result.foreign && existsAt(path.join(destination, artifact.path)))
      result.foreign = artifact.path;
  }
  return result;
}

/** `AB808`, in the form raised against an install already at the destination. */
function conflictDiagnostic(
  conflict: { path: string; owner: InstallRecord },
  destination: string,
  target: AgentTarget,
): AgentDiagnostic {
  return error(
    "AB808",
    `Destination path '${conflict.path}' is already owned by the install of '${conflict.owner.bundle.name}' for ${conflict.owner.target}/${conflict.owner.profile}`,
    {
      path: conflict.path,
      target,
      remediation: `Uninstall '${conflict.owner.bundle.name}' for ${conflict.owner.target} first, install to a different destination, or pass --force to overwrite it.`,
    },
  );
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
  for (const key of registeredPluginKeys(settings)) enabled[key] = true;
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
  for (const key of registeredPluginKeys(registration)) delete enabled[key];
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
      registeredPluginKeys(settings).every((key) => enabled?.[key] === true)
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
  // The files matching is not enough: a record hand-removed from the manifest
  // would leave --check reporting "current" while uninstall reports not-found.
  if (readInstallRecord(plan.destination, installKey(plan.record)) === "missing") return false;
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

/**
 * The manifest as an ordinary artifact, so it lands through the same atomic
 * writer as everything else and `--dry-run` reports its real bytes.
 *
 * It takes the whole document rather than one record, and there is no cycle in
 * that: a record's inventory comes from its own payload, which `inventoryOf`
 * strips this file from; the document comes from the records. Deriving a
 * sibling's record from a sibling's *artifacts* would introduce one.
 */
function manifestArtifact(document: InstallDocument): Artifact {
  return {
    path: INSTALL_MANIFEST,
    content: Buffer.from(JSON.stringify(serializeDocument(document), null, 2) + "\n"),
    mode: 0o644,
  };
}

/** Options shared by every install plan in one run. */
export interface PlanInstallOptions extends InstallContext {
  scope?: string;
  into?: string;
  profile?: string;
  link?: boolean;
  register?: boolean;
  force?: boolean;
}

/**
 * Phase one: everything about an install that does not depend on its
 * neighbours. The manifest artifact is deliberately absent — its bytes depend
 * on sibling records, which only {@link finishGroup} knows.
 */
interface DraftInstall {
  bundle?: AgentBundle;
  target: AgentTarget;
  profile: AgentProfile;
  scope: InstallScope;
  layout: InstallLayout;
  mode: InstallMode;
  destination: string;
  payload: Artifact[];
  record: InstallRecord;
  diagnostics: AgentDiagnostic[];
  register: boolean;
  settings?: InstallRegistration;
}

/** An unresolvable install: AB800 already recorded, nothing to place. */
function unresolvedPlan(
  bundle: AgentBundle,
  target: AgentTarget,
  scope: InstallScope,
  mode: InstallMode,
  resolved: AgentDiagnostic,
): InstallPlan {
  const record: InstallRecord = {
    bundle: { name: bundle.name, version: bundle.version },
    target,
    profile: "plugin",
    scope,
    layout: "plugin-dir",
    mode: "copy",
    destination: "",
    files: [],
  };
  return {
    bundle,
    target,
    profile: "plugin",
    scope,
    layout: "plugin-dir",
    mode,
    destination: "",
    artifacts: [],
    record,
    document: { generator: currentGenerator(), installs: [record] },
    prior: "missing",
    diagnostics: [resolved],
    register: false,
  };
}

function draftInstall(
  bundle: AgentBundle,
  target: AgentTarget,
  options: PlanInstallOptions,
): DraftInstall | InstallPlan {
  const scope = resolveScope(options.scope, "user");
  const resolved = resolveInstallDestination(target, scope, bundle.name, options);
  const mode: InstallMode = options.link ? "link" : "copy";
  if (!isResolved(resolved)) return unresolvedPlan(bundle, target, scope, mode, resolved);

  const { location, destination } = resolved;
  if (options.profile && options.profile !== "both" && options.profile !== location.profile)
    throw new Error(`Install location for ${target}/${scope} uses the ${location.profile} profile`);
  if (options.profile === "both")
    throw new Error(
      "Install uses one profile per destination; pass plugin or project, or omit --profile",
    );

  const diagnostics: AgentDiagnostic[] = [];
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
  return {
    bundle,
    target,
    profile: location.profile,
    scope,
    layout: location.layout,
    mode,
    destination,
    payload: built.artifacts,
    record: {
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
    },
    diagnostics,
    register,
    settings,
  };
}

/**
 * Phase two: one destination's drafts become plans that share one document.
 *
 * The document is merged here rather than at commit so that `--dry-run` and
 * `--check` report the bytes that would actually land. There is no cycle to
 * untangle: a record's inventory comes from its own payload, which
 * {@link inventoryOf} strips the manifest from; the document comes from the
 * records; the manifest artifact comes from the document. Only deriving a
 * sibling's record from a sibling's *artifacts* would reintroduce one.
 */
function finishGroup(
  destination: string,
  drafts: DraftInstall[],
  options: { force?: boolean },
): { plans: InstallPlan[]; diagnostics: AgentDiagnostic[] } {
  // Read once per group: every plan must carry the identical snapshot.
  const prior = existsAt(destination) ? readInstallDocument(destination) : "missing";
  const priorRecords = prior === "missing" || prior === "malformed" ? [] : prior.installs;
  const ordered = [...drafts].sort((a, b) => {
    const left = installKey(a.record);
    const right = installKey(b.record);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const batchKeys = new Set(ordered.map((draft) => installKey(draft.record)));
  const document: InstallDocument = {
    generator: currentGenerator(),
    installs: sortRecords([
      ...priorRecords.filter((record) => !batchKeys.has(installKey(record))),
      ...ordered.map((draft) => draft.record),
    ]),
  };

  const diagnostics: AgentDiagnostic[] = [];
  const claimed = new Map<string, { draft: DraftInstall; content: Buffer }>();
  const plans: InstallPlan[] = [];
  for (const draft of ordered) {
    const key = installKey(draft.record);
    const assessment = assessDestination(destination, draft.layout, draft.payload, prior, key);
    const findings: AgentDiagnostic[] = [];
    if (assessment.foreign && !options.force)
      findings.push(
        error(
          "AB801",
          `Destination is occupied by something that is not a prior install of '${draft.record.bundle.name}'`,
          {
            path: destination,
            target: draft.target,
            remediation: "Pass --force to replace it, or uninstall the occupant first.",
          },
        ),
      );
    if (!options.force)
      for (const conflict of assessment.conflicts)
        findings.push(conflictDiagnostic(conflict, destination, draft.target));
    if (assessment.mine)
      findings.push(
        diagnostic(
          "AB802",
          `Replacing existing install of ${assessment.mine.bundle.name} ${assessment.mine.bundle.version} with ${draft.record.bundle.version}`,
          "exact",
          { target: draft.target, profile: draft.profile, path: destination },
        ),
      );
    // A --link install of a layout that owns its directory replaces the whole
    // destination with a symlink, which cannot coexist with a sibling record.
    if (draft.mode === "link" && draft.layout !== "merge" && document.installs.length > 1)
      findings.push(
        error(
          "AB809",
          `A --link install cannot share a destination with another install: ${destination} already records '${document.installs.find((record) => installKey(record) !== key)?.bundle.name ?? "another bundle"}'`,
          {
            path: destination,
            target: draft.target,
            remediation: "Install without --link, or use a destination of its own.",
          },
        ),
      );

    // Within one run, two installs writing one path is not something --force can
    // resolve: it cannot make a single run write two byte streams to one path,
    // and suppressing it would make the result depend on commit order.
    for (const artifact of draft.payload) {
      if (artifact.path === INSTALL_MANIFEST) continue;
      const other = claimed.get(artifact.path);
      if (other && !other.content.equals(artifact.content))
        diagnostics.push(
          error(
            "AB808",
            `Two installs in this run both write '${artifact.path}' at ${destination}: '${other.draft.record.bundle.name}' (${other.draft.target}/${other.draft.profile}) and '${draft.record.bundle.name}' (${draft.target}/${draft.profile})`,
            {
              path: artifact.path,
              target: draft.target,
              remediation: "Install them to separate destinations, or drop one --target.",
            },
          ),
        );
      else if (!other) claimed.set(artifact.path, { draft, content: artifact.content });
    }

    plans.push({
      ...(draft.bundle ? { bundle: draft.bundle } : {}),
      target: draft.target,
      profile: draft.profile,
      scope: draft.scope,
      layout: draft.layout,
      mode: draft.mode,
      destination,
      artifacts: [...draft.payload, manifestArtifact(document)].sort(byPath),
      record: draft.record,
      document,
      prior,
      diagnostics: [...draft.diagnostics, ...findings],
      register: draft.register,
      ...(draft.settings ? { settings: draft.settings } : {}),
    });
  }
  return { plans, diagnostics };
}

/** One bundle to install for one target. */
export interface InstallRequest {
  bundle: AgentBundle;
  target: AgentTarget;
}

export interface InstallBatch {
  plans: InstallPlan[];
  /** Batch-level findings — the in-run AB808. Per-plan findings stay on the plan. */
  diagnostics: AgentDiagnostic[];
}

/**
 * Plans every requested install, grouped by destination.
 *
 * Nothing is written here, and the caller must treat the batch as all-or-nothing:
 * committing a subset of a run whose remainder is blocked is how a destination
 * ends up half-populated with no record of it.
 */
export function planInstalls(
  requests: InstallRequest[],
  options: PlanInstallOptions,
): InstallBatch {
  const drafted = requests.map((request) => draftInstall(request.bundle, request.target, options));
  const groups = new Map<string, DraftInstall[]>();
  const unresolved: InstallPlan[] = [];
  const order: Array<{ destination: string; key: string } | { plan: InstallPlan }> = [];
  for (const draft of drafted) {
    if ("payload" in draft) {
      const destination = path.resolve(draft.destination);
      const list = groups.get(destination) ?? [];
      list.push(draft);
      groups.set(destination, list);
      order.push({ destination, key: installKey(draft.record) });
    } else {
      unresolved.push(draft);
      order.push({ plan: draft });
    }
  }

  const planned = new Map<string, InstallPlan>();
  const diagnostics: AgentDiagnostic[] = [];
  for (const [destination, drafts] of groups) {
    const finished = finishGroup(destination, drafts, options);
    diagnostics.push(...finished.diagnostics);
    for (const plan of finished.plans)
      planned.set(`${destination}\0${installKey(plan.record)}`, plan);
  }

  // Requests are reported back in the order they were given, not in the order
  // grouping happened to visit them.
  const plans: InstallPlan[] = [];
  for (const item of order) {
    if ("plan" in item) plans.push(item.plan);
    else {
      const plan = planned.get(`${item.destination}\0${item.key}`);
      if (plan) plans.push(plan);
    }
  }
  return { plans, diagnostics };
}

/**
 * Plans a single install: renders and packages in memory, resolves the
 * destination from profile data, and records AB8xx findings. Nothing is written.
 */
export function planInstall(
  bundle: AgentBundle,
  target: AgentTarget,
  options: PlanInstallOptions,
): InstallPlan {
  const batch = planInstalls([{ bundle, target }], options);
  const plan = batch.plans[0];
  return batch.diagnostics.length
    ? { ...plan, diagnostics: [...plan.diagnostics, ...batch.diagnostics] }
    : plan;
}

/** What a collection places at one destination. */
export interface CollectionInstall {
  /** The collection's name; also the marketplace key hosts index by. */
  name: string;
  version: string;
  target: AgentTarget;
  /**
   * Destination-relative artifacts: the aggregated catalog plus one directory
   * per plugin. Already stripped of the `<target>/` prefix the build uses.
   */
  artifacts: Artifact[];
  plugins: Array<{ name: string; version: string }>;
}

/**
 * Plans an install of a whole collection into one host marketplace.
 *
 * The difference from {@link planInstall} is entirely in the registration:
 * a bundle install keys `extraKnownMarketplaces` on the bundle name and enables
 * one plugin, so installing five bundles yields five marketplaces. A collection
 * keys it on the collection name once and enables every plugin under it, which
 * is the shape a host actually offers to a user.
 *
 * Everything else — the occupied check, the manifest, the inventory, uninstall —
 * is shared, because the manifest's `bundle` field records the installed unit's
 * identity and a collection simply puts its own there.
 */
export function planCollectionInstall(
  collection: CollectionInstall,
  options: {
    scope?: InstallScope;
    into?: string;
    link?: boolean;
    force?: boolean;
    register?: boolean;
    /** Where a `--link` install materializes; required when `link` is set. */
    materializeInto?: string;
  } & InstallContext = {},
): InstallPlan {
  const scope = resolveScope(options.scope);
  const diagnostics: AgentDiagnostic[] = [];
  const resolved = resolveInstallDestination(collection.target, scope, collection.name, options);
  if ("code" in resolved)
    return {
      target: collection.target,
      profile: "plugin",
      scope,
      layout: "plugin-dir",
      mode: "copy",
      destination: "",
      artifacts: [],
      record: unresolvedCollectionRecord(collection, scope),
      document: {
        generator: currentGenerator(),
        installs: [unresolvedCollectionRecord(collection, scope)],
      },
      prior: "missing",
      diagnostics: [resolved],
      register: Boolean(options.register),
    };

  const { location, destination } = resolved;
  if (location.profile !== "plugin")
    throw new Error(
      `Install location for ${collection.target}/${scope} uses the ${location.profile} profile; a collection is plugin-only`,
    );

  const mode: InstallMode = options.link ? "link" : "copy";
  for (const artifact of collection.artifacts)
    if (pathEscapesRoot(destination, artifact.path))
      diagnostics.push(
        error("AB804", `Destination path escapes the install root: ${artifact.path}`, {
          path: artifact.path,
          target: collection.target,
          profile: "plugin",
        }),
      );

  const settingsFile = location.activation
    ? expandInstallRoot(location.activation.file, options)
    : undefined;
  const pluginKeys = collection.plugins.map((plugin) => `${plugin.name}@${collection.name}`);
  const settings =
    location.layout === "marketplace" && settingsFile
      ? { file: settingsFile, marketplaceKey: collection.name, pluginKeys }
      : undefined;
  const register = Boolean(options.register) && Boolean(settings);
  if (settings && !options.register)
    diagnostics.push(
      diagnostic(
        "AB805",
        `Host activation edit required but --register was not given. Add extraKnownMarketplaces.${collection.name} (directory ${destination}) and enabledPlugins for ${pluginKeys.join(", ")} to ${settingsFile}.`,
        "unsupported",
        {
          target: collection.target,
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
        { target: collection.target, profile: "plugin", path: destination },
      ),
    );

  const materialized = mode === "link" ? options.materializeInto : undefined;
  if (mode === "link" && !materialized)
    throw new Error("A --link collection install needs a materialization directory");
  const draft: DraftInstall = {
    target: collection.target,
    profile: "plugin",
    scope,
    layout: location.layout,
    mode,
    destination,
    payload: collection.artifacts,
    record: {
      kind: "collection",
      bundle: { name: collection.name, version: collection.version },
      collection: { plugins: collection.plugins },
      target: collection.target,
      profile: "plugin",
      scope,
      layout: location.layout,
      mode,
      destination,
      files: inventoryOf(collection.artifacts),
      ...(materialized ? { materialized } : {}),
      ...(register && settings ? { registration: settings } : {}),
    },
    diagnostics,
    register,
    ...(settings ? { settings } : {}),
  };
  // Through the same grouping as a bundle install: a collection resolves every
  // target to `<into>/<name>`, so without it `--into X --target all` reproduced
  // the destruction this change exists to remove.
  const finished = finishGroup(destination, [draft], options);
  const plan = finished.plans[0];
  return finished.diagnostics.length
    ? { ...plan, diagnostics: [...plan.diagnostics, ...finished.diagnostics] }
    : plan;
}

function unresolvedCollectionRecord(
  collection: CollectionInstall,
  scope: InstallScope,
): InstallRecord {
  return {
    kind: "collection",
    bundle: { name: collection.name, version: collection.version },
    collection: { plugins: collection.plugins },
    target: collection.target,
    profile: "plugin",
    scope,
    layout: "plugin-dir",
    mode: "copy",
    destination: "",
    files: [],
  };
}

function writeCopy(plan: InstallPlan): void {
  const payload = plan.artifacts;
  // Replacing the destination wholesale is what guarantees no leftovers when a
  // manifest was lost and --force was used, so it is kept for the layouts that
  // own their directory — but only while this install is the sole record there.
  // With a sibling, it would delete the sibling's tree.
  const wholesale = plan.layout !== "merge" && plan.document.installs.length === 1;
  if (wholesale)
    writeArtifactsAtomically(plan.destination, payload, { managedRoots: ["."], force: true });
  else
    writeArtifactsAtomically(plan.destination, payload, {
      managedRoots: [],
      looseFiles: payload.map((artifact) => artifact.path),
      force: true,
    });
}

function writeLink(plan: InstallPlan): void {
  const materialized = plan.record.materialized;
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
  const prior = plan.prior;
  if (prior === "missing" || prior === "malformed") return;
  const key = installKey(plan.record);
  const previous = prior.installs.find((record) => installKey(record) === key);
  if (!previous) return;
  const next = new Set(plan.record.files.map((file) => file.path));
  // Owners after this run, not before it: reading the prior document alone would
  // let this delete a file a sibling in the same batch has just written.
  const claimed = new Set(
    plan.document.installs
      .filter((record) => installKey(record) !== key)
      .flatMap((record) => record.files.map((file) => file.path)),
  );
  for (const file of previous.files) {
    if (next.has(file.path) || claimed.has(file.path)) continue;
    removePath(path.join(plan.destination, file.path));
    pruneEmptyAncestors(plan.destination, file.path);
  }
  if (previous.materialized && previous.materialized !== plan.record.materialized)
    removePath(previous.materialized);
  if (previous.registration && !plan.record.registration)
    revertRegistration(previous.registration, plan.destination);
}

/** Writes a planned install. Caller must have already decided the run is not blocked. */
export function commitInstall(plan: InstallPlan): void {
  retirePrior(plan);
  if (plan.mode === "link") writeLink(plan);
  else writeCopy(plan);
  if (plan.register && plan.settings) applyRegistration(plan.settings, plan.destination);
}

export function planToEntry(plan: InstallPlan): InstallEntry {
  return toEntry(plan.record);
}

export interface UninstallPlan {
  name: string;
  target: AgentTarget;
  destination: string;
  manifest: InstallRecord | null;
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
  const matches: Array<{ scope: InstallScope; destination: string; manifest: InstallRecord }> = [];
  for (const candidate of candidatesFor(target, name, scopes, options)) {
    const read = existsAt(candidate.destination)
      ? readInstallDocument(candidate.destination)
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
    else if (read !== "missing")
      // Filtering on the target as well as the name is required now that a
      // destination records several installs: matching on the name alone would
      // remove a different target's inventory from the same document.
      for (const record of read.installs)
        if (record.bundle.name === name && record.target === target)
          matches.push({ ...candidate, manifest: record });
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
  const record = plan.manifest;
  if (!record) return;
  const destination = plan.destination;
  const document = readInstallDocument(destination);
  const key = installKey(record);
  const remaining =
    document === "missing" || document === "malformed"
      ? []
      : document.installs.filter((entry) => installKey(entry) !== key);
  // A path a sibling still owns is not this install's to remove.
  const claimed = new Set(remaining.flatMap((entry) => entry.files.map((file) => file.path)));
  const listing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (listing?.isSymbolicLink() && !remaining.length) removePath(destination);
  else {
    for (const file of record.files) {
      if (claimed.has(file.path)) continue;
      removePath(path.join(destination, file.path));
      pruneEmptyAncestors(destination, file.path);
    }
    const manifestFile = installManifestIn(destination);
    if (remaining.length) {
      writeJsonAtomically(
        path.join(destination, INSTALL_MANIFEST),
        serializeDocument({ generator: currentGenerator(), installs: sortRecords(remaining) }),
      );
      // The survivors are rewritten under the current name, so a legacy-named
      // file left beside it would read as `malformed` from here on.
      if (manifestFile && path.basename(manifestFile) === LEGACY_INSTALL_MANIFEST)
        removePath(manifestFile);
    } else {
      if (manifestFile) removePath(manifestFile);
      if (
        record.layout !== "merge" &&
        existsAt(destination) &&
        fs.statSync(destination).isDirectory() &&
        fs.readdirSync(destination).length === 0
      )
        fs.rmdirSync(destination);
    }
  }
  if (record.materialized) removePath(record.materialized);
  if (record.registration) revertRegistration(record.registration, destination);
}

function scanRoot(
  target: AgentTarget,
  scope: InstallScope,
  location: InstallLocation,
  locationRoot: string,
): InstallEntry[] {
  const entries: InstallEntry[] = [];
  const collect = (destination: string): void => {
    const read = existsAt(destination) ? readInstallDocument(destination) : "missing";
    if (read === "missing" || read === "malformed") return;
    for (const record of read.installs)
      if (record.target === target && record.scope === scope)
        entries.push(toEntry({ ...record, destination }));
  };
  if (location.layout === "merge") {
    collect(locationRoot);
    return entries;
  }
  if (!existsAt(locationRoot) || !fs.statSync(locationRoot).isDirectory()) return entries;
  for (const name of fs.readdirSync(locationRoot).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const destination = path.join(locationRoot, name);
    const listing = fs.lstatSync(destination);
    if (!listing.isDirectory() && !listing.isSymbolicLink()) continue;
    collect(destination);
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
    // Profile and destination are in the key because one destination now yields
    // several rows, and `agent installed -fj` byte order is what consumers read.
    const left = `${a.target}/${a.scope}/${a.name}/${a.profile}/${a.destination}`;
    const right = `${b.target}/${b.scope}/${b.name}/${b.profile}/${b.destination}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
