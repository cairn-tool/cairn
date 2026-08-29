import type { TargetProfile } from "./schema.js";
import { PROFILE_SCHEMA_VERSION } from "./schema.js";

/**
 * OpenCode.
 *
 * Written against the `customize-opencode` skill the 1.18.23 binary embeds,
 * which is the host's own configuration reference and supersedes the
 * `@opencode-ai/plugin` types installed beside it.
 *
 * The load-bearing negative fact is that **unknown top-level keys in
 * `opencode.json` are rejected with `ConfigInvalidError` and the host refuses
 * to start**. So Cairn never writes a bundle manifest there: the plugin
 * manifest goes in `.opencode-plugin/`, a directory OpenCode does not read, the
 * same convention `.codex-plugin/` and `.cursor-plugin/` already use.
 */
export const opencodeProfile: TargetProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  id: "opencode",
  host: {
    displayName: "OpenCode",
    documentationRevision: "2026-08-29",
    minimumVersion: null,
    // `opencode --version` against the installed binary this was written from.
    verifiedThrough: "1.18.23",
    versionCommand: ["opencode", "--version"],
    nativeValidator: null,
  },
  profiles: ["plugin", "project"],
  manifest: {
    // Deliberately not `opencode.json`: an unknown key there stops the host.
    directory: ".opencode-plugin",
    file: "plugin.json",
    fields: [
      { name: "name", required: true, support: "exact" },
      { name: "version", required: true, support: "exact" },
      { name: "description", required: true, support: "exact" },
      { name: "skills", required: false, support: "exact" },
      { name: "agents", required: false, support: "exact" },
      { name: "mcpServers", required: false, support: "exact" },
    ],
    // OpenCode has no hook system to declare.
    impliedFields: ["hooks"],
  },
  paths: {
    plugin: {
      skills: "skills",
      hooks: "hooks",
      hooksFile: "hooks/hooks.json",
      agents: "agent",
      assets: "assets",
      mcp: ".mcp.json",
    },
    project: {
      // The host accepts both spellings; the plural is the one its own
      // `skills.paths` example uses.
      skills: ".opencode/skills",
      // Singular, which is the spelling its documentation lists first.
      agents: ".opencode/agent",
      rules: "AGENTS.md",
      // No policy is written; see the note below.
      policies: null,
      mcp: "opencode.json",
      assets: "assets",
    },
    namespacePluginSkills: false,
  },
  placeholders: {
    bundleRoot: { plugin: ".", project: "." },
    // `$ARGUMENTS`, `$1` and `$2` are documented for *commands*; nothing states
    // that a skill substitutes them. Advisory is correct under either reading.
    arguments: "advisory",
    rootVariables: [],
  },
  hooks: {
    // OpenCode 1.18.23 has no lifecycle hook file at all: the plugin API is
    // TypeScript callbacks in `.opencode/plugin/*.ts`, which a portable JSON
    // hook declaration cannot express. Every event is inexpressible, so hook
    // emission is skipped entirely rather than writing an inert document.
    events: {
      "session-start": null,
      "pre-tool-use": null,
      "post-tool-use": null,
      stop: null,
    },
    envelope: "hooks",
    handlerShape: "flat",
    matcherEvents: [],
    supportedProtocols: [],
  },
  models: {
    // Every model id is `provider/model-id`, so mapping a semantic class would
    // hardcode one vendor into a neutral profile.
    support: "unsupported",
    classes: { fast: null, balanced: null, capable: null, inherit: null },
  },
  tools: {
    // An exact map is knowable, but OpenCode's `tools` frontmatter is a boolean
    // map while the renderer produces an array. Declaring a mapping would emit
    // a correctly-named key of the wrong shape, which is worse than declaring
    // the restriction inexpressible.
    support: "approximate",
    capabilities: null,
  },
  rules: {
    exactActivation: ["always"],
    // `instructions` accepts globs, but not per-rule activation.
    approximateActivation: ["files"],
    form: "aggregated-agents-md",
  },
  /**
   * OpenCode does have a native command policy -- `permission.bash` in
   * `opencode.json` -- and it is deliberately not written yet.
   *
   * `paths.project.mcp` is already `opencode.json`, and both the MCP writer and
   * `renderPolicies` serialize a whole document. Two writers to one path is a
   * duplicate-path diagnostic and a clobber, and shipping a permission file
   * that silently erases the user's MCP block is worse than shipping none.
   * `PolicyForm` reserves `opencode-permission` so that adding it later, once
   * the two share a merge-aware writer, is a data edit.
   */
  policies: { form: null },
  // The skill frontmatter keys are enumerated -- name, description, license,
  // compatibility, metadata -- and none controls implicit activation.
  skills: { invocationPolicy: "advisory" },
  outputs: {
    plugin: [
      { feature: "manifest", pattern: ".opencode-plugin/plugin.json" },
      { feature: "skills", pattern: "skills/{name}/**" },
      { feature: "agents", pattern: "agent/{name}.md" },
      { feature: "mcp", pattern: ".mcp.json" },
      { feature: "assets", pattern: "assets/**" },
    ],
    project: [
      { feature: "skills", pattern: ".opencode/skills/{name}/**" },
      { feature: "agents", pattern: ".opencode/agent/{name}.md" },
      { feature: "rules", pattern: "AGENTS.md" },
      { feature: "mcp", pattern: "opencode.json" },
      { feature: "assets", pattern: "assets/**" },
    ],
  },
  features: {
    skills: {
      support: "exact",
      profiles: ["plugin", "project"],
      summary: "exact",
      surface: ".opencode/skills/<name>/SKILL.md",
      diagnostics: ["AB310"],
    },
    agents: {
      support: "approximate",
      profiles: ["plugin", "project"],
      summary: "markdown with frontmatter; tool restrictions are not expressible",
      surface: ".opencode/agent/<name>.md",
      diagnostics: ["AB330", "AB332"],
    },
    rules: {
      support: "approximate",
      profiles: ["project"],
      summary: "AGENTS.md project layer",
      surface: "AGENTS.md",
      diagnostics: ["AB350", "AB351"],
    },
    hooks: {
      support: "unsupported",
      profiles: [],
      summary: "no lifecycle hook file; plugins are TypeScript callbacks",
      surface: null,
      diagnostics: ["AB320"],
    },
    policies: {
      support: "unsupported",
      profiles: ["project"],
      summary: "native permissions share opencode.json with MCP and are not written",
      surface: null,
      diagnostics: ["AB360", "AB361"],
    },
    mcp: {
      support: "approximate",
      profiles: ["plugin", "project"],
      summary: "exact in plugins; a project document must already be opencode config shape",
      surface: "opencode.json",
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
      summary: "argument substitution is documented for commands, not skills",
      surface: null,
      diagnostics: [],
    },
    native: {
      support: "native",
      profiles: ["plugin", "project"],
      summary: "overlay pass-through",
      surface: "native/opencode/",
      diagnostics: ["AB181", "AB182", "AB187"],
    },
  },
  // No marketplace concept: `opencode plugin <module>` installs an npm package.
  install: {
    // Global scope drops the `.opencode/` prefix -- skills live at
    // `~/.config/opencode/skills/`, not `~/.config/opencode/.opencode/skills/`.
    // `InstallLocation` cannot rewrite a path, so declaring a merge here would
    // install to a directory OpenCode never scans. Same reasoning as Codex.
    user: null,
    project: { root: ".", layout: "merge", profile: "project", activation: null },
  },
};
