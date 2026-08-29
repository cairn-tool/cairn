import type { TargetProfile } from "./schema.js";
import { PROFILE_SCHEMA_VERSION } from "./schema.js";

export const codexProfile: TargetProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  id: "codex",
  host: {
    displayName: "Codex",
    documentationRevision: "2026-08-02",
    // Not recorded: no verified host range has been established for this profile.
    minimumVersion: null,
    verifiedThrough: null,
    versionCommand: ["codex", "--version"],
    nativeValidator: null,
  },
  profiles: ["plugin", "project"],
  manifest: {
    directory: ".codex-plugin",
    file: "plugin.json",
    fields: [
      { name: "name", required: true, support: "exact" },
      { name: "version", required: true, support: "exact" },
      { name: "description", required: true, support: "exact" },
      { name: "skills", required: false, support: "exact" },
      { name: "hooks", required: false, support: "exact" },
      { name: "mcpServers", required: false, support: "exact" },
    ],
  },
  paths: {
    plugin: {
      skills: "skills",
      // Codex custom agents are project-only, so the plugin manifest never
      // declares an agents root and renderAgent refuses with AB340.
      agents: null,
      hooks: "hooks",
      hooksFile: "hooks/hooks.json",
      assets: "assets",
      mcp: ".mcp.json",
    },
    project: {
      skills: ".agents/skills",
      agents: ".codex/agents",
      rules: "AGENTS.md",
      policies: ".codex/rules",
      mcp: ".codex/config.toml",
      assets: "assets",
    },
    namespacePluginSkills: false,
  },
  placeholders: {
    bundleRoot: { plugin: "${PLUGIN_ROOT}", project: "." },
    arguments: "prose",
    rootVariables: ["${PLUGIN_ROOT}"],
  },
  hooks: {
    events: {
      "session-start": "SessionStart",
      "pre-tool-use": "PreToolUse",
      "post-tool-use": "PostToolUse",
      stop: "Stop",
    },
    envelope: "hooks",
    handlerShape: "claude-nested",
    matcherEvents: [],
    supportedProtocols: ["json", "stdio-json"],
  },
  models: {
    support: "unsupported",
    classes: { fast: null, balanced: null, capable: null, inherit: null },
  },
  tools: {
    support: "approximate",
    capabilities: null,
  },
  rules: {
    exactActivation: ["always"],
    approximateActivation: ["files"],
    form: "aggregated-agents-md",
  },
  policies: { form: "codex-prefix-rules" },
  skills: { invocationPolicy: "openai-yaml" },
  marketplace: {
    catalog: {
      repo: { directory: ".codex-plugin", file: "marketplace.json" },
      local: { directory: ".codex-plugin", file: "marketplace.json" },
    },
    entriesKey: "plugins",
    entryFields: [
      { name: "name", required: true, source: { from: "manifest", field: "name" } },
      { name: "version", required: true, source: { from: "manifest", field: "version" } },
      { name: "description", required: true, source: { from: "manifest", field: "description" } },
      { name: "source", required: true, source: { from: "computed", value: "source" } },
      {
        name: "displayName",
        required: true,
        source: { from: "marketplace", field: "displayName" },
      },
      {
        name: "publisher",
        required: true,
        source: { from: "marketplace", field: "publisher" },
        transform: "name",
      },
      { name: "categories", required: true, source: { from: "marketplace", field: "categories" } },
      { name: "icon", required: true, source: { from: "marketplace", field: "icon" } },
      {
        name: "starterPrompts",
        required: false,
        source: { from: "marketplace", field: "starterPrompts" },
      },
      { name: "homepage", required: false, source: { from: "marketplace", field: "homepage" } },
      { name: "license", required: true, source: { from: "marketplace", field: "license" } },
    ],
    assets: [
      { role: "icon", required: true, extensions: [".png", ".svg"], maxBytes: 1048576 },
      { role: "screenshot", required: false, extensions: [".png", ".jpg"], maxBytes: 4194304 },
    ],
    archiveName: "{name}-{version}-{target}-{profile}.tar.gz",
  },
  outputs: {
    plugin: [
      { feature: "manifest", pattern: ".codex-plugin/plugin.json" },
      { feature: "skills", pattern: "skills/{name}/**" },
      { feature: "hooks", pattern: "hooks/**" },
      { feature: "mcp", pattern: ".mcp.json" },
      { feature: "assets", pattern: "assets/**" },
    ],
    project: [
      { feature: "skills", pattern: ".agents/skills/{name}/**" },
      { feature: "agents", pattern: ".codex/agents/{name}.toml" },
      { feature: "rules", pattern: "AGENTS.md" },
      { feature: "policies", pattern: ".codex/rules/bundle.rules" },
      { feature: "mcp", pattern: ".codex/config.toml" },
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
      support: "approximate",
      profiles: ["project"],
      summary: "project only",
      surface: ".codex/agents/<name>.toml",
      diagnostics: ["AB330", "AB332", "AB340"],
    },
    rules: {
      support: "approximate",
      profiles: ["project"],
      summary: "AGENTS.md project layer",
      surface: "AGENTS.md",
      diagnostics: ["AB350", "AB351"],
    },
    hooks: {
      support: "exact",
      profiles: ["plugin"],
      summary: "portable events",
      surface: "hooks/hooks.json",
      diagnostics: ["AB320", "AB321", "AB322"],
    },
    policies: {
      support: "approximate",
      profiles: ["project"],
      summary: "project rules",
      surface: ".codex/rules/bundle.rules",
      diagnostics: ["AB360"],
    },
    mcp: {
      support: "approximate",
      profiles: ["plugin", "project"],
      summary: "exact in plugins; project requires target-supplied TOML",
      surface: ".mcp.json",
      diagnostics: ["AB370"],
    },
    assets: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "exact",
      surface: "assets/",
      diagnostics: [],
    },
    placeholders: {
      support: "approximate",
      profiles: ["plugin", "project"],
      summary: "no argument substitution; explanatory prose is emitted",
      surface: "${PLUGIN_ROOT}",
      diagnostics: ["AB302"],
    },
    native: {
      support: "native",
      profiles: ["plugin", "project"],
      summary: "target-only files passed through from native/codex/",
      surface: "native/codex/",
      diagnostics: ["AB181", "AB182", "AB187"],
    },
  },
  install: {
    // Codex's project rules root is AGENTS.md. A user-scope merge would
    // clobber ~/AGENTS.md, so there is no recorded user location.
    user: null,
    project: {
      root: ".",
      layout: "merge",
      profile: "project",
      activation: null,
    },
  },
};
