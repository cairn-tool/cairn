import type { TargetProfile } from "./schema.js";
import { PROFILE_SCHEMA_VERSION } from "./schema.js";

export const claudeCodeProfile: TargetProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  id: "claude-code",
  host: {
    displayName: "Claude Code",
    documentationRevision: "2026-08-02",
    // Not recorded: no verified host range has been established for this profile.
    // Filling these in later is a data edit, not a code change.
    minimumVersion: null,
    verifiedThrough: null,
    versionCommand: ["claude", "--version"],
    nativeValidator: null,
  },
  profiles: ["plugin", "project"],
  manifest: {
    directory: ".claude-plugin",
    file: "plugin.json",
    fields: [
      { name: "name", required: true, support: "exact" },
      { name: "version", required: true, support: "exact" },
      { name: "description", required: true, support: "exact" },
      { name: "skills", required: false, support: "exact" },
      { name: "agents", required: false, support: "exact" },
      { name: "hooks", required: false, support: "exact" },
      { name: "mcpServers", required: false, support: "exact" },
    ],
    impliedFields: ["agents", "hooks"],
  },
  paths: {
    plugin: {
      skills: "skills",
      agents: "agents",
      hooks: "hooks",
      hooksFile: "hooks/hooks.json",
      assets: "assets",
      mcp: ".mcp.json",
    },
    project: {
      skills: ".claude/skills",
      agents: ".claude/agents",
      rules: ".claude/rules",
      policies: ".claude/settings.json",
      mcp: ".mcp.json",
      assets: "assets",
    },
    namespacePluginSkills: false,
  },
  placeholders: {
    bundleRoot: { plugin: "${CLAUDE_PLUGIN_ROOT}", project: "${CLAUDE_PROJECT_DIR}" },
    arguments: "native",
    rootVariables: ["${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PROJECT_DIR}", "${CLAUDE_SKILL_DIR}"],
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
    support: "exact",
    classes: { fast: "haiku", balanced: "sonnet", capable: "opus", inherit: "inherit" },
  },
  tools: {
    support: "exact",
    capabilities: {
      read: ["Read", "Glob", "Grep"],
      write: ["Write", "Edit"],
      shell: ["Bash"],
      web: ["WebFetch", "WebSearch"],
    },
  },
  rules: {
    exactActivation: ["always", "files"],
    approximateActivation: [],
    form: "markdown",
  },
  policies: { form: "claude-permissions" },
  skills: { invocationPolicy: "frontmatter-flag" },
  marketplace: {
    catalog: {
      repo: { directory: ".claude-plugin", file: "marketplace.json" },
      local: { directory: ".claude-plugin", file: "marketplace.json" },
    },
    entriesKey: "plugins",
    // Claude Code rejects a catalog with no `name`, and enforces that it match
    // the `extraKnownMarketplaces` key — which `agent install` derives from the
    // bundle name, so sourcing it from the manifest keeps the two in step.
    documentFields: [
      { name: "name", required: true, source: { from: "manifest", field: "name" } },
      { name: "description", required: false, source: { from: "manifest", field: "description" } },
      { name: "owner", required: true, source: { from: "marketplace", field: "publisher" } },
    ],
    entryFields: [
      { name: "name", required: true, source: { from: "manifest", field: "name" } },
      { name: "version", required: true, source: { from: "manifest", field: "version" } },
      { name: "description", required: true, source: { from: "manifest", field: "description" } },
      { name: "source", required: true, source: { from: "computed", value: "source" } },
      // An object, unlike Cursor's bare name.
      { name: "author", required: false, source: { from: "marketplace", field: "publisher" } },
      // Singular: one category, not the bundle's whole list.
      {
        name: "category",
        required: false,
        source: { from: "marketplace", field: "categories" },
        transform: "first",
      },
      { name: "license", required: false, source: { from: "marketplace", field: "license" } },
    ],
    assets: [
      { role: "icon", required: false, extensions: [".png", ".svg"], maxBytes: 1048576 },
      { role: "screenshot", required: false, extensions: [".png", ".jpg"], maxBytes: 4194304 },
    ],
    archiveName: "{name}-{version}-{target}-{profile}.tar.gz",
  },
  outputs: {
    plugin: [
      { feature: "manifest", pattern: ".claude-plugin/plugin.json" },
      { feature: "skills", pattern: "skills/{name}/**" },
      { feature: "agents", pattern: "agents/{name}.md" },
      { feature: "hooks", pattern: "hooks/**" },
      { feature: "mcp", pattern: ".mcp.json" },
      { feature: "assets", pattern: "assets/**" },
    ],
    project: [
      { feature: "skills", pattern: ".claude/skills/{name}/**" },
      { feature: "agents", pattern: ".claude/agents/{name}.md" },
      { feature: "rules", pattern: ".claude/rules/{name}.md" },
      { feature: "policies", pattern: ".claude/settings.json" },
      { feature: "mcp", pattern: ".mcp.json" },
      { feature: "assets", pattern: "assets/**" },
    ],
  },
  features: {
    skills: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "exact",
      surface: "skills/<name>/SKILL.md",
      diagnostics: [],
    },
    agents: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "exact",
      surface: "agents/<name>.md",
      diagnostics: ["AB330", "AB331"],
    },
    rules: {
      support: "exact",
      profiles: ["project"],
      summary: "project",
      surface: ".claude/rules/<name>.md",
      diagnostics: ["AB350", "AB351"],
    },
    hooks: {
      support: "exact",
      profiles: ["plugin"],
      summary: "exact for portable events",
      surface: "hooks/hooks.json",
      diagnostics: ["AB320", "AB321", "AB322"],
    },
    policies: {
      support: "approximate",
      profiles: ["project"],
      summary: "project permissions",
      surface: ".claude/settings.json",
      diagnostics: ["AB360"],
    },
    mcp: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "exact",
      surface: ".mcp.json",
      diagnostics: [],
    },
    assets: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "exact",
      surface: "assets/",
      diagnostics: [],
    },
    placeholders: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "native root and argument substitution",
      surface: "${CLAUDE_PLUGIN_ROOT}",
      diagnostics: [],
    },
    native: {
      support: "native",
      profiles: ["plugin", "project"],
      summary: "target-only files passed through from native/claude-code/",
      surface: "native/claude-code/",
      diagnostics: ["AB181", "AB182", "AB187"],
    },
  },
  install: {
    user: {
      root: "~/.claude/plugins/marketplaces",
      layout: "marketplace",
      profile: "plugin",
      activation: { file: "~/.claude/settings.json", form: "claude-enabled-plugins" },
    },
    project: {
      root: ".",
      layout: "merge",
      profile: "project",
      activation: null,
    },
  },
};
