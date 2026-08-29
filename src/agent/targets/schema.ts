import type { AgentProfile, AgentTarget, BundleRule, MappingQuality } from "../types.js";

/**
 * Version of the target-profile shape itself. Hand-owned; unrelated to the
 * semantic-release-managed package version. Bump only when the profile
 * structure changes in a way consumers must react to.
 */
export const PROFILE_SCHEMA_VERSION = "2";

export const PORTABLE_HOOK_EVENTS = [
  "session-start",
  "pre-tool-use",
  "post-tool-use",
  "stop",
] as const;
export type PortableHookEvent = (typeof PORTABLE_HOOK_EVENTS)[number];

export type ModelClass = "fast" | "balanced" | "capable" | "inherit";
export type ToolCapability = "read" | "write" | "shell" | "web";
export type RuleActivation = BundleRule["activation"];

/** MappingQuality plus the target-native pass-through case profiles need. */
export type FeatureSupport = MappingQuality | "native";

export const FEATURE_KEYS = [
  "skills",
  "agents",
  "rules",
  "hooks",
  "policies",
  "mcp",
  "assets",
  "placeholders",
  "native",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureProfile {
  /**
   * The best mapping quality this feature achieves on this target. Individual
   * occurrences may be worse — a malformed input or an unsupported output
   * profile is reported per-diagnostic — but never better, which is what the
   * conformance suite asserts.
   */
  support: FeatureSupport;
  /** Output profiles in which this feature is emitted at all. Read by the renderer. */
  profiles: AgentProfile[];
  /** One line; the machine-generated replacement for a free-text compatibility cell. */
  summary: string;
  /** Native surface, e.g. ".claude/rules/<name>.md". Documentation only. */
  surface: string | null;
  /** Diagnostic codes this target may emit for this feature. */
  diagnostics: string[];
}

/**
 * A POSIX path relative to `<output>/<target>/<profile>`.
 *
 * Grammar: `{name}` matches exactly one path segment, `*` matches part of one
 * segment, and `**` matches any remaining suffix including nothing.
 */
export interface OutputPattern {
  feature: FeatureKey | "manifest";
  pattern: string;
}

export interface NativeValidatorSpec {
  /** `{dir}` is substituted with the generated `<target>/<profile>` directory. */
  command: string[];
  readOnly: true;
  appliesTo: AgentProfile[];
}

export interface HostProfile {
  displayName: string;
  /** ISO date of the target documentation this profile was written against. */
  documentationRevision: string;
  /** Below this version the profile is known to be wrong. `null` when not recorded. */
  minimumVersion: string | null;
  /** Highest host version this profile was verified against. `null` when not recorded. */
  verifiedThrough: string | null;
  /** Declared for callers to run themselves. This CLI never executes it. */
  versionCommand: string[] | null;
  /** Declared for callers to run themselves. This CLI never executes it. */
  nativeValidator: NativeValidatorSpec | null;
}

export interface ManifestFieldProfile {
  name: string;
  required: boolean;
  support: FeatureSupport;
}

export interface ManifestProfile {
  /** Plugin manifest directory, or `null` when the target has no plugin manifest. */
  directory: string | null;
  file: string;
  fields: ManifestFieldProfile[];
  /**
   * Manifest keys the host derives from the plugin layout on its own, so the
   * renderer must leave them out. Declaring one is not merely redundant, it is
   * an error, and neither kind is caught by `claude plugin validate`:
   *
   * - `agents` accepts a list of files and rejects the component directory the
   *   renderer would name, which fails the whole manifest.
   * - `hooks` is for *additional* hook files; naming the standard
   *   `hooks/hooks.json` that the host already loaded is a duplicate, and the
   *   plugin's hooks are dropped.
   *
   * Omitting them is what makes `agents/` and `hooks/hooks.json` load.
   */
  impliedFields?: string[];
}

export interface PluginRoots {
  skills: string;
  /** Directory for hook *scripts*. */
  hooks: string;
  /** The hook *declaration* document, relative to the plugin root. */
  hooksFile: string;
  agents: string | null;
  assets: string;
  mcp: string | null;
}

export interface ProjectRoots {
  skills: string;
  agents: string | null;
  rules: string | null;
  policies: string | null;
  mcp: string | null;
  assets: string;
}

export interface PathProfile {
  plugin: PluginRoots;
  project: ProjectRoots;
  /** True when plugin skill directories are namespaced as `${bundle}-${skill}`. */
  namespacePluginSkills: boolean;
}

export interface PlaceholderProfile {
  /** `${BUNDLE_ROOT}` substitution per output profile. */
  bundleRoot: Record<AgentProfile, string>;
  /**
   * How `$ARGUMENTS` survives: `native` means the host substitutes it,
   * `advisory` appends a prose hint beside it, `prose` replaces it outright.
   */
  arguments: "native" | "advisory" | "prose";
  /** Root variables the target understands, for documentation and `agent specs`. */
  rootVariables: string[];
}

export interface HookProfile {
  /** Portable event to native name; `null` means the target cannot express it. */
  events: Record<PortableHookEvent, string | null>;
  /**
   * `versioned` wraps handlers in `{ version: 1, hooks }`, `hooks` emits
   * `{ hooks }`, and `named` keys the whole document by the bundle's name.
   */
  envelope: "hooks" | "versioned" | "named";
  /**
   * `claude-nested` wraps handlers in `{ matcher, hooks: [...] }` and `flat`
   * does not. `nested-for-matcher-events` wraps only the events listed in
   * {@link matcherEvents}, which is a host that accepts a tool-name matcher on
   * its tool events and nothing on the rest.
   */
  handlerShape: "claude-nested" | "flat" | "nested-for-matcher-events";
  /** Events that take a matcher. Empty unless `handlerShape` names it. */
  matcherEvents: PortableHookEvent[];
  supportedProtocols: string[];
}

export interface ModelProfile {
  support: FeatureSupport;
  /** Semantic class to native model id; `null` means the target has no model field. */
  classes: Record<ModelClass, string | null>;
}

export interface ToolProfile {
  support: FeatureSupport;
  /** `null` means capability restriction is not expressible natively. */
  capabilities: Record<ToolCapability, string[]> | null;
}

export interface RuleProfile {
  exactActivation: RuleActivation[];
  /** Activations that render, but not faithfully. Everything else is unsupported. */
  approximateActivation: RuleActivation[];
  form: "mdc" | "markdown" | "aggregated-agents-md" | "trigger-frontmatter" | null;
}

/**
 * How a target expresses a command policy.
 *
 * This exists because the renderer used to pick the form by target name, with
 * an unguarded `else` that emitted Codex's `prefix_rule` DSL to a Codex path
 * for every target that was not Claude Code or Cursor. Naming the form here
 * makes a host with no policy surface declare `null` and get a diagnostic,
 * rather than silently inheriting someone else's format.
 */
export type PolicyForm =
  | "claude-permissions"
  | "codex-prefix-rules"
  | "cursor-hooks"
  /** Reserved: a `permission` block inside a config file the MCP writer also owns. */
  | "opencode-permission";

export interface PolicyProfile {
  /** `null` when the host has no native command-policy format. */
  form: PolicyForm | null;
}

/**
 * How a target expresses "do not invoke this skill implicitly".
 *
 * `frontmatter-flag` sets a key on the skill document, `openai-yaml` writes a
 * sidecar policy file, and `advisory` can only say so in prose.
 */
export type SkillInvocationForm = "frontmatter-flag" | "openai-yaml" | "advisory";

export interface SkillProfile {
  /** `null` when the host offers no way to say it at all. */
  invocationPolicy: SkillInvocationForm | null;
}

/** Where a catalog entry's value comes from. */
export type MarketplaceFieldSource =
  | { from: "manifest"; field: string }
  | { from: "marketplace"; field: string }
  | { from: "computed"; value: "source" };

/**
 * How a resolved value is reshaped before it lands in the catalog.
 *
 * Targets disagree on the shape of the same underlying datum — Claude Code
 * wants `author` as an object and `category` as one string, Cursor wants
 * `author` as a bare name and `categories` as the whole list. Naming the
 * reshape here keeps that disagreement in the profile instead of as a
 * field-name check inside the packager.
 */
export type MarketplaceFieldTransform = "identity" | "name" | "first";

export interface MarketplaceEntryField {
  name: string;
  required: boolean;
  source: MarketplaceFieldSource;
  /** Defaults to `identity`. */
  transform?: MarketplaceFieldTransform;
}

export interface MarketplaceAssetRule {
  role: "icon" | "screenshot";
  required: boolean;
  extensions: string[];
  maxBytes: number | null;
}

/**
 * How a target's marketplace catalog is shaped.
 *
 * Catalog structure is tabular target behavior, so it belongs here rather than
 * in the packager — the same rule that keeps paths and hook events out of the
 * renderer. Optional on {@link TargetProfile} so adding it stays additive:
 * every shipped profile defines it, but a consumer that has not been updated
 * simply sees a new key rather than a changed shape.
 */
export interface MarketplaceProfile {
  /** Catalog location per distribution mode; `null` when the mode is unsupported. */
  catalog: Record<"repo" | "local", { directory: string; file: string } | null>;
  /** Top-level array key inside the catalog document. */
  entriesKey: string;
  /**
   * Fields written at the catalog document's top level, beside `entriesKey` —
   * the marketplace's own identity as opposed to a plugin entry's. Optional so
   * the addition stays additive for a target that names none.
   */
  documentFields?: MarketplaceEntryField[];
  entryFields: MarketplaceEntryField[];
  assets: MarketplaceAssetRule[];
  /** `{name}`, `{version}`, `{target}`, and `{profile}` are substituted. */
  archiveName: string;
}

export interface TargetProfile {
  schemaVersion: string;
  id: AgentTarget;
  host: HostProfile;
  /** Output profiles this target supports at all. */
  profiles: AgentProfile[];
  manifest: ManifestProfile;
  paths: PathProfile;
  placeholders: PlaceholderProfile;
  hooks: HookProfile;
  models: ModelProfile;
  tools: ToolProfile;
  rules: RuleProfile;
  policies: PolicyProfile;
  skills: SkillProfile;
  outputs: Record<AgentProfile, OutputPattern[]>;
  features: Record<FeatureKey, FeatureProfile>;
  /** Catalog shape for `agent package`. Optional so adding it stayed additive. */
  marketplace?: MarketplaceProfile;
  /**
   * Where `agent install` places a rendered tree. Optional so adding it stays
   * additive, the same way `marketplace` was: a consumer that has not been
   * updated sees a new key rather than a changed shape.
   */
  install?: InstallProfile;
}

/** How a host discovers an installed tree. */
export type InstallLayout = "plugin-dir" | "merge" | "marketplace";

/**
 * A host file that activates a marketplace install. `null` when the root is
 * auto-scanned and needs no edit.
 */
export type InstallActivation = { file: string; form: "claude-enabled-plugins" } | null;

export interface InstallLocation {
  /** `~`-prefixed for user scope; relative for project scope. */
  root: string;
  layout: InstallLayout;
  profile: AgentProfile;
  /** Host file that activates the install, or null when the root is auto-scanned. */
  activation: InstallActivation;
}

export interface InstallProfile {
  user: InstallLocation | null;
  project: InstallLocation | null;
}

function segmentToSource(segment: string): string {
  if (segment === "**") return "(?:.+)?";
  let source = "";
  for (let index = 0; index < segment.length;) {
    const char = segment[index];
    if (char === "{") {
      const close = segment.indexOf("}", index);
      if (close !== -1) {
        source += "[^/]+";
        index = close + 1;
        continue;
      }
    }
    if (char === "*") {
      source += "[^/]*";
      index++;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\?]/, "\\$&");
    index++;
  }
  return source;
}

/**
 * Compiles an {@link OutputPattern} into an anchored regular expression.
 * `**` is only meaningful as a whole trailing segment.
 */
export function outputPatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map(segmentToSource)
    .join("/")
    // A trailing `/**` must also match the bare directory prefix.
    .replace(/\/\(\?:\.\+\)\?$/, "(?:/.+)?");
  return new RegExp(`^${source}$`);
}

/** True when `candidate` is described by one of the target's declared output patterns. */
export function describesPath(
  profile: TargetProfile,
  outputProfile: AgentProfile,
  candidate: string,
): boolean {
  return (profile.outputs[outputProfile] ?? []).some((entry) =>
    outputPatternToRegExp(entry.pattern).test(candidate),
  );
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseSemver(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compares two plain versions. Deliberately not a range grammar — profiles
 * record single bounds, so ordering is all that is needed.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`Invalid version: ${left ? b : a}`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  // A prerelease sorts below the matching release.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Returns the reasons a profile is internally inconsistent; empty when valid. */
export function validateProfile(profile: TargetProfile): string[] {
  const problems: string[] = [];
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION)
    problems.push(
      `schemaVersion is '${profile.schemaVersion}', expected '${PROFILE_SCHEMA_VERSION}'`,
    );
  if (!profile.profiles.length) problems.push("declares no output profiles");
  for (const key of FEATURE_KEYS) {
    const feature = profile.features[key];
    if (!feature) {
      problems.push(`missing feature declaration '${key}'`);
      continue;
    }
    if (!feature.summary.trim()) problems.push(`feature '${key}' has an empty summary`);
    for (const code of feature.diagnostics)
      if (!/^AB\d{3}$/.test(code))
        problems.push(`feature '${key}' declares malformed diagnostic code '${code}'`);
    for (const outputProfile of feature.profiles)
      if (!profile.profiles.includes(outputProfile))
        problems.push(`feature '${key}' names unsupported output profile '${outputProfile}'`);
  }
  for (const outputProfile of profile.profiles) {
    const patterns = profile.outputs[outputProfile];
    if (!patterns?.length) {
      problems.push(`output profile '${outputProfile}' declares no output patterns`);
      continue;
    }
    for (const entry of patterns) {
      if (entry.pattern.startsWith("/") || entry.pattern.includes("\\"))
        problems.push(`output pattern '${entry.pattern}' is not a POSIX relative path`);
      if (entry.pattern.split("/").includes(".."))
        problems.push(`output pattern '${entry.pattern}' escapes the target root`);
    }
  }
  const policyForms = [
    "claude-permissions",
    "codex-prefix-rules",
    "cursor-hooks",
    "opencode-permission",
  ];
  if (profile.policies.form !== null && !policyForms.includes(profile.policies.form))
    problems.push(`policies.form '${profile.policies.form}' is not a known form`);
  const invocationForms = ["frontmatter-flag", "openai-yaml", "advisory"];
  if (
    profile.skills.invocationPolicy !== null &&
    !invocationForms.includes(profile.skills.invocationPolicy)
  )
    problems.push(
      `skills.invocationPolicy '${profile.skills.invocationPolicy}' is not a known form`,
    );
  for (const event of profile.hooks.matcherEvents)
    if (!PORTABLE_HOOK_EVENTS.includes(event))
      problems.push(`hooks.matcherEvents names unknown event '${event}'`);
  if (
    profile.hooks.handlerShape === "nested-for-matcher-events" &&
    !profile.hooks.matcherEvents.length
  )
    problems.push("hooks.handlerShape is 'nested-for-matcher-events' but matcherEvents is empty");
  for (const version of [profile.host.minimumVersion, profile.host.verifiedThrough])
    if (version !== null && !parseSemver(version))
      problems.push(`host version '${version}' is not a valid semantic version`);
  if (
    profile.host.minimumVersion &&
    profile.host.verifiedThrough &&
    compareSemver(profile.host.minimumVersion, profile.host.verifiedThrough) > 0
  )
    problems.push("host minimumVersion is greater than verifiedThrough");
  if (profile.install) {
    for (const scope of ["user", "project"] as const) {
      const location = profile.install[scope];
      if (!location) continue;
      if (!["plugin-dir", "merge", "marketplace"].includes(location.layout))
        problems.push(`install.${scope}.layout '${location.layout}' is not a known layout`);
      if (!profile.profiles.includes(location.profile))
        problems.push(`install.${scope} names unsupported output profile '${location.profile}'`);
      if (location.root.split(/[/\\]/).includes(".."))
        problems.push(`install.${scope}.root escapes its scope`);
      if (location.activation) {
        if (location.activation.form !== "claude-enabled-plugins")
          problems.push(`install.${scope}.activation.form is unknown`);
        if (!location.activation.file.trim())
          problems.push(`install.${scope}.activation.file is empty`);
      }
    }
  }
  return problems;
}
