import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type {
  AgentBundle,
  AgentDiagnostic,
  AgentProfile,
  AgentTarget,
  Artifact,
  MarkdownComponent,
} from "./types.js";
import { diagnostic } from "./types.js";
import { applyConditionals } from "./conditionals.js";
import type { RefResolver } from "./conditionals.js";
import { emittedName, referenceIdentifier } from "./naming.js";
import type { ModelClass } from "./targets/index.js";
import type { ReferenceKind } from "./targets/schema.js";
import { HOOK_EVENT_ALIASES, nativeHookEvent, profileFor } from "./targets/index.js";
import { applyOverlayManifest, mergeOverlay, overlayArtifacts } from "./overlays.js";
import { configuredPath } from "./manifest.js";

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n");
}

function yamlFrontmatter(metadata: Record<string, unknown>, body: string): string {
  const keys = Object.keys(metadata).filter((key) => metadata[key] !== undefined);
  return keys.length
    ? `---\n${stringifyYaml(Object.fromEntries(keys.map((key) => [key, metadata[key]])), { lineWidth: 0, indentSeq: false }).trim()}\n---\n${body}`
    : body;
}

/**
 * Resolves target-conditional regions and inline component references. Kept as a
 * named export because it is the seam the unit tests reach for; the grammar
 * itself lives in `./conditionals.js`, shared with the parser's validator so the
 * two cannot disagree about what a document means.
 *
 * Omitting `resolve` leaves reference markers verbatim, which is what a caller
 * that only wants conditional regions resolved should get.
 */
export function processTargetBlocks(
  content: string,
  target: AgentTarget,
  options: { markdown?: boolean; resolve?: RefResolver } = {},
): string {
  return applyConditionals(content, target, options);
}

function targetOverride(
  component: MarkdownComponent,
  target: AgentTarget,
): Record<string, unknown> {
  const targets = component.metadata.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return {};
  const override = (targets as Record<string, unknown>)[target];
  return override && typeof override === "object" && !Array.isArray(override)
    ? (override as Record<string, unknown>)
    : {};
}

/**
 * Whether a component reaches a target at all.
 *
 * Exported so `agent inspect --target` filters on exactly the predicate the
 * renderer uses; a reimplementation would eventually disagree with `convert`
 * about which components exist.
 */
export function selected(component: MarkdownComponent, target: AgentTarget): boolean {
  const override = targetOverride(component, target);
  const include = component.metadata.include;
  const exclude = component.metadata.exclude;
  if (override.enabled === false || override.exclude === true) return false;
  if (Array.isArray(include) && !include.map(String).includes(target)) return false;
  return !(Array.isArray(exclude) && exclude.map(String).includes(target));
}

/** OS-native relative path to the POSIX spelling every artifact path uses. */
function posix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * The assets `marketplace:` claims, as paths relative to the configured assets
 * root, for a profile that must not carry them.
 *
 * `marketplace.icon` and `marketplace.screenshots` are written bundle-relative,
 * so matching them against a loaded asset means re-resolving the same root the
 * parser read them from -- a bundle may configure one, and `assets` is only the
 * default. Returns an empty set for the plugin profile, which is the profile a
 * catalog is built from and so the one that has to ship them.
 */
function marketplaceAssetPaths(bundle: AgentBundle, profile: AgentProfile): Set<string> {
  if (profile === "plugin" || !bundle.marketplace) return new Set();
  const root = posix(configuredPath(bundle.manifest, "assets", "assets"))
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const declared = [bundle.marketplace.icon, ...bundle.marketplace.screenshots].filter(
    (reference): reference is string => typeof reference === "string",
  );
  const withheld = new Set<string>();
  for (const reference of declared) {
    const normalized = posix(reference).replace(/^\.\//, "");
    // A reference outside the assets root names nothing this loop can emit.
    if (root && normalized.startsWith(`${root}/`)) withheld.add(normalized.slice(root.length + 1));
    else if (!root) withheld.add(normalized);
  }
  return withheld;
}

function rewritePlaceholders(
  content: string,
  target: AgentTarget,
  kind: "skill" | "other",
  diagnostics: AgentDiagnostic[],
  component?: MarkdownComponent,
  profile: AgentProfile = "plugin",
): string {
  const targetProfile = profileFor(target);
  const hadArguments = /\$ARGUMENTS|\$\{ARGUMENTS\}|\{\{arguments\}\}/.test(content);
  content = content.replace(/\$\{ARGUMENTS\}|\{\{arguments\}\}/g, "$ARGUMENTS");
  const nativeRoot = targetProfile.placeholders.bundleRoot[profile];
  content = content.replace(/\$\{BUNDLE_ROOT\}|\{\{bundleRoot\}\}/g, nativeRoot);
  content = content.replace(/\$\{SKILL_DIR\}|\{\{skillDir\}\}/g, "${CLAUDE_SKILL_DIR}");
  if (target === "claude-code")
    return profile === "project"
      ? content.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, "${CLAUDE_PROJECT_DIR}")
      : content;
  if (target === "codex")
    content = content.replace(
      /\$\{CLAUDE_PLUGIN_ROOT\}/g,
      profile === "plugin" ? "${PLUGIN_ROOT}" : ".",
    );
  content = content
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, "./")
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ".");
  content = content
    .replace(/\$\{CLAUDE_SKILL_DIR\}\//g, "")
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, ".");
  if (
    hadArguments &&
    kind === "skill" &&
    targetProfile.placeholders.arguments === "advisory" &&
    !content.includes("If the above shows literal `$ARGUMENTS`")
  ) {
    const lines = content.split("\n");
    const index = lines.findIndex(
      (line) => line.includes("$ARGUMENTS") && !line.includes("`$ARGUMENTS`"),
    );
    if (index >= 0)
      lines.splice(
        index + 1,
        0,
        "",
        "> If the above shows literal `$ARGUMENTS`, extract the argument from the user's message.",
      );
    content = lines.join("\n");
  }
  if (hadArguments && targetProfile.placeholders.arguments === "prose") {
    content = content.replace(/\$ARGUMENTS/g, "the invocation arguments from the user's message");
    diagnostics.push(
      diagnostic(
        "AB302",
        `${target} has no portable $ARGUMENTS substitution; emitted explanatory text`,
        "approximate",
        {
          component: component?.name,
          path: component?.path,
          target,
          remediation: `Provide targets.${target} instructions when exact argument handling matters.`,
        },
      ),
    );
  }
  return content;
}

function metadataFor(
  component: MarkdownComponent,
  target: AgentTarget,
  kind: "skill" | "agent" | "other" = "other",
  context?: { profile: AgentProfile; bundleName: string; resolve?: RefResolver },
): Record<string, unknown> {
  const result = { ...component.metadata, ...targetOverride(component, target) };
  for (const key of [
    "targets",
    "include",
    "exclude",
    "enabled",
    "activation",
    "globs",
    "invocationPolicy",
    "invocation",
    "arguments",
    "argumentHint",
    "modelClass",
  ])
    delete result[key];
  // A mapping-form resource was authored as a path outside the component; what
  // the host can actually open is where it landed. Frontmatter is never
  // placeholder-rewritten, so an authored `../../shared/x.md` would otherwise
  // ship verbatim to a tree that has no such path.
  if (Array.isArray(result.resources))
    result.resources = result.resources.map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const mapping = entry as Record<string, unknown>;
      if (typeof mapping.as === "string" && mapping.as.trim()) return mapping.as.trim();
      if (typeof mapping.path === "string") return mapping.path.split("/").pop() ?? mapping.path;
      return entry;
    });
  if (context && kind !== "other" && typeof result.name === "string")
    result.name = emittedName(kind, result.name, target, context.profile, context.bundleName);
  // `description` and `argumentHint` are prose a host shows a person, so a
  // reference in one has to resolve like a reference in the body. `name` never
  // does -- it *is* the identity, so a reference there would be circular -- and
  // neither does `skills`, which is the portable resolution mechanism `AB150`
  // validates and Cursor's agent inlining consumes.
  if (context?.resolve)
    for (const key of ["description", "argumentHint", "argument-hint"] as const) {
      const value = result[key];
      if (typeof value === "string")
        result[key] = applyConditionals(value, target, {
          markdown: false,
          resolve: context.resolve,
        });
    }
  return result;
}

function transformMarkdown(
  component: MarkdownComponent,
  target: AgentTarget,
  diagnostics: AgentDiagnostic[],
  kind: "skill" | "other" = "other",
  profile: AgentProfile = "plugin",
  bundleName = "",
  resolve?: RefResolver,
): string {
  const override = targetOverride(component, target);
  const body = typeof override.instructions === "string" ? override.instructions : component.body;
  return yamlFrontmatter(
    metadataFor(component, target, kind === "skill" ? "skill" : "other", {
      profile,
      bundleName,
      resolve,
    }),
    rewritePlaceholders(
      processTargetBlocks(body, target, { resolve }),
      target,
      kind,
      diagnostics,
      component,
      profile,
    ),
  );
}

function copyComponentFiles(
  component: MarkdownComponent,
  base: string,
  target: AgentTarget,
  diagnostics: AgentDiagnostic[],
  artifacts: Artifact[],
  profile: AgentProfile,
  resolve?: RefResolver,
): void {
  for (const file of component.files) {
    if (file.path === "SKILL.md") continue;
    const markdown = file.path.endsWith(".md");
    const content = markdown
      ? Buffer.from(
          rewritePlaceholders(
            processTargetBlocks(file.content.toString("utf8"), target, { resolve }),
            target,
            "other",
            diagnostics,
            component,
            profile,
          ),
        )
      : file.content;
    artifacts.push({
      path: path.posix.join(base, file.path.split(path.sep).join("/")),
      content,
      mode: file.mode,
    });
  }
}

function transformedHooks(
  bundle: AgentBundle,
  target: AgentTarget,
  profile: AgentProfile,
  diagnostics: AgentDiagnostic[],
): Record<string, unknown> | undefined {
  if (!bundle.hooks) return undefined;
  const root = bundle.hooks.value;
  const overrides =
    root.targets && typeof root.targets === "object" && !Array.isArray(root.targets)
      ? (root.targets as Record<string, unknown>)[target]
      : undefined;
  const override =
    overrides && typeof overrides === "object" && !Array.isArray(overrides)
      ? (overrides as Record<string, unknown>)
      : {};
  const base =
    root.hooks && typeof root.hooks === "object"
      ? (root.hooks as Record<string, unknown>)
      : root.events && typeof root.events === "object"
        ? (root.events as Record<string, unknown>)
        : Object.fromEntries(Object.entries(root).filter(([key]) => key !== "targets"));
  const overrideEvents =
    override.hooks && typeof override.hooks === "object"
      ? (override.hooks as Record<string, unknown>)
      : override.events && typeof override.events === "object"
        ? (override.events as Record<string, unknown>)
        : override;
  const source = { ...base, ...overrideEvents };
  const hooks: Record<string, unknown> = {};
  for (const [rawEvent, handlers] of Object.entries(source)) {
    const neutral = HOOK_EVENT_ALIASES[rawEvent] ?? rawEvent;
    const targetName = nativeHookEvent(target, neutral);
    if (!targetName) {
      const manifestOverrides = bundle.manifest.targets as Record<string, unknown> | undefined;
      const hasOverride = Boolean(manifestOverrides?.[target]) || Object.keys(override).length > 0;
      if (!hasOverride)
        diagnostics.push(
          diagnostic(
            "AB320",
            `Hook event '${rawEvent}' is not portable to ${target}`,
            "unsupported",
            {
              path: bundle.hooks.path,
              target,
              profile,
              remediation: `Add a targets.${target} hook override.`,
            },
          ),
        );
      continue;
    }
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "string")
        return rewritePlaceholders(value, target, "other", diagnostics, undefined, profile);
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, child]) => [
            key,
            rewrite(child),
          ]),
        );
      return value;
    };
    const normalizeHandlers = (value: unknown): unknown => {
      if (bundle.legacy || !Array.isArray(value)) return value;
      return value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const handler = item as Record<string, unknown>;
        if (Array.isArray(handler.hooks)) return handler;
        if (handler.windowsCommand && !Object.keys(override).length)
          diagnostics.push(
            diagnostic(
              "AB321",
              "Windows-specific hook command requires a target override",
              "approximate",
              {
                path: bundle.hooks?.path,
                target,
                profile,
                remediation: `Add targets.${target} with the desired native command selection.`,
              },
            ),
          );
        const protocol = handler.protocol ?? handler.inputProtocol ?? handler.outputProtocol;
        if (protocol && !profileFor(target).hooks.supportedProtocols.includes(String(protocol)))
          diagnostics.push(
            diagnostic(
              "AB322",
              `Hook protocol '${String(protocol)}' is not portable`,
              "unsupported",
              {
                path: bundle.hooks?.path,
                target,
                profile,
                remediation: `Add a targets.${target} handler override.`,
              },
            ),
          );
        // A host may nest only some of its events: Antigravity accepts a
        // tool-name `matcher` on its two tool events and a bare handler list on
        // the rest, so the shape is decided per portable event rather than once
        // for the whole document.
        const hookProfile = profileFor(target).hooks;
        const nested =
          hookProfile.handlerShape === "claude-nested" ||
          (hookProfile.handlerShape === "nested-for-matcher-events" &&
            (hookProfile.matcherEvents as string[]).includes(neutral));
        if (!nested)
          return Object.fromEntries(
            Object.entries(handler).filter(
              ([key]) =>
                !["type", "windowsCommand", "protocol", "inputProtocol", "outputProtocol"].includes(
                  key,
                ),
            ),
          );
        const inner = Object.fromEntries(
          Object.entries(handler).filter(
            ([key]) =>
              ![
                "matcher",
                "windowsCommand",
                "protocol",
                "inputProtocol",
                "outputProtocol",
              ].includes(key),
          ),
        );
        return {
          ...(handler.matcher !== undefined ? { matcher: handler.matcher } : {}),
          hooks: [{ type: "command", ...inner }],
        };
      });
    };
    hooks[targetName] = rewrite(normalizeHandlers(handlers));
  }
  const envelope = profileFor(target).hooks.envelope;
  if (envelope === "versioned" && !bundle.legacy) return { version: 1, hooks };
  // `named` keys the whole document by the bundle, which is how a host that
  // merges several hook sets tells them apart and can disable one wholesale.
  if (envelope === "named" && !bundle.legacy) return { [bundle.name]: hooks };
  return { hooks };
}

function manifest(bundle: AgentBundle, target: AgentTarget): Record<string, unknown> {
  const profile = profileFor(target);
  const pluginAgentRoot = profile.paths.plugin.agents;
  if (bundle.legacy && pluginAgentRoot !== null) return { ...bundle.manifest };
  const implied = new Set(profile.manifest.impliedFields ?? []);
  const result: Record<string, unknown> = {
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
  };
  if (!implied.has("skills")) result.skills = "./skills/";
  if (bundle.hooks && !implied.has("hooks")) result.hooks = "./hooks/hooks.json";
  if (bundle.mcp && !implied.has("mcpServers")) result.mcpServers = "./.mcp.json";
  if (pluginAgentRoot !== null && bundle.agents.length && !implied.has("agents"))
    result.agents = `./${pluginAgentRoot}/`;
  return result;
}

function mapModel(
  value: unknown,
  target: AgentTarget,
  component: MarkdownComponent,
  diagnostics: AgentDiagnostic[],
): string | undefined {
  if (value === undefined) return undefined;
  const model = String(value);
  const semantic: Record<string, ModelClass> = {
    fast: "fast",
    balanced: "balanced",
    capable: "capable",
    inherit: "inherit",
    haiku: "fast",
    sonnet: "balanced",
    opus: "capable",
  };
  const level: ModelClass | undefined = semantic[model];
  if (!level) {
    diagnostics.push(
      diagnostic(
        "AB330",
        `Model '${model}' is not a stable semantic class; target will inherit`,
        "approximate",
        {
          component: component.name,
          path: component.path,
          target,
          remediation: `Use fast, balanced, capable, inherit, or targets.${target}.model.`,
        },
      ),
    );
    return "inherit";
  }
  return profileFor(target).models.classes[level] ?? undefined;
}

function mapTools(
  metadata: Record<string, unknown>,
  target: AgentTarget,
  component: MarkdownComponent,
  diagnostics: AgentDiagnostic[],
  legacy: boolean,
): void {
  if (!Array.isArray(metadata.tools)) return;
  const targetProfile = profileFor(target);
  if (legacy && targetProfile.paths.plugin.agents !== null) return;
  const explicit = Object.prototype.hasOwnProperty.call(targetOverride(component, target), "tools");
  if (explicit) return;
  const capabilities = metadata.tools.map(String);
  const mapping = targetProfile.tools.capabilities as Record<string, string[]> | null;
  if (mapping) {
    const unsupported = capabilities.filter((value) => !mapping[value]);
    metadata.tools = [...new Set(capabilities.flatMap((value) => mapping[value] ?? []))];
    if (unsupported.length)
      diagnostics.push(
        diagnostic(
          "AB331",
          `Tool capabilities cannot be restricted exactly: ${unsupported.join(", ")}`,
          "unsupported",
          {
            component: component.name,
            path: component.path,
            target,
            remediation: `Provide targets.${target}.tools with native tool names.`,
          },
        ),
      );
    return;
  }
  delete metadata.tools;
  diagnostics.push(
    diagnostic(
      "AB332",
      `Capability-based tool restrictions require a ${target} override`,
      "approximate",
      {
        component: component.name,
        path: component.path,
        target,
        remediation: `Provide targets.${target}.tools; restrictions were not broadened silently.`,
      },
    ),
  );
}

function renderSkill(
  bundle: AgentBundle,
  component: MarkdownComponent,
  target: AgentTarget,
  profile: AgentProfile,
  diagnostics: AgentDiagnostic[],
  artifacts: Artifact[],
  resolve?: RefResolver,
): void {
  if (!selected(component, target)) return;
  const targetProfile = profileFor(target);
  const directory = emittedName("skill", component.name, target, profile, bundle.name);
  const skillRoot =
    profile === "project" ? targetProfile.paths.project.skills : targetProfile.paths.plugin.skills;
  const base = `${skillRoot}/${directory}`;
  const invocation = String(
    component.metadata.invocationPolicy ?? component.metadata.invocation ?? "auto",
  );
  let renderedComponent = component;
  if (["explicit", "manual"].includes(invocation)) {
    const form = profileFor(target).skills.invocationPolicy;
    if (form === "frontmatter-flag")
      renderedComponent = {
        ...component,
        metadata: { ...component.metadata, "disable-model-invocation": true },
      };
    else if (
      form === "openai-yaml" &&
      !component.files.some((file) => file.path.split(path.sep).join("/") === "agents/openai.yaml")
    ) {
      artifacts.push({
        path: `${base}/agents/openai.yaml`,
        content: Buffer.from("policy:\n  allow_implicit_invocation: false\n"),
        mode: 0o644,
      });
    } else if (form === "advisory" || form === null)
      diagnostics.push(
        diagnostic("AB310", `${target} skill invocation policy is advisory`, "approximate", {
          component: component.name,
          path: component.path,
          target,
          profile,
          remediation: `Provide targets.${target} invocation instructions if implicit activation must be prevented.`,
        }),
      );
  }
  const argumentHint = component.metadata.argumentHint ?? component.metadata.arguments;
  if (argumentHint !== undefined && targetProfile.placeholders.arguments !== "prose")
    renderedComponent = {
      ...renderedComponent,
      metadata: {
        ...renderedComponent.metadata,
        "argument-hint": Array.isArray(argumentHint)
          ? argumentHint.map(String).join(" ")
          : String(argumentHint),
      },
    };
  artifacts.push({
    path: `${base}/SKILL.md`,
    content: Buffer.from(
      transformMarkdown(
        renderedComponent,
        target,
        diagnostics,
        "skill",
        profile,
        bundle.name,
        resolve,
      ),
    ),
    mode: 0o644,
  });
  copyComponentFiles(component, base, target, diagnostics, artifacts, profile, resolve);
}

function renderAgent(
  component: MarkdownComponent,
  target: AgentTarget,
  profile: AgentProfile,
  bundle: AgentBundle,
  diagnostics: AgentDiagnostic[],
  artifacts: Artifact[],
  resolve?: RefResolver,
): void {
  if (!selected(component, target)) return;
  const metadata = metadataFor(component, target, "agent", {
    profile,
    bundleName: bundle.name,
    resolve,
  });
  mapTools(metadata, target, component, diagnostics, bundle.legacy);
  const model = mapModel(
    metadata.model ?? targetOverride(component, target).modelClass ?? component.metadata.modelClass,
    target,
    component,
    diagnostics,
  );
  const targetProfile = profileFor(target);
  if (!targetProfile.features.agents.profiles.includes(profile)) {
    diagnostics.push(
      diagnostic(
        "AB340",
        `${target} custom agents are not emitted for the ${profile} profile`,
        "unsupported",
        {
          component: component.name,
          path: component.path,
          target,
          profile,
          remediation: targetProfile.features.agents.profiles.length
            ? `Generate the ${targetProfile.features.agents.profiles.join(" or ")} profile as well.`
            : `${target} has no custom-agent surface; express the behavior as a skill.`,
        },
      ),
    );
    return;
  }
  if (target === "codex") {
    const lines = [
      `name = ${JSON.stringify(emittedName("agent", component.name, target, profile, bundle.name))}`,
      `description = ${JSON.stringify(component.description)}`,
    ];
    if (metadata.reasoning)
      lines.push(`model_reasoning_effort = ${JSON.stringify(String(metadata.reasoning))}`);
    lines.push(
      `developer_instructions = ${JSON.stringify(rewritePlaceholders(processTargetBlocks(component.body, target, { resolve }), target, "other", diagnostics, component, profile))}`,
    );
    artifacts.push({
      path: `.codex/agents/${emittedName("agent", component.name, target, profile, bundle.name)}.toml`,
      content: Buffer.from(lines.join("\n") + "\n"),
      mode: 0o644,
    });
    return;
  }
  const outMetadata: Record<string, unknown> = { ...metadata };
  // A target that cannot express a model must not be handed the *portable*
  // class name instead: `model: capable` is not a model id on any host, and
  // leaving it there emits a key the host will reject or misread.
  if (model) outMetadata.model = model;
  else delete outMetadata.model;
  if (target === "cursor" && Array.isArray(outMetadata.skills)) {
    const sections = outMetadata.skills
      .map(String)
      .map((name: string) => bundle.skills.find((skill: MarkdownComponent) => skill.name === name))
      .filter(Boolean)
      .map((skill) =>
        rewritePlaceholders(
          processTargetBlocks((skill as MarkdownComponent).body, target, { resolve }),
          target,
          "skill",
          diagnostics,
          skill as MarkdownComponent,
          profile,
        ).trim(),
      );
    delete outMetadata.skills;
    component = {
      ...component,
      body: `${component.body.trimEnd()}${sections.length ? `\n\n${sections.join("\n\n")}\n` : ""}`,
    };
  }
  const agentRoot =
    profile === "project" ? targetProfile.paths.project.agents : targetProfile.paths.plugin.agents;
  artifacts.push({
    path: `${agentRoot}/${emittedName("agent", component.name, target, profile, bundle.name)}.md`,
    content: Buffer.from(
      yamlFrontmatter(
        outMetadata,
        rewritePlaceholders(
          processTargetBlocks(component.body, target, { resolve }),
          target,
          "other",
          diagnostics,
          component,
          profile,
        ),
      ),
    ),
    mode: 0o644,
  });
}

function renderRules(
  bundle: AgentBundle,
  target: AgentTarget,
  profile: AgentProfile,
  diagnostics: AgentDiagnostic[],
  artifacts: Artifact[],
  resolve?: RefResolver,
): void {
  const targetProfile = profileFor(target);
  for (const rule of bundle.rules) {
    if (!selected(rule, target)) continue;
    if (!targetProfile.features.rules.profiles.includes(profile)) {
      diagnostics.push(
        diagnostic("AB350", `${target} instruction rules are project-only`, "unsupported", {
          component: rule.name,
          path: rule.path,
          target,
          profile,
          remediation: "Generate the project profile.",
        }),
      );
      continue;
    }
    const body = rewritePlaceholders(
      processTargetBlocks(rule.body, target, { resolve }),
      target,
      "other",
      diagnostics,
      rule,
      profile,
    );
    if (!targetProfile.rules.exactActivation.includes(rule.activation))
      diagnostics.push(
        diagnostic(
          "AB351",
          `Rule activation '${rule.activation}' is not exact on ${target}`,
          targetProfile.rules.approximateActivation.includes(rule.activation)
            ? "approximate"
            : "unsupported",
          {
            component: rule.name,
            path: rule.path,
            target,
            profile,
            remediation: `Provide targets.${target} instructions or split the rule into a native activation surface.`,
          },
        ),
      );
    const ruleRoot = targetProfile.paths.project.rules;
    if (targetProfile.rules.form === "mdc") {
      const metadata: Record<string, unknown> = {
        description: rule.description,
        alwaysApply: rule.activation === "always",
      };
      if (rule.globs.length) metadata.globs = rule.globs.join(",");
      artifacts.push({
        path: `${ruleRoot}/${rule.name}.mdc`,
        content: Buffer.from(yamlFrontmatter(metadata, body)),
        mode: 0o644,
      });
    } else if (targetProfile.rules.form === "markdown") {
      const metadata = rule.globs.length ? { paths: rule.globs } : {};
      artifacts.push({
        path: `${ruleRoot}/${rule.name}.md`,
        content: Buffer.from(yamlFrontmatter(metadata, body)),
        mode: 0o644,
      });
    } else if (targetProfile.rules.form === "trigger-frontmatter") {
      // Antigravity loads `always_on` rules unconditionally and defers the rest
      // to the model, which is the distinction its `trigger` key expresses.
      const metadata: Record<string, unknown> = {
        description: rule.description,
        trigger: rule.activation === "always" ? "always_on" : "model_decision",
      };
      if (rule.globs.length) metadata.globs = rule.globs;
      artifacts.push({
        path: `${ruleRoot}/${rule.name}.md`,
        content: Buffer.from(yamlFrontmatter(metadata, body)),
        mode: 0o644,
      });
    }
  }
  if (
    targetProfile.rules.form === "aggregated-agents-md" &&
    profile === "project" &&
    bundle.rules.length
  ) {
    const content = bundle.rules
      .filter((rule) => selected(rule, target))
      .map(
        (rule) =>
          `## ${rule.name}\n\n${rewritePlaceholders(processTargetBlocks(rule.body, target, { resolve }), target, "other", diagnostics, rule, profile).trim()}`,
      )
      .join("\n\n");
    artifacts.push({
      path: String(targetProfile.paths.project.rules),
      content: Buffer.from(content + "\n"),
      mode: 0o644,
    });
  }
}

/** The bundle's policy rules, flattened. One definition of "what a rule is". */
export function policyEntries(bundle: AgentBundle): Record<string, unknown>[] {
  return bundle.policies.flatMap((policy) => {
    const value = policy.value.rules ?? policy.value.policies;
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
      : [policy.value];
  });
}

function structuredTargetValue(
  value: Record<string, unknown>,
  target: AgentTarget,
): Record<string, unknown> {
  const base = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "targets"));
  const targets = value.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return base;
  const override = (targets as Record<string, unknown>)[target];
  return override && typeof override === "object" && !Array.isArray(override)
    ? { ...base, ...(override as Record<string, unknown>) }
    : base;
}

function renderPolicies(
  bundle: AgentBundle,
  target: AgentTarget,
  profile: AgentProfile,
  diagnostics: AgentDiagnostic[],
  artifacts: Artifact[],
): void {
  const entries = policyEntries(bundle);
  if (!entries.length) return;
  if (profile === "plugin") {
    diagnostics.push(
      diagnostic("AB360", "Command policies are emitted only in project profiles", "unsupported", {
        target,
        profile,
        remediation: "Generate the project profile.",
      }),
    );
    return;
  }
  const form = profileFor(target).policies.form;
  if (form === "cursor-hooks") {
    const hookOverrides = entries.flatMap((entry) => {
      const targets = entry.targets;
      if (!targets || typeof targets !== "object" || Array.isArray(targets)) return [];
      const cursor = (targets as Record<string, unknown>).cursor;
      return cursor && typeof cursor === "object" && !Array.isArray(cursor)
        ? [cursor as Record<string, unknown>]
        : [];
    });
    if (hookOverrides.length) {
      const hooks = Object.assign(
        {},
        ...hookOverrides.map((override) => override.hooks ?? override),
      );
      artifacts.push({
        path: ".cursor/hooks.json",
        content: json({ version: 1, hooks }),
        mode: 0o644,
      });
      return;
    }
    diagnostics.push(
      diagnostic("AB361", `${target} has no native command-policy format`, "unsupported", {
        target,
        profile,
        remediation: `Provide an explicit ${target} hook override; prompt rules are not security policy.`,
      }),
    );
    return;
  }
  // A host with no policy surface says so and emits nothing. This used to be an
  // unguarded `else`, which handed every target that was neither Claude Code
  // nor Cursor a `.codex/rules/bundle.rules` it does not read — a path its own
  // profile does not declare, and output that looks right and does nothing.
  if (form === null) {
    diagnostics.push(
      diagnostic("AB361", `${target} has no native command-policy format`, "unsupported", {
        target,
        profile,
        remediation: `Express the policy natively for ${target}; prompt rules are not security policy.`,
      }),
    );
    return;
  }
  // `paths.project.policies` is the surface each form writes into, and the
  // forms disagree about what that means: Claude Code and Cursor name a file,
  // Codex names the directory its rules file lives in. Each form reads it the
  // way its own host does rather than the field being normalized to one shape.
  const policyPath = profileFor(target).paths.project.policies;
  if (form === "claude-permissions") {
    const permissions: Record<string, string[]> = { allow: [], ask: [], deny: [] };
    for (const entry of entries) {
      const action = String(entry.action ?? entry.decision ?? "prompt");
      const rawPattern = entry.pattern ?? entry.prefix ?? entry.command ?? "";
      const pattern = Array.isArray(rawPattern)
        ? rawPattern.flat().map(String).join(" ")
        : String(rawPattern);
      permissions[action === "prompt" ? "ask" : action]?.push(`Bash(${pattern} *)`);
    }
    artifacts.push({
      path: policyPath ?? ".claude/settings.json",
      content: json({ permissions }),
      mode: 0o644,
    });
  } else if (form === "codex-prefix-rules") {
    const lines = entries.map((entry) => {
      const rawPattern = entry.pattern ?? entry.prefix ?? entry.command ?? [];
      const pattern = Array.isArray(rawPattern)
        ? rawPattern
        : String(rawPattern).trim().split(/\s+/).filter(Boolean);
      const action = String(entry.action ?? entry.decision ?? "prompt");
      const decision = action === "deny" ? "forbidden" : action;
      const fields = [
        `    pattern = ${JSON.stringify(pattern)},`,
        `    decision = ${JSON.stringify(decision)},`,
      ];
      if (entry.justification)
        fields.push(`    justification = ${JSON.stringify(String(entry.justification))},`);
      const positive = entry.positiveExamples ?? entry.matches;
      const negative = entry.negativeExamples ?? entry.nonMatches;
      if (Array.isArray(positive))
        fields.push(`    match = ${JSON.stringify(positive.map(String))},`);
      if (Array.isArray(negative))
        fields.push(`    not_match = ${JSON.stringify(negative.map(String))},`);
      return `prefix_rule(\n${fields.join("\n")}\n)`;
    });
    artifacts.push({
      path: `${policyPath ?? ".codex/rules"}/bundle.rules`,
      content: Buffer.from(lines.join("\n") + "\n"),
      mode: 0o644,
    });
  }
}

/**
 * The reference resolver for one target and output profile.
 *
 * Lives here rather than in `naming.ts` because it reports `AB303`, and because
 * `agent-targets` asserts that every code a profile declares appears in one of
 * the three files that emit diagnostics.
 *
 * An unknown name returns the marker **verbatim** rather than a guess or an
 * empty string: `AB156` has already failed the parse, so nothing is written, and
 * if someone suppresses that error the leftover marker is visible instead of a
 * silently missing name. A `command` reference resolves against the skills --
 * there is no `commands` component kind; a command is a skill the model does not
 * reach for.
 */
function refResolver(
  bundle: AgentBundle,
  target: AgentTarget,
  profile: AgentProfile,
  diagnostics: AgentDiagnostic[],
): RefResolver {
  const reported = new Set<string>();
  return (kind: ReferenceKind, name: string): string => {
    const pool = kind === "agent" ? bundle.agents : bundle.skills;
    if (!pool.some((component) => component.name === name)) return `<!-- ref:${kind}:${name} -->`;
    const { text, exact } = referenceIdentifier(kind, name, target, profile, bundle.name);
    if (!exact && !reported.has(`${kind}:${name}`)) {
      reported.add(`${kind}:${name}`);
      diagnostics.push(
        diagnostic(
          "AB303",
          `${target} has no ${kind} identifier; emitted the bare name`,
          "approximate",
          {
            component: name,
            target,
            profile,
            remediation: `Reference it in prose, or provide targets.${target} instructions, if the exact identifier matters.`,
          },
        ),
      );
    }
    return text;
  };
}

export function renderBundle(
  bundle: AgentBundle,
  targets: AgentTarget[],
  profiles: AgentProfile[],
): { artifacts: Artifact[]; diagnostics: AgentDiagnostic[] } {
  const diagnostics = [...bundle.diagnostics];
  const artifacts: Artifact[] = [];
  for (const target of targets)
    for (const profile of profiles) {
      const prefix = `${target}/${profile}`;
      const local: Artifact[] = [];
      const resolve = refResolver(bundle, target, profile, diagnostics);
      const overlay = bundle.overlays.find((item) => item.target === target);
      if (profile === "plugin") {
        const { directory: manifestDir, file: manifestFile } = profileFor(target).manifest;
        // `directory` is declared nullable for a host whose manifest sits at
        // the plugin root; `import/detect.ts` already honours that.
        local.push({
          path: manifestDir ? `${manifestDir}/${manifestFile}` : manifestFile,
          content: json(
            applyOverlayManifest(manifest(bundle, target), overlay?.manifest, target, diagnostics),
          ),
          mode: 0o644,
        });
      }
      for (const skill of bundle.skills)
        renderSkill(bundle, skill, target, profile, diagnostics, local, resolve);
      for (const agent of bundle.agents)
        renderAgent(agent, target, profile, bundle, diagnostics, local, resolve);
      renderRules(bundle, target, profile, diagnostics, local, resolve);
      renderPolicies(bundle, target, profile, diagnostics, local);
      if (bundle.hooks && profileFor(target).features.hooks.profiles.includes(profile)) {
        const hookRoots = profileFor(target).paths.plugin;
        const hooks = transformedHooks(bundle, target, profile, diagnostics);
        if (hooks) local.push({ path: hookRoots.hooksFile, content: json(hooks), mode: 0o644 });
        for (const file of bundle.hookFiles)
          local.push({
            ...file,
            path: `${hookRoots.hooks}/${file.path.split(path.sep).join("/")}`,
          });
      }
      if (bundle.mcp && profile === "plugin") {
        const targetMcp = structuredTargetValue(bundle.mcp.value, target);
        const rewritten = rewritePlaceholders(
          JSON.stringify(targetMcp),
          target,
          "other",
          diagnostics,
          undefined,
          profile,
        );
        const pluginMcp = profileFor(target).paths.plugin.mcp ?? ".mcp.json";
        local.push({ path: pluginMcp, content: json(JSON.parse(rewritten)), mode: 0o644 });
      } else if (bundle.mcp && profile === "project") {
        const targetMcp = structuredTargetValue(bundle.mcp.value, target);
        const rewritten = rewritePlaceholders(
          JSON.stringify(targetMcp),
          target,
          "other",
          diagnostics,
          undefined,
          profile,
        );
        const mcpPath = profileFor(target).paths.project.mcp ?? ".mcp.json";
        if (target === "codex" && typeof targetMcp.configToml === "string")
          local.push({
            path: ".codex/config.toml",
            content: Buffer.from(String(targetMcp.configToml).trimEnd() + "\n"),
            mode: 0o644,
          });
        else if (target === "codex")
          diagnostics.push(
            diagnostic(
              "AB370",
              "Codex project MCP configuration requires TOML and cannot be translated losslessly from arbitrary structured input",
              "unsupported",
              {
                path: bundle.mcp.path,
                target,
                profile,
                remediation: "Provide targets.codex.configToml or use the plugin profile.",
              },
            ),
          );
        else local.push({ path: mcpPath, content: json(JSON.parse(rewritten)), mode: 0o644 });
      }
      // Marketplace assets are catalog metadata, not bundle content. The icon
      // and screenshots exist so a listing can point at a file inside the
      // bundle, and a catalog is only ever built from the plugin profile --
      // `buildCatalogs` is called with `["plugin"]` and nothing else. Emitting
      // them into `project` therefore put a file no host reads at the
      // destination root, and because AB502 makes `marketplace.icon` an error
      // when absent, *every* pair of schema 2 bundles merged into one project
      // destination collided on `assets/icon.svg` (AB808) over exactly that
      // unread file. Bundle assets a component actually links to still render
      // in both profiles; only the ones `marketplace:` claims are withheld.
      const withheld = marketplaceAssetPaths(bundle, profile);
      for (const asset of bundle.assets) {
        if (withheld.has(posix(asset.path))) continue;
        const textual =
          /\.(?:md|txt|json|ya?ml|toml|sh|js|mjs|cjs|ts|py)$/i.test(asset.path) &&
          !asset.content.includes(0);
        local.push({
          ...asset,
          content: textual
            ? Buffer.from(
                rewritePlaceholders(
                  processTargetBlocks(asset.content.toString("utf8"), target, {
                    markdown: /\.md$/i.test(asset.path),
                    resolve,
                  }),
                  target,
                  "other",
                  diagnostics,
                  undefined,
                  profile,
                ),
              )
            : asset.content,
          path: bundle.legacy ? posix(asset.path) : `assets/${posix(asset.path)}`,
        });
      }
      // Overlays merge after every portable component so a collision is decided
      // against the complete portable set, never against a partial one.
      const merged = mergeOverlay(
        local,
        overlayArtifacts(overlay, profile),
        overlay?.onCollision ?? "overlay-wins",
        target,
        profile,
        diagnostics,
      );
      const seen = new Set<string>();
      for (const artifact of merged.sort((a, b) => a.path.localeCompare(b.path))) {
        if (seen.has(artifact.path))
          diagnostics.push({
            ...diagnostic("AB170", `Duplicate output path '${artifact.path}'`, "unsupported", {
              target,
              profile,
              remediation: "Rename one of the colliding components.",
            }),
            severity: "error",
          });
        seen.add(artifact.path);
        artifacts.push({ ...artifact, path: `${prefix}/${artifact.path}` });
      }
    }
  const unique = new Map<string, AgentDiagnostic>();
  for (const item of diagnostics) unique.set(JSON.stringify(item), item);
  return { artifacts, diagnostics: [...unique.values()] };
}
