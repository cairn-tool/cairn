import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  AgentDiagnostic,
  AgentProfile,
  AgentTarget,
  Artifact,
  MappingQuality,
  SourceFile,
} from "../types.js";
import { diagnostic } from "../types.js";
import type { HookProfile } from "../targets/index.js";
import { HOOK_EVENT_ALIASES, outputPatternToRegExp, profileFor } from "../targets/index.js";
import { CURRENT_BUNDLE_SCHEMA } from "../manifest.js";
import { YAML_OPTIONS, sortArtifacts } from "../scaffold.js";
import { splitFrontmatter } from "../parser.js";

export type Disposition = "portable" | "native" | "manifest" | "dropped";

export interface ImportProvenance {
  /** POSIX path relative to the import source root. */
  source: string;
  /** POSIX path relative to the bundle root, or null when dropped. */
  destination: string | null;
  layer: Disposition;
  fidelity: MappingQuality;
  note?: string;
}

export interface ImportReport {
  from: {
    target: AgentTarget;
    profile: AgentProfile;
    requested: string;
    confidence: string;
  };
  merge: string;
  files: ImportProvenance[];
  counts: Record<Disposition, number>;
}

export interface NormalizeResult {
  artifacts: Artifact[];
  provenance: ImportProvenance[];
  diagnostics: AgentDiagnostic[];
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n");
}

function yaml(value: unknown): Buffer {
  return Buffer.from(stringifyYaml(value, YAML_OPTIONS));
}

function posix(value: string): string {
  return value.split(path.sep).join("/");
}

function note(
  diagnostics: AgentDiagnostic[],
  code: string,
  message: string,
  quality: MappingQuality,
  extra: Partial<AgentDiagnostic> = {},
): void {
  diagnostics.push(diagnostic(code, message, quality, extra));
}

/**
 * Reverses the placeholder substitution `renderBundle` applied.
 *
 * Only a bundle root that reads as a variable is reversed. Codex project and
 * both Cursor scopes render `${BUNDLE_ROOT}` to a literal `"."`, and rewriting
 * every `.` back would corrupt relative paths and sentence-ending periods
 * throughout the corpus — so those are left alone and reported instead.
 */
export function reversePlaceholders(
  content: string,
  target: AgentTarget,
  profile: AgentProfile,
): { content: string; reversible: boolean } {
  const nativeRoot = profileFor(target).placeholders.bundleRoot[profile];
  if (!/^\$\{[A-Z_]+\}$/.test(nativeRoot)) return { content, reversible: false };
  const escaped = nativeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { content: content.replace(new RegExp(escaped, "g"), "${BUNDLE_ROOT}"), reversible: true };
}

/**
 * The advisory hint an `arguments: "advisory"` target appends beside
 * `$ARGUMENTS`. The renderer splices in a blank line *and* the hint line, so
 * both must come back out or every round trip grows a blank line.
 */
const ADVISORY_ARGUMENT_HINT =
  "\n\n> If the above shows literal `$ARGUMENTS`, extract the argument from the user's message.";

/**
 * Reverses argument-placeholder rendering.
 *
 * The hint is stripped only from skills, because that is the only kind the
 * renderer adds it to. Stripping it from an agent would lose a line that
 * re-rendering never puts back — Cursor inlines skill bodies into agents, so
 * an agent can legitimately contain the hint as content.
 */
function reverseArguments(content: string, target: AgentTarget, kind: "skill" | "other"): string {
  const mode = profileFor(target).placeholders.arguments;
  let output = content;
  if (mode === "advisory" && kind === "skill")
    output = output.split(ADVISORY_ARGUMENT_HINT).join("");
  return output.replace(/\$ARGUMENTS/g, "${ARGUMENTS}");
}

/**
 * Maps native tool names back to portable capabilities.
 *
 * The forward direction expands one capability into several native names, so
 * the inverse is many-to-one and lossy in the other direction only: a native
 * list naming just `Read` still yields `read`. Names the target does not
 * declare are kept verbatim under a target override rather than discarded.
 */
export function reverseTools(
  values: unknown,
  target: AgentTarget,
): { capabilities: string[]; unmapped: string[] } | null {
  if (!Array.isArray(values)) return null;
  const table = profileFor(target).tools.capabilities;
  if (!table) return null;
  const capabilities: string[] = [];
  const unmapped: string[] = [];
  for (const value of values.map(String)) {
    const capability = Object.entries(table).find(([, names]) => names.includes(value))?.[0];
    if (capability) {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    } else unmapped.push(value);
  }
  return { capabilities, unmapped };
}

/**
 * Maps a native model id back to a semantic class.
 *
 * Several classes can render to one native id — Cursor maps balanced, capable,
 * and inherit all to `inherit` — so an ambiguous id resolves to `inherit` and
 * the caller reports the approximation rather than inventing a class.
 */
export function reverseModel(
  value: unknown,
  target: AgentTarget,
): { model: string; ambiguous: boolean } | null {
  if (typeof value !== "string") return null;
  const classes = profileFor(target).models.classes;
  const matches = Object.entries(classes)
    .filter(([, native]) => native === value)
    .map(([name]) => name);
  if (!matches.length) return null;
  return matches.length === 1
    ? { model: matches[0], ambiguous: false }
    : { model: matches.includes("inherit") ? "inherit" : matches[0], ambiguous: true };
}

interface Claim {
  file: SourceFile;
  relative: string;
}

/** Files under `root`, or `[]` when the root is null or nothing matches. */
function under(files: Claim[], root: string | null): Claim[] {
  if (!root) return [];
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return files.filter((claim) => claim.relative === root || claim.relative.startsWith(prefix));
}

function strip(relative: string, root: string): string {
  return relative.slice(root.endsWith("/") ? root.length : root.length + 1);
}

/**
 * Converts a native tree into portable bundle sources.
 *
 * Every path root, manifest location, hook event spelling, and rule form is
 * read from the target profile, so this stays the inverse of `renderBundle`
 * rather than a parallel set of assumptions.
 */
export function normalizeTree(
  files: SourceFile[],
  target: AgentTarget,
  profile: AgentProfile,
  bundleName: string,
  nativeOnly: boolean,
): NormalizeResult {
  const targetProfile = profileFor(target);
  const roots = profile === "plugin" ? targetProfile.paths.plugin : targetProfile.paths.project;
  const diagnostics: AgentDiagnostic[] = [];
  const provenance: ImportProvenance[] = [];
  const artifacts: Artifact[] = [];
  const claims: Claim[] = files.map((file) => ({ file, relative: posix(file.path) }));
  const consumed = new Set<string>();

  const take = (
    claim: Claim,
    destination: string,
    layer: Disposition,
    fidelity: MappingQuality,
    why?: string,
  ) => {
    consumed.add(claim.relative);
    provenance.push({
      source: claim.relative,
      destination,
      layer,
      fidelity,
      ...(why ? { note: why } : {}),
    });
  };

  let manifest: Record<string, unknown> = {};
  const manifestSpec = targetProfile.manifest;
  const manifestPath =
    manifestSpec.directory && profile === "plugin"
      ? `${manifestSpec.directory}/${manifestSpec.file}`
      : null;

  if (!nativeOnly && manifestPath) {
    const claim = claims.find((item) => item.relative === manifestPath);
    if (claim) {
      try {
        manifest = JSON.parse(claim.file.content.toString("utf8")) as Record<string, unknown>;
      } catch {
        note(
          diagnostics,
          "AB230",
          `Could not parse the native manifest at ${manifestPath}`,
          "unsupported",
          {
            target,
            path: manifestPath,
          },
        );
      }
      take(claim, "agent-bundle.yaml", "manifest", "exact");
    }
  }

  const declared = new Set(manifestSpec.fields.map((field) => field.name));
  const extraManifest = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !declared.has(key)),
  );

  if (!nativeOnly) {
    normalizeSkills(claims, roots.skills, target, profile, bundleName, take, artifacts, consumed);
    normalizeAgents(
      claims,
      roots.agents ?? null,
      target,
      profile,
      take,
      artifacts,
      consumed,
      diagnostics,
    );
    normalizeRules(
      claims,
      "rules" in roots ? roots.rules : null,
      target,
      take,
      artifacts,
      consumed,
      diagnostics,
    );
    // Only the plugin profile has a hooks root; project layouts have none.
    normalizeHooks(
      claims,
      "hooks" in roots ? roots.hooks : null,
      "hooksFile" in roots ? roots.hooksFile : null,
      target,
      take,
      artifacts,
      consumed,
      diagnostics,
    );
    normalizeMcp(claims, roots.mcp ?? null, target, take, artifacts, consumed, diagnostics);
    normalizeAssets(claims, roots.assets, take, artifacts, consumed);
  }

  // Anything the portable model does not claim is preserved verbatim in the
  // overlay. That is the whole point of the overlay layer: the alternative is
  // dropping a file the host understands and this tool does not.
  for (const claim of claims) {
    if (consumed.has(claim.relative)) continue;
    const destination = `native/${target}/${profile}/${claim.relative}`;
    artifacts.push({ path: destination, content: claim.file.content, mode: claim.file.mode });
    take(claim, destination, "native", "exact", "no portable equivalent; preserved as an overlay");
  }

  if (Object.keys(extraManifest).length) {
    const destination = `native/${target}/manifest.json`;
    artifacts.push({ path: destination, content: json(extraManifest), mode: 0o644 });
    provenance.push({
      source: manifestPath ?? "(manifest)",
      destination,
      layer: "native",
      fidelity: "exact",
      note: "manifest fields the target profile does not declare",
    });
    note(
      diagnostics,
      "AB231",
      `Manifest fields not described by the ${target} profile were preserved as an overlay fragment`,
      "exact",
      { target, path: destination },
    );
  }

  artifacts.push({
    path: "agent-bundle.yaml",
    content: yaml(bundleManifest(manifest, bundleName, target)),
    mode: 0o644,
  });

  return { artifacts: sortArtifacts(artifacts), provenance, diagnostics };
}

function bundleManifest(
  native: Record<string, unknown>,
  fallbackName: string,
  target: AgentTarget,
): Record<string, unknown> {
  const name = typeof native.name === "string" && native.name ? native.name : fallbackName;
  const marketplace: Record<string, unknown> = {};
  if (typeof native.displayName === "string") marketplace.displayName = native.displayName;
  if (typeof native.author === "string") marketplace.publisher = { name: native.author };
  if (typeof native.license === "string") marketplace.license = native.license;
  if (typeof native.homepage === "string") marketplace.homepage = native.homepage;
  if (Array.isArray(native.categories)) marketplace.categories = native.categories.map(String);

  return {
    schemaVersion: CURRENT_BUNDLE_SCHEMA,
    name,
    version: typeof native.version === "string" ? native.version : "0.1.0",
    description: typeof native.description === "string" ? native.description : `Imported ${name}`,
    ...(Object.keys(marketplace).length ? { marketplace } : {}),
    native: { [target]: `native/${target}` },
  };
}

type Take = (
  claim: Claim,
  destination: string,
  layer: Disposition,
  fidelity: MappingQuality,
  why?: string,
) => void;

function normalizeSkills(
  claims: Claim[],
  root: string,
  target: AgentTarget,
  profile: AgentProfile,
  bundleName: string,
  take: Take,
  artifacts: Artifact[],
  consumed: Set<string>,
): void {
  const namespaced = profileFor(target).paths.namespacePluginSkills && profile === "plugin";
  for (const claim of under(claims, root)) {
    if (consumed.has(claim.relative)) continue;
    const relative = strip(claim.relative, root);
    const segments = relative.split("/");
    // Undo the `<bundle>-<skill>` directory namespacing Cursor plugins use.
    if (namespaced && segments[0].startsWith(`${bundleName}-`))
      segments[0] = segments[0].slice(bundleName.length + 1);
    const destination = `skills/${segments.join("/")}`;
    const markdown = relative.endsWith(".md");
    const content = markdown
      ? Buffer.from(
          reverseArguments(
            reversePlaceholders(claim.file.content.toString("utf8"), target, profile).content,
            target,
            "skill",
          ),
        )
      : claim.file.content;
    artifacts.push({ path: destination, content, mode: claim.file.mode });
    take(claim, destination, "portable", "exact");
  }
}

function normalizeAgents(
  claims: Claim[],
  root: string | null,
  target: AgentTarget,
  profile: AgentProfile,
  take: Take,
  artifacts: Artifact[],
  consumed: Set<string>,
  diagnostics: AgentDiagnostic[],
): void {
  for (const claim of under(claims, root)) {
    if (consumed.has(claim.relative)) continue;
    const relative = strip(claim.relative, root!);
    // Codex renders agents to TOML, which carries only a subset of the source
    // and is not losslessly invertible. Preserve it as an overlay instead of
    // fabricating a portable agent from it.
    if (relative.endsWith(".toml")) {
      note(
        diagnostics,
        "AB232",
        `${target} TOML agents are not losslessly portable; preserved as an overlay`,
        "approximate",
        { target, profile, path: claim.relative },
      );
      continue;
    }
    if (!relative.endsWith(".md")) continue;
    const destination = `agents/${relative.replace(/\.md$/, ".agent.md")}`;
    const text = reverseArguments(
      reversePlaceholders(claim.file.content.toString("utf8"), target, profile).content,
      target,
      "other",
    );
    const { metadata, body } = splitFrontmatter(text, claim.relative);
    let fidelity: MappingQuality = "exact";

    // Native model ids and tool names are target vocabulary. Leaving them in
    // place would produce a bundle that only renders correctly for the target
    // it came from — the opposite of what importing is for.
    const model = reverseModel(metadata.model, target);
    if (model) {
      metadata.model = model.model;
      if (model.ambiguous) {
        fidelity = "approximate";
        note(
          diagnostics,
          "AB238",
          `Native model '${String(metadata.model)}' maps to several ${target} classes; imported as 'inherit'`,
          "approximate",
          { target, path: claim.relative },
        );
      }
    }
    const tools = reverseTools(metadata.tools, target);
    if (tools) {
      metadata.tools = tools.capabilities;
      if (tools.unmapped.length) {
        // Preserved under a target override so nothing is silently dropped.
        const overrides = (metadata.targets ?? {}) as Record<string, unknown>;
        overrides[target] = { ...(overrides[target] as object), tools: tools.unmapped };
        metadata.targets = overrides;
        fidelity = "approximate";
        note(
          diagnostics,
          "AB239",
          `Tool names with no portable capability were kept under targets.${target}: ${tools.unmapped.join(", ")}`,
          "approximate",
          { target, path: claim.relative },
        );
      }
    }

    artifacts.push({
      path: destination,
      content: Buffer.from(`---\n${stringifyYaml(metadata, YAML_OPTIONS).trim()}\n---\n${body}`),
      mode: claim.file.mode,
    });
    take(claim, destination, "portable", fidelity);
  }
}

function normalizeRules(
  claims: Claim[],
  root: string | null,
  target: AgentTarget,
  take: Take,
  artifacts: Artifact[],
  consumed: Set<string>,
  diagnostics: AgentDiagnostic[],
): void {
  const form = profileFor(target).rules.form;
  if (!root || !form) return;
  for (const claim of under(claims, root)) {
    if (consumed.has(claim.relative)) continue;
    const text = claim.file.content.toString("utf8");

    if (form === "aggregated-agents-md") {
      // An aggregate cannot be split faithfully: prose outside a heading has no
      // home. Import it as one rule and keep the original as an overlay too.
      const destination = "rules/imported.md";
      artifacts.push({
        path: destination,
        content: Buffer.from(
          `---\nname: imported\ndescription: Imported from ${claim.relative}\nactivation: always\n---\n\n${text}`,
        ),
        mode: 0o644,
      });
      take(
        claim,
        destination,
        "portable",
        "approximate",
        "aggregated rules cannot be split faithfully",
      );
      note(
        diagnostics,
        "AB233",
        `${target} aggregates rules into ${claim.relative}; imported as a single rule`,
        "approximate",
        { target, path: claim.relative },
      );
      continue;
    }

    const relative = strip(claim.relative, root);
    const { metadata, body } = splitFrontmatter(text, claim.relative);
    const normalized: Record<string, unknown> = { ...metadata };
    // `.mdc` spells activation as alwaysApply plus a comma-joined glob list.
    if (normalized.alwaysApply !== undefined) {
      normalized.activation = normalized.alwaysApply === true ? "always" : "files";
      delete normalized.alwaysApply;
    }
    if (typeof normalized.globs === "string")
      normalized.globs = normalized.globs
        .split(",")
        .map((glob) => glob.trim())
        .filter(Boolean);
    if (Array.isArray(normalized.globs) && normalized.globs.length && !normalized.activation)
      normalized.activation = "files";
    normalized.activation ??= "always";
    normalized.name ??= relative.replace(/\.mdc$|\.md$/, "");

    const destination = `rules/${relative.replace(/\.mdc$/, ".md")}`;
    artifacts.push({
      path: destination,
      content: Buffer.from(`---\n${stringifyYaml(normalized, YAML_OPTIONS).trim()}\n---\n${body}`),
      mode: claim.file.mode,
    });
    take(claim, destination, "portable", "exact");
  }
}

function normalizeHooks(
  claims: Claim[],
  root: string | null,
  documentPath: string | null,
  target: AgentTarget,
  take: Take,
  artifacts: Artifact[],
  consumed: Set<string>,
  diagnostics: AgentDiagnostic[],
): void {
  const targetProfile = profileFor(target);
  // The hook *document* need not live inside the hook *script* root: a host may
  // put it at the plugin root while its scripts sit in a subdirectory. Without
  // this, the document is never claimed, the bundle ends up with no hooks, and
  // the scripts are then dropped too because nothing emits them.
  const document = documentPath
    ? claims.filter((claim) => claim.relative === documentPath && !under([claim], root).length)
    : [];
  for (const claim of [...document, ...under(claims, root)]) {
    if (consumed.has(claim.relative)) continue;
    const relative =
      claim.relative === documentPath && !under([claim], root).length
        ? path.basename(claim.relative)
        : strip(claim.relative, root!);
    if (!/^hooks\.(json|ya?ml)$/.test(relative)) {
      // A hook script travels with the hooks directory unchanged.
      const destination = `hooks/${relative}`;
      artifacts.push({ path: destination, content: claim.file.content, mode: claim.file.mode });
      take(claim, destination, "portable", "exact");
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = (
        relative.endsWith(".json")
          ? JSON.parse(claim.file.content.toString("utf8"))
          : parseYaml(claim.file.content.toString("utf8"))
      ) as Record<string, unknown>;
    } catch {
      note(diagnostics, "AB234", `Could not parse ${claim.relative}`, "unsupported", {
        target,
        path: claim.relative,
      });
      continue;
    }
    // Unwrap the `{ version, hooks }` envelope some targets emit.
    let inner =
      parsed.hooks && typeof parsed.hooks === "object"
        ? (parsed.hooks as Record<string, unknown>)
        : parsed;
    // A `named` document is a map of hook *name* to that name's events, and a
    // host merges several of them. Flatten one level so the event names below
    // are reached; the bundle name itself carries no portable meaning.
    if (targetProfile.hooks.envelope === "named" && inner === parsed) {
      const merged: Record<string, unknown> = {};
      for (const events of Object.values(parsed)) {
        if (!events || typeof events !== "object" || Array.isArray(events)) continue;
        for (const [event, handlers] of Object.entries(events as Record<string, unknown>)) {
          // `enabled` is a switch on the named set, not an event.
          if (HOOK_EVENT_ALIASES[event]) merged[event] = handlers;
        }
      }
      if (Object.keys(merged).length) inner = merged;
    }

    const portable: Record<string, unknown> = {};
    for (const [event, handlers] of Object.entries(inner)) {
      const alias = HOOK_EVENT_ALIASES[event];
      if (!alias) {
        note(
          diagnostics,
          "AB235",
          `Hook event '${event}' has no portable equivalent; preserved as an overlay`,
          "approximate",
          { target, path: claim.relative },
        );
        continue;
      }
      portable[alias] = unwrapHandlers(handlers, targetProfile.hooks.handlerShape);
    }
    const destination = "hooks/hooks.yaml";
    artifacts.push({ path: destination, content: yaml({ hooks: portable }), mode: 0o644 });
    take(claim, destination, "portable", "exact");
  }
}

/**
 * Flattens the `{ matcher, hooks: [...] }` nesting Claude-shaped targets use.
 *
 * `nested-for-matcher-events` nests only some of its events, and a flat handler
 * carries no inner `hooks` array, so the per-entry test below already tells the
 * two apart without the shape having to say which event this was.
 */
function unwrapHandlers(handlers: unknown, shape: HookProfile["handlerShape"]): unknown {
  if (shape === "flat" || !Array.isArray(handlers)) return handlers;
  const flattened: unknown[] = [];
  for (const entry of handlers) {
    if (
      entry &&
      typeof entry === "object" &&
      Array.isArray((entry as Record<string, unknown>).hooks)
    ) {
      const group = entry as Record<string, unknown>;
      for (const inner of group.hooks as unknown[])
        flattened.push(
          group.matcher && inner && typeof inner === "object"
            ? { ...(inner as Record<string, unknown>), matcher: group.matcher }
            : inner,
        );
    } else flattened.push(entry);
  }
  return flattened;
}

function normalizeMcp(
  claims: Claim[],
  root: string | null,
  target: AgentTarget,
  take: Take,
  artifacts: Artifact[],
  consumed: Set<string>,
  diagnostics: AgentDiagnostic[],
): void {
  if (!root) return;
  const claim = claims.find((item) => item.relative === root && !consumed.has(item.relative));
  if (!claim) return;
  // Codex project MCP is TOML. `render.ts` reads it back from
  // targets.codex.configToml, so round-tripping it through that key is exact.
  if (root.endsWith(".toml")) {
    const destination = "mcp/mcp.yaml";
    artifacts.push({
      path: destination,
      content: yaml({ targets: { [target]: { configToml: claim.file.content.toString("utf8") } } }),
      mode: 0o644,
    });
    take(claim, destination, "portable", "exact");
    return;
  }
  try {
    const parsed: unknown = JSON.parse(claim.file.content.toString("utf8"));
    const destination = "mcp/mcp.json";
    artifacts.push({ path: destination, content: json(parsed), mode: 0o644 });
    take(claim, destination, "portable", "exact");
  } catch {
    note(diagnostics, "AB234", `Could not parse ${claim.relative}`, "unsupported", {
      target,
      path: claim.relative,
    });
  }
}

function normalizeAssets(
  claims: Claim[],
  root: string,
  take: Take,
  artifacts: Artifact[],
  consumed: Set<string>,
): void {
  for (const claim of under(claims, root)) {
    if (consumed.has(claim.relative)) continue;
    const destination = `assets/${strip(claim.relative, root)}`;
    artifacts.push({ path: destination, content: claim.file.content, mode: claim.file.mode });
    take(claim, destination, "portable", "exact");
  }
}

/** True when a path is described by any output pattern for this layout. */
export function describedByLayout(
  target: AgentTarget,
  profile: AgentProfile,
  candidate: string,
): boolean {
  return (profileFor(target).outputs[profile] ?? []).some((entry) =>
    outputPatternToRegExp(entry.pattern).test(candidate),
  );
}
