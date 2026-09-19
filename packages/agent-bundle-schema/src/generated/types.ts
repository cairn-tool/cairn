/*
 * GENERATED FILE -- do not edit.
 *
 * Produced from spec/v1 by `npm run codegen`. Edit the spec, then regenerate;
 * `npm run codegen:check` fails CI when the two have drifted.
 */
/**
 * Either of the agent bundle documentation artifacts, discriminated by `kind`.
 */
export type AgentBundleArtifact = InlineAgentBundleArtifact | InstallableAgentBundlesArtifact;

/**
 * The agent bundle a repository installs into itself: the components it carries and what they render to on every supported host. "Inline" is the `project` output profile, whose files are merged into the repository's own dot-directories rather than installed as a self-contained plugin. A repository has at most one, so this artifact documents exactly one bundle; the bundles a repository publishes for others are documented by installable-agent-bundles.json instead. Produced by `cairn agent docs`. Specified by docs/formats/inline-agent-bundle.md. This $id is an identifier, not a fetchable URL. No schema here sets additionalProperties: false -- adding a property is a non-breaking change. Composed from spec/v1 by `npm run codegen` -- do not edit. The shared definitions live in spec/v1/_common.json.
 */
export interface InlineAgentBundleArtifact {
  kind: "inline-agent-bundle";
  /**
   * Semantic version of this payload format. A consumer accepts a higher patch or minor and rejects a higher major.
   */
  schemaVersion: string;
  /**
   * The slug this artifact publishes under. Defaults to the bundle name.
   */
  id: string;
  /**
   * The human label used in navigation.
   */
  title: string;
  /**
   * RFC 3339, UTC.
   */
  generatedAt: string;
  generator: ArtifactGenerator;
  bundle: DocumentedBundle;
}
/**
 * The tool that produced the artifact.
 */
export interface ArtifactGenerator {
  /**
   * npm package name of the generating tool.
   */
  name: string;
  /**
   * Version of the generating tool.
   */
  version: string;
}
/**
 * One agent bundle, normalized from its `agent-bundle.yaml` and rendered for every host it supports.
 */
export interface DocumentedBundle {
  /**
   * Bundle name: lowercase kebab-case, and the prefix another bundle references it by.
   */
  name: string;
  /**
   * Bundle version, as the manifest spells it.
   */
  version: string;
  description: string;
  /**
   * The `schemaVersion` of the source `agent-bundle.yaml`, which versions the format authors write and is unrelated to this artifact's `schemaVersion`.
   */
  manifestSchemaVersion: string;
  /**
   * True when the source is a native plugin read through `.claude-plugin/plugin.json` rather than an `agent-bundle.yaml`.
   */
  legacy: boolean;
  /**
   * Path to the bundle root, relative to the repository or collection root.
   */
  source?: string;
  marketplace?: MarketplaceListing;
  components: DocumentedComponents;
  /**
   * Which components reference which skills, keyed by referencing component name.
   */
  graph: {
    [k: string]: string[];
  };
  dependencies: DocumentedDependency[];
  /**
   * One entry per host and output profile the bundle renders into.
   */
  targets: TargetRender[];
  diagnostics: BundleDiagnostic[];
}
/**
 * Listing metadata from the bundle manifest's `marketplace:` block. Structure is validated by the parser; whether it is complete enough to publish is `agent package`'s question, so a half-filled block still appears here.
 */
export interface MarketplaceListing {
  /**
   * Human label, preferred over the bundle name in a listing.
   */
  displayName?: string;
  /**
   * One-line description for a catalog row.
   */
  summary?: string;
  /**
   * Long-form description for a listing page.
   */
  description?: string;
  categories: string[];
  keywords: string[];
  publisher?: BundlePublisher;
  homepage?: string;
  repository?: string;
  /**
   * SPDX identifier, as the manifest spells it.
   */
  license?: string;
  /**
   * Bundle-relative POSIX path to the icon asset.
   */
  icon?: string;
  /**
   * Bundle-relative POSIX paths.
   */
  screenshots: string[];
  starterPrompts: StarterPrompt[];
  legal?: MarketplaceLegal;
}
/**
 * Who publishes a bundle or a collection.
 */
export interface BundlePublisher {
  name: string;
  url?: string;
  email?: string;
}
/**
 * A suggested opening prompt a host may offer for the bundle.
 */
export interface StarterPrompt {
  title: string;
  prompt: string;
}
export interface MarketplaceLegal {
  privacyPolicy?: string;
  termsOfService?: string;
}
/**
 * Everything the bundle carries, by component kind. `hooks` is the hook configuration document and `mcp` the MCP server configuration document. A kind no selected target emits into a selected profile is omitted rather than shown empty -- which is why `hooks` is absent from a project-profile render: hooks are plugin-profile only on every target.
 */
export interface DocumentedComponents {
  skills?: DocumentedComponent[];
  /**
   * Subagents.
   */
  agents?: DocumentedComponent[];
  rules?: DocumentedRule[];
  hooks?: BundleJsonDocument;
  /**
   * Bundle-relative POSIX paths of executables the hook configuration invokes.
   */
  hookFiles?: string[];
  policies?: BundleJsonDocument[];
  mcp?: BundleJsonDocument;
  /**
   * Bundle-relative POSIX paths.
   */
  assets?: string[];
}
/**
 * A skill or subagent, as authored. `body` is the Markdown beneath the frontmatter, carried verbatim so a documentation site can render the component without reading the bundle.
 */
export interface DocumentedComponent {
  /**
   * Component name: lowercase kebab-case.
   */
  name: string;
  /**
   * The `description` frontmatter field, which is what a host matches a request against.
   */
  description: string;
  /**
   * Bundle-relative POSIX path to the source file.
   */
  source: string;
  /**
   * Frontmatter fields other than `name` and `description`, exactly as parsed.
   */
  metadata: {
    [k: string]: unknown;
  };
  /**
   * Markdown body beneath the frontmatter, verbatim and unrendered.
   */
  body: string;
  /**
   * Bundle-relative POSIX paths of files bundled alongside the component, such as a skill's references or scripts.
   */
  files?: string[];
}
/**
 * A rule: a component plus how a host decides to apply it.
 */
export interface DocumentedRule {
  name: string;
  description: string;
  source: string;
  metadata: {
    [k: string]: unknown;
  };
  body: string;
  files?: string[];
  /**
   * When the rule applies: unconditionally, on a path match against `globs`, at the model's discretion, or only when named.
   */
  activation: "always" | "files" | "model" | "manual";
  /**
   * Path patterns the rule applies to. Meaningful only when `activation` is `files`.
   */
  globs: string[];
}
/**
 * A JSON configuration document carried by the bundle, with the path it was read from.
 */
export interface BundleJsonDocument {
  /**
   * Bundle-relative POSIX path.
   */
  path: string;
  /**
   * The document, parsed.
   */
  value: {
    [k: string]: unknown;
  };
}
/**
 * A bundle this one may name components in, through a `bundle/name` reference. Resolution is one level deep and never transitive.
 */
export interface DocumentedDependency {
  /**
   * The dependency's bundle name, which is also the reference prefix.
   */
  name: string;
  /**
   * Skill names the dependency defines.
   */
  skills: string[];
  /**
   * Subagent names the dependency defines.
   */
  agents: string[];
}
/**
 * What the bundle produces for one host, in one output profile. `profile: "project"` is the inline form, merged into a repository's own dot-directories; `profile: "plugin"` is the installable form, a self-contained directory with its own manifest.
 */
export interface TargetRender {
  /**
   * The host this render is for.
   */
  target: "claude-code" | "codex" | "cursor" | "antigravity" | "opencode";
  /**
   * The output profile. `project` is inline; `plugin` is installable.
   */
  profile: "plugin" | "project";
  artifacts: RenderedArtifact[];
}
/**
 * One file the bundle renders into, described but not carried. Content is deliberately omitted: the artifact documents the shape of an installation, not a copy of it.
 */
export interface RenderedArtifact {
  /**
   * POSIX path relative to the target and profile root.
   */
  path: string;
  bytes: number;
  /**
   * Octal file mode, e.g. '0644'.
   */
  mode: string;
  /**
   * Emitted only for artifacts contributed by a target-native overlay. Absent means portable.
   */
  origin?: "portable" | "native";
}
/**
 * A finding raised while parsing or rendering the bundle. Codes are documented in docs/formats/diagnostic-codes.md.
 */
export interface BundleDiagnostic {
  /**
   * An `AB###` diagnostic code.
   */
  code: string;
  severity: "notice" | "warning" | "error";
  message: string;
  /**
   * The component the finding is about, when it is about one.
   */
  component?: string;
  path?: string;
  target?: "claude-code" | "codex" | "cursor" | "antigravity" | "opencode";
  profile?: "plugin" | "project";
  /**
   * How faithfully the source maps to the host: an `approximate` mapping reaches the host in a changed form, an `unsupported` one does not reach it at all.
   */
  quality: "exact" | "approximate" | "unsupported";
  /**
   * What an author can do about it.
   */
  remediation?: string;
}
/**
 * Every agent bundle a repository publishes for others to install, in one document. "Installable" is the `plugin` output profile, a self-contained directory with its own manifest that a host discovers through a marketplace or plugin directory rather than by merging files into a project. The set of bundles and the hosts they are built for come from the repository's `agent-marketplace.yaml`. Produced by `cairn agent collection-docs`. Specified by docs/formats/installable-agent-bundles.md. This $id is an identifier, not a fetchable URL. No schema here sets additionalProperties: false -- adding a property is a non-breaking change. Composed from spec/v1 by `npm run codegen` -- do not edit. The shared definitions live in spec/v1/_common.json.
 */
export interface InstallableAgentBundlesArtifact {
  kind: "installable-agent-bundles";
  /**
   * Semantic version of this payload format. A consumer accepts a higher patch or minor and rejects a higher major.
   */
  schemaVersion: string;
  /**
   * The slug this artifact publishes under. Defaults to the collection name.
   */
  id: string;
  /**
   * The human label used in navigation.
   */
  title: string;
  /**
   * RFC 3339, UTC.
   */
  generatedAt: string;
  generator: ArtifactGenerator;
  marketplace: DocumentedCollection;
  /**
   * Every bundle the collection publishes, in the order the spec lists them.
   */
  bundles: DocumentedBundle[];
  /**
   * Findings raised against the collection spec itself, as distinct from those raised against an individual bundle.
   */
  diagnostics?: BundleDiagnostic[];
}
/**
 * The collection the bundles are offered through, from `agent-marketplace.yaml`.
 */
export interface DocumentedCollection {
  /**
   * Collection name, which is also the marketplace key a host registers it under.
   */
  name: string;
  version: string;
  description?: string;
  owner: BundlePublisher;
  /**
   * Hosts the collection is built for. A bundle may narrow this further with its own include or exclude list.
   */
  targets: ("claude-code" | "codex" | "cursor" | "antigravity" | "opencode")[];
}
