import type { TargetProfile } from "./schema.js";
import { PROFILE_SCHEMA_VERSION } from "./schema.js";

/**
 * Google Antigravity (`agy`).
 *
 * Written against the host's own embedded documentation, which ships inside the
 * `agy` binary and is therefore first-party rather than reconstructed: the
 * Customization System Guide, the Lifecycle Hooks guide, the Plugins guide, and
 * the JSON Configurations guide. Where a row below could not be established
 * from those, it is declared at the honest support level rather than guessed
 * at, and `docs/providers/antigravity/agent-bundles.md` lists every one.
 *
 * Do not confuse this host with Gemini CLI. Both keep state under `~/.gemini`
 * and they share nothing else — Gemini CLI's hooks live in
 * `~/.gemini/settings.json` under `BeforeAgent`/`AfterAgent`/`BeforeTool`/
 * `AfterTool`, one nesting level deeper and under different names.
 */
export const antigravityProfile: TargetProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  id: "antigravity",
  host: {
    displayName: "Antigravity",
    documentationRevision: "2026-08-29",
    minimumVersion: null,
    // `agy --version` against the installed binary this profile was written from.
    verifiedThrough: "1.1.18",
    versionCommand: ["agy", "--version"],
    nativeValidator: null,
  },
  profiles: ["plugin", "project"],
  manifest: {
    // `plugin.json` sits at the plugin root; there is no manifest directory.
    directory: null,
    file: "plugin.json",
    fields: [
      // Optional to the host, which falls back to the directory name — but the
      // renderer always writes it, since a rendered tree should not depend on
      // where it was unpacked.
      { name: "name", required: false, support: "exact" },
      { name: "disabled", required: false, support: "exact" },
    ],
    // Antigravity ingests everything in the plugin's directory structure
    // automatically; `plugin.json` is a marker, not an index. Declaring these
    // keys would add fields the host does not read.
    impliedFields: ["skills", "agents", "hooks", "mcpServers"],
  },
  paths: {
    plugin: {
      skills: "skills",
      hooks: "hooks",
      // At the plugin root, not under `hooks/`. Hook commands run with the
      // working directory set to the directory containing `hooks.json`, so a
      // handler naming `./hooks/guard.sh` resolves from the plugin root.
      hooksFile: "hooks.json",
      // A plugin carries skills, rules, hooks and MCP config, and no agents
      // directory at all, so renderAgent refuses with AB340.
      agents: null,
      assets: "assets",
      mcp: "mcp_config.json",
    },
    project: {
      skills: ".agents/skills",
      // Not emitted: the workspace subagent layout could not be established.
      agents: null,
      rules: ".agents/rules",
      // No native command-policy format is documented.
      policies: null,
      mcp: ".agents/mcp_config.json",
      assets: "assets",
    },
    namespacePluginSkills: false,
  },
  placeholders: {
    bundleRoot: { plugin: ".", project: "." },
    // No documented argument substitution in a skill, so `$ARGUMENTS` is
    // replaced by explanatory text and AB302 reports it.
    arguments: "prose",
    rootVariables: [],
  },
  hooks: {
    events: {
      // `hooks.json` has no session-start event. The binary carries a
      // `SessionStartHookArgs` message, but it belongs to built-in and SDK
      // hooks rather than to anything the file format can declare.
      "session-start": null,
      "pre-tool-use": "PreToolUse",
      "post-tool-use": "PostToolUse",
      stop: "Stop",
    },
    // The document is a map of hook *name* to its events, so several sets can
    // merge and any one of them can be switched off wholesale.
    envelope: "named",
    handlerShape: "nested-for-matcher-events",
    // Only the tool events take a matcher; the rest are a bare handler list.
    matcherEvents: ["pre-tool-use", "post-tool-use"],
    supportedProtocols: ["json", "stdio-json"],
  },
  models: {
    // The model is a session-wide setting in `settings.json`; no per-component
    // model field is documented.
    support: "unsupported",
    classes: { fast: null, balanced: null, capable: null, inherit: null },
  },
  tools: {
    // Permissions are global allow/deny/ask rules rather than a per-component
    // allowlist, so a capability restriction cannot be expressed exactly.
    support: "approximate",
    capabilities: null,
  },
  rules: {
    exactActivation: ["always", "model"],
    approximateActivation: ["files", "manual"],
    form: "trigger-frontmatter",
  },
  // No native command-policy format is documented, so a policy is reported
  // rather than approximated into prose that is not a security boundary.
  policies: { form: null },
  // Nothing in the skill frontmatter controls implicit activation.
  skills: { invocationPolicy: "advisory" },
  outputs: {
    plugin: [
      { feature: "manifest", pattern: "plugin.json" },
      { feature: "skills", pattern: "skills/{name}/**" },
      { feature: "hooks", pattern: "hooks.json" },
      { feature: "hooks", pattern: "hooks/**" },
      { feature: "mcp", pattern: "mcp_config.json" },
      { feature: "assets", pattern: "assets/**" },
    ],
    project: [
      { feature: "skills", pattern: ".agents/skills/{name}/**" },
      { feature: "rules", pattern: ".agents/rules/{name}.md" },
      { feature: "mcp", pattern: ".agents/mcp_config.json" },
      { feature: "assets", pattern: "assets/**" },
    ],
  },
  features: {
    skills: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "exact",
      surface: "skills/<name>/SKILL.md",
      diagnostics: ["AB310"],
    },
    agents: {
      // Not "unsupported": renderAgent maps the model and tools before it
      // reaches the AB340 gate, so AB330 and AB332 can still be emitted, and a
      // diagnostic may never outrank its declared support.
      support: "approximate",
      profiles: [],
      summary: "not emitted; the native subagent layout is unconfirmed",
      surface: null,
      diagnostics: ["AB330", "AB332", "AB340"],
    },
    rules: {
      support: "approximate",
      profiles: ["project"],
      summary: "trigger frontmatter in .agents/rules",
      surface: ".agents/rules/<name>.md",
      diagnostics: ["AB350", "AB351"],
    },
    hooks: {
      support: "approximate",
      profiles: ["plugin"],
      summary: "no session-start event",
      surface: "hooks.json",
      diagnostics: ["AB320", "AB321", "AB322"],
    },
    policies: {
      support: "unsupported",
      profiles: ["project"],
      summary: "no native command-policy format",
      surface: null,
      diagnostics: ["AB360", "AB361"],
    },
    mcp: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "mcp_config.json",
      surface: "mcp_config.json",
      diagnostics: [],
    },
    assets: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "pass-through",
      surface: "assets/",
      diagnostics: [],
    },
    placeholders: {
      support: "approximate",
      profiles: ["plugin", "project"],
      summary: "no argument substitution",
      surface: null,
      diagnostics: ["AB302"],
    },
    native: {
      support: "native",
      profiles: ["plugin", "project"],
      summary: "overlay pass-through",
      surface: "native/antigravity/",
      diagnostics: ["AB181", "AB182", "AB187"],
    },
  },
  // No marketplace spec: `agy plugin install <plugin>@<marketplace>` exists, but
  // neither the catalog filename nor its entry schema could be established, and
  // `agent package` skips a target with no spec rather than inventing one.
  install: {
    // Most discovered plugins are enabled by default, so dropping a plugin
    // directory into the global customization root needs no activation edit.
    user: {
      root: "~/.gemini/config/plugins",
      layout: "plugin-dir",
      profile: "plugin",
      activation: null,
    },
    project: { root: ".", layout: "merge", profile: "project", activation: null },
  },
};
