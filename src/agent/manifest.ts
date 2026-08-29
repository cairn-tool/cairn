import type { AgentDiagnostic, AgentTarget } from "./types.js";
import { diagnostic, TARGETS } from "./types.js";

/**
 * Bundle manifest schema versions this release parses.
 *
 * This is a third hand-owned version, distinct from `CONTRACT_VERSION` (the
 * command contract surface) and `PROFILE_SCHEMA_VERSION` (the target profile
 * structure). It versions the *source* format authors write.
 */
export const SUPPORTED_BUNDLE_SCHEMAS = ["1", "1.0", "2"] as const;

/** The version `agent init` scaffolds and `agent upgrade` migrates toward. */
export const CURRENT_BUNDLE_SCHEMA = "2";

/** Component path keys that may appear under `components:` or, in v1, at the top level. */
export const COMPONENT_KEYS = [
  "skills",
  "agents",
  "rules",
  "hooks",
  "policies",
  "mcp",
  "assets",
] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export interface MarketplacePrompt {
  title: string;
  prompt: string;
}

export interface MarketplacePublisher {
  name: string;
  url?: string;
  email?: string;
}

/**
 * Listing metadata. Structure is validated here; whether it is *complete enough
 * to publish* is `agent package`'s question, not the parser's, so a bundle with
 * a half-filled marketplace block still validates and converts.
 */
export interface BundleMarketplace {
  displayName?: string;
  summary?: string;
  description?: string;
  categories: string[];
  keywords: string[];
  publisher?: MarketplacePublisher;
  homepage?: string;
  repository?: string;
  license?: string;
  icon?: string;
  screenshots: string[];
  starterPrompts: MarketplacePrompt[];
  legal?: { privacyPolicy?: string; termsOfService?: string };
}

export interface NativeOverlayDeclaration {
  target: AgentTarget;
  /** Bundle-relative POSIX path. Defaults to `native/<target>`. */
  root: string;
}

export interface BundleManifest {
  /** The manifest exactly as it was parsed, for callers that need untouched data. */
  raw: Record<string, unknown>;
  schemaVersion: string;
  /** Major source layer: `0` for a legacy native plugin, otherwise 1 or 2. */
  layer: 0 | 1 | 2;
  name: string;
  version: string;
  description: string;
  marketplace?: BundleMarketplace;
  /** Declared overlay roots. Present for every target on a v2 bundle. */
  native: NativeOverlayDeclaration[];
}

function error(
  diagnostics: AgentDiagnostic[],
  code: string,
  message: string,
  path: string,
  remediation?: string,
): void {
  diagnostics.push({
    ...diagnostic(code, message, "unsupported", { path, ...(remediation ? { remediation } : {}) }),
    severity: "error",
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(
  value: unknown,
  field: string,
  path: string,
  diagnostics: AgentDiagnostic[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    error(diagnostics, "AB122", `marketplace.${field} must be an array of strings`, path);
    return [];
  }
  return value.map(String);
}

function optionalString(
  value: unknown,
  field: string,
  path: string,
  diagnostics: AgentDiagnostic[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    error(diagnostics, "AB122", `marketplace.${field} must be a string`, path);
    return undefined;
  }
  return value;
}

function parsePublisher(
  value: unknown,
  path: string,
  diagnostics: AgentDiagnostic[],
): MarketplacePublisher | undefined {
  if (value === undefined) return undefined;
  const entry = record(value);
  if (!entry) {
    error(diagnostics, "AB122", "marketplace.publisher must be an object", path);
    return undefined;
  }
  // An empty name is structurally valid and deliberately so: `agent init`
  // scaffolds `name: ""` because it cannot know the publisher, and a bundle
  // must still validate before it is ready to publish. `agent package` is what
  // requires a real value.
  const name = optionalString(entry.name, "publisher.name", path, diagnostics);
  if (name === undefined) {
    error(diagnostics, "AB122", "marketplace.publisher requires a name", path);
    return undefined;
  }
  return {
    name,
    ...(optionalString(entry.url, "publisher.url", path, diagnostics) !== undefined
      ? { url: String(entry.url) }
      : {}),
    ...(optionalString(entry.email, "publisher.email", path, diagnostics) !== undefined
      ? { email: String(entry.email) }
      : {}),
  };
}

function parsePrompts(
  value: unknown,
  path: string,
  diagnostics: AgentDiagnostic[],
): MarketplacePrompt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    error(diagnostics, "AB122", "marketplace.starterPrompts must be an array", path);
    return [];
  }
  const prompts: MarketplacePrompt[] = [];
  for (const item of value) {
    const entry = record(item);
    if (!entry || typeof entry.title !== "string" || typeof entry.prompt !== "string") {
      error(
        diagnostics,
        "AB122",
        "marketplace.starterPrompts entries require string title and prompt",
        path,
      );
      continue;
    }
    prompts.push({ title: entry.title, prompt: entry.prompt });
  }
  return prompts;
}

function parseMarketplace(
  value: unknown,
  path: string,
  diagnostics: AgentDiagnostic[],
): BundleMarketplace | undefined {
  if (value === undefined) return undefined;
  const entry = record(value);
  if (!entry) {
    error(diagnostics, "AB119", "Bundle marketplace must be an object", path);
    return undefined;
  }
  const legal = record(entry.legal);
  if (entry.legal !== undefined && !legal)
    error(diagnostics, "AB122", "marketplace.legal must be an object", path);
  return {
    displayName: optionalString(entry.displayName, "displayName", path, diagnostics),
    summary: optionalString(entry.summary, "summary", path, diagnostics),
    description: optionalString(entry.description, "description", path, diagnostics),
    categories: stringList(entry.categories, "categories", path, diagnostics),
    keywords: stringList(entry.keywords, "keywords", path, diagnostics),
    publisher: parsePublisher(entry.publisher, path, diagnostics),
    homepage: optionalString(entry.homepage, "homepage", path, diagnostics),
    repository: optionalString(entry.repository, "repository", path, diagnostics),
    license: optionalString(entry.license, "license", path, diagnostics),
    icon: optionalString(entry.icon, "icon", path, diagnostics),
    screenshots: stringList(entry.screenshots, "screenshots", path, diagnostics),
    starterPrompts: parsePrompts(entry.starterPrompts, path, diagnostics),
    ...(legal
      ? {
          legal: {
            privacyPolicy: optionalString(
              legal.privacyPolicy,
              "legal.privacyPolicy",
              path,
              diagnostics,
            ),
            termsOfService: optionalString(
              legal.termsOfService,
              "legal.termsOfService",
              path,
              diagnostics,
            ),
          },
        }
      : {}),
  };
}

/** Default overlay root for a target, used when `native:` omits or is silent about it. */
export function defaultOverlayRoot(target: AgentTarget): string {
  return `native/${target}`;
}

function parseNative(
  value: unknown,
  path: string,
  diagnostics: AgentDiagnostic[],
): NativeOverlayDeclaration[] {
  const declarations: NativeOverlayDeclaration[] = TARGETS.map((target) => ({
    target,
    root: defaultOverlayRoot(target),
  }));
  if (value === undefined) return declarations;
  const entry = record(value);
  if (!entry) {
    error(diagnostics, "AB180", "Bundle native overlays must be an object", path);
    return declarations;
  }
  for (const [key, raw] of Object.entries(entry)) {
    if (!TARGETS.includes(key as AgentTarget)) {
      error(diagnostics, "AB184", `Unknown native overlay target '${key}'`, path, TARGET_HINT);
      continue;
    }
    // Both `codex: native/codex` and `codex: { root: native/codex }` are accepted;
    // the shorthand is what `agent init` writes.
    const override = typeof raw === "string" ? { root: raw } : record(raw);
    if (!override) {
      error(
        diagnostics,
        "AB185",
        `Native overlay '${key}' must be a string path or an object`,
        path,
      );
      continue;
    }
    if (override.root === undefined) continue;
    if (typeof override.root !== "string" || !override.root.trim()) {
      error(diagnostics, "AB185", `Native overlay '${key}' root must be a non-empty string`, path);
      continue;
    }
    const declaration = declarations.find((item) => item.target === key);
    if (declaration) declaration.root = override.root;
  }
  return declarations;
}

const TARGET_HINT = `Use one of: ${TARGETS.join(", ")}.`;

/**
 * Normalizes a v1 or v2 manifest into one shape.
 *
 * v1 and v2 differ only in what is *declarable*, not in how anything already
 * declared behaves — which is what keeps a v1 bundle rendering byte-identically
 * after this module was introduced.
 */
export function normalizeManifest(
  raw: Record<string, unknown>,
  manifestPath: string,
  legacy: boolean,
  fallbackName: string,
  diagnostics: AgentDiagnostic[],
): BundleManifest {
  // A neutral manifest with no schemaVersion reports "legacy" here, as it always
  // has. AB103 already flags the missing field; changing the reported value
  // would change `agent inspect` output for those bundles.
  const schemaVersion = String(raw.schemaVersion ?? "legacy");
  const layer: 0 | 1 | 2 = legacy ? 0 : schemaVersion === "2" ? 2 : 1;

  if (!legacy && raw.schemaVersion !== undefined && !isSupportedSchema(schemaVersion))
    error(
      diagnostics,
      "AB112",
      `Unsupported schemaVersion '${schemaVersion}'`,
      manifestPath,
      `Use one of: ${SUPPORTED_BUNDLE_SCHEMAS.join(", ")}.`,
    );

  // The marketplace and native blocks are v2 concepts. Reading them on a v1
  // bundle would silently change that bundle's output, so they are refused.
  if (layer === 1)
    for (const field of ["marketplace", "native"] as const)
      if (raw[field] !== undefined)
        error(
          diagnostics,
          "AB127",
          `Bundle field '${field}' requires schemaVersion 2`,
          manifestPath,
          "Run cairn agent upgrade --to-schema 2.",
        );

  if (layer === 2)
    for (const key of COMPONENT_KEYS)
      if (raw[key] !== undefined)
        diagnostics.push(
          diagnostic(
            "AB126",
            `Component path '${key}' at the top level is deprecated in schemaVersion 2`,
            "exact",
            { path: manifestPath, remediation: `Move it under 'components.${key}'.` },
          ),
        );

  return {
    raw,
    schemaVersion,
    layer,
    name: String(raw.name ?? fallbackName),
    version: String(raw.version ?? "0.0.0"),
    description: String(raw.description ?? ""),
    marketplace:
      layer === 2 ? parseMarketplace(raw.marketplace, manifestPath, diagnostics) : undefined,
    native: layer === 2 ? parseNative(raw.native, manifestPath, diagnostics) : [],
  };
}

export function isSupportedSchema(value: string): boolean {
  return (SUPPORTED_BUNDLE_SCHEMAS as readonly string[]).includes(value);
}
