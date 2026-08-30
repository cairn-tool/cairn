import fs from "node:fs";
import path from "node:path";
import type { AgentDiagnostic, AgentTarget } from "../types.js";
import { diagnostic, TARGETS } from "../types.js";
import { readStructured } from "../parser.js";
import { isInside } from "../../config-schema.js";
import type { MarketplacePublisher } from "../manifest.js";

/**
 * The `agent-marketplace.yaml` format: which bundles a collection contains, and
 * which targets each is built for.
 *
 * `schemaVersion` is hand-owned and versions the source format authors write,
 * the sixth such version in this project. It is unrelated to the package
 * version, to `CONTRACT_VERSION`, to `PROFILE_SCHEMA_VERSION`, to the bundle
 * `schemaVersion`, or to the test-file one. See `docs/contract.md`.
 */
export const SUPPORTED_SPEC_SCHEMAS = ["1"] as const;
export const CURRENT_SPEC_SCHEMA = "1";

export const SPEC_FILENAME = "agent-marketplace.yaml";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const ROOT_KEYS = new Set([
  "schemaVersion",
  "name",
  "version",
  "description",
  "owner",
  "targets",
  "bundles",
]);
const BUNDLE_KEYS = new Set(["path", "include", "exclude"]);
const OWNER_KEYS = new Set(["name", "url", "email"]);

/** One bundle in a collection, with the targets it is built for. */
export interface SpecBundle {
  /** Spec-relative POSIX path, as written. */
  path: string;
  /** Absolute, symlink-resolved bundle root. */
  root: string;
  include?: AgentTarget[];
  exclude?: AgentTarget[];
}

export interface MarketplaceSpec {
  schemaVersion: string;
  name: string;
  version: string;
  description?: string;
  owner: MarketplacePublisher;
  targets: AgentTarget[];
  bundles: SpecBundle[];
  /** Absolute directory the spec file lives in; every bundle path resolves from it. */
  root: string;
  /** Absolute path to the spec file itself, for diagnostics. */
  file: string;
}

export interface SpecResult {
  spec: MarketplaceSpec;
  diagnostics: AgentDiagnostic[];
}

/**
 * The `AB9xx` error factory. The same three-line idiom appears in
 * `manifest.ts`, `package/index.ts`, and `install/index.ts`: `diagnostic()`
 * derives severity from quality and never returns `"error"`, so an error is
 * built by spreading and overriding.
 */
function error(
  diagnostics: AgentDiagnostic[],
  code: string,
  message: string,
  file: string,
  remediation?: string,
): void {
  diagnostics.push({
    ...diagnostic(code, message, "unsupported", {
      path: file,
      ...(remediation ? { remediation } : {}),
    }),
    severity: "error",
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Required non-empty string, reported as AB901 when missing and AB902 when malformed. */
function requiredString(
  value: unknown,
  field: string,
  file: string,
  diagnostics: AgentDiagnostic[],
): string {
  if (value === undefined || value === null || value === "") {
    error(diagnostics, "AB901", `Marketplace field '${field}' is required`, file);
    return "";
  }
  if (typeof value !== "string") {
    error(diagnostics, "AB902", `Marketplace field '${field}' must be a string`, file);
    return "";
  }
  return value;
}

function parseTargetList(
  value: unknown,
  field: string,
  file: string,
  diagnostics: AgentDiagnostic[],
): AgentTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    error(diagnostics, "AB902", `${field} must be an array of target ids`, file);
    return [];
  }
  const resolved: AgentTarget[] = [];
  for (const entry of value) {
    const id = String(entry);
    // `all` is the same spelling `--target all` accepts, so a spec and a flag
    // never disagree about what "everything" means.
    if (id === "all") {
      resolved.push(...TARGETS);
      continue;
    }
    if (!(TARGETS as readonly string[]).includes(id)) {
      error(
        diagnostics,
        "AB902",
        `Unknown target '${id}' in ${field}`,
        file,
        `Use one of: ${TARGETS.join(", ")}.`,
      );
      continue;
    }
    resolved.push(id as AgentTarget);
  }
  return [...new Set(resolved)];
}

function parseOwner(
  value: unknown,
  file: string,
  diagnostics: AgentDiagnostic[],
): MarketplacePublisher {
  if (value === undefined) {
    error(
      diagnostics,
      "AB901",
      "Marketplace field 'owner' is required",
      file,
      "Claude Code refuses a catalog with no owner.",
    );
    return { name: "" };
  }
  const owner = record(value);
  if (!owner) {
    error(diagnostics, "AB902", "Marketplace 'owner' must be a mapping", file);
    return { name: "" };
  }
  for (const key of Object.keys(owner))
    if (!OWNER_KEYS.has(key)) error(diagnostics, "AB902", `Unknown owner key '${key}'`, file);
  const name = requiredString(owner.name, "owner.name", file, diagnostics);
  const result: MarketplacePublisher = { name };
  if (typeof owner.url === "string") result.url = owner.url;
  if (typeof owner.email === "string") result.email = owner.email;
  return result;
}

/**
 * Bundle paths resolve from the spec file's directory and may not escape it,
 * including after resolving symlinks — the same containment rule component
 * paths inside a bundle follow. A path that escapes is refused rather than
 * followed.
 */
function parseBundle(
  value: unknown,
  index: number,
  root: string,
  file: string,
  diagnostics: AgentDiagnostic[],
): SpecBundle | undefined {
  const entry = record(value);
  if (!entry) {
    error(diagnostics, "AB902", `bundles[${index}] must be a mapping`, file);
    return undefined;
  }
  for (const key of Object.keys(entry))
    if (!BUNDLE_KEYS.has(key))
      error(diagnostics, "AB902", `Unknown bundles[${index}] key '${key}'`, file);

  const declared = requiredString(entry.path, `bundles[${index}].path`, file, diagnostics);
  if (!declared) return undefined;

  const include = parseTargetList(entry.include, `bundles[${index}].include`, file, diagnostics);
  const exclude = parseTargetList(entry.exclude, `bundles[${index}].exclude`, file, diagnostics);
  if (include && exclude) {
    error(
      diagnostics,
      "AB903",
      `bundles[${index}] declares both include and exclude`,
      file,
      "Use one or the other; they are not combined.",
    );
    return undefined;
  }

  const resolved = path.resolve(root, declared);
  if (!fs.existsSync(resolved)) {
    error(diagnostics, "AB904", `Bundle path '${declared}' does not exist`, file);
    return undefined;
  }
  const real = fs.realpathSync(resolved);
  if (!isInside(fs.realpathSync(root), real)) {
    error(
      diagnostics,
      "AB904",
      `Bundle path '${declared}' escapes the spec directory`,
      file,
      "A bundle must live inside the directory holding the spec file.",
    );
    return undefined;
  }
  if (!fs.statSync(real).isDirectory()) {
    error(diagnostics, "AB904", `Bundle path '${declared}' is not a directory`, file);
    return undefined;
  }

  return {
    path: declared,
    root: real,
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

/** True when `bundle` is built for `target` under its include/exclude declaration. */
export function selectedForTarget(bundle: SpecBundle, target: AgentTarget): boolean {
  if (bundle.include) return bundle.include.includes(target);
  if (bundle.exclude) return !bundle.exclude.includes(target);
  return true;
}

/**
 * Reads and validates a collection spec. Never throws for a content problem —
 * every finding is a diagnostic, so a caller reports all of them at once rather
 * than one per run. Only an unreadable or unparseable file throws.
 */
export function loadSpec(source: string): SpecResult {
  const file = path.resolve(source);
  const stat = fs.existsSync(file) ? fs.statSync(file) : undefined;
  const resolved = stat?.isDirectory() ? path.join(file, SPEC_FILENAME) : file;
  if (!fs.existsSync(resolved))
    throw new Error(`Marketplace spec not found: ${path.relative(process.cwd(), resolved)}`);

  const root = path.dirname(resolved);
  const raw = readStructured(resolved);
  const diagnostics: AgentDiagnostic[] = [];

  for (const key of Object.keys(raw))
    if (!ROOT_KEYS.has(key))
      error(diagnostics, "AB902", `Unknown marketplace key '${key}'`, resolved);

  const schemaVersion = String(raw.schemaVersion ?? "");
  if (!(SUPPORTED_SPEC_SCHEMAS as readonly string[]).includes(schemaVersion))
    error(
      diagnostics,
      "AB900",
      `Unsupported marketplace schemaVersion '${schemaVersion}'`,
      resolved,
      `Use schemaVersion: "${CURRENT_SPEC_SCHEMA}".`,
    );

  const name = requiredString(raw.name, "name", resolved, diagnostics);
  if (name && !NAME.test(name))
    error(
      diagnostics,
      "AB902",
      `Invalid marketplace name '${name}'`,
      resolved,
      "Use lowercase kebab-case; this becomes the marketplace key hosts index by.",
    );

  const version = requiredString(raw.version, "version", resolved, diagnostics);
  if (version && !SEMVER.test(version))
    error(
      diagnostics,
      "AB902",
      `Invalid marketplace version '${version}'`,
      resolved,
      "Use a semantic version such as 1.0.0.",
    );

  const description =
    raw.description === undefined
      ? undefined
      : typeof raw.description === "string"
        ? raw.description
        : (error(diagnostics, "AB902", "Marketplace 'description' must be a string", resolved),
          undefined);

  const owner = parseOwner(raw.owner, resolved, diagnostics);

  const targets = parseTargetList(raw.targets, "targets", resolved, diagnostics) ?? [];
  if (raw.targets === undefined)
    error(diagnostics, "AB901", "Marketplace field 'targets' is required", resolved);
  else if (targets.length === 0 && Array.isArray(raw.targets))
    error(diagnostics, "AB901", "Marketplace field 'targets' is empty", resolved);

  const bundles: SpecBundle[] = [];
  if (raw.bundles === undefined)
    error(diagnostics, "AB901", "Marketplace field 'bundles' is required", resolved);
  else if (!Array.isArray(raw.bundles))
    error(diagnostics, "AB902", "Marketplace 'bundles' must be an array", resolved);
  else if (raw.bundles.length === 0)
    error(diagnostics, "AB901", "Marketplace field 'bundles' is empty", resolved);
  else
    raw.bundles.forEach((entry, index) => {
      const parsed = parseBundle(entry, index, root, resolved, diagnostics);
      if (parsed) bundles.push(parsed);
    });

  // Two entries pointing at the same directory would render the same plugin
  // name twice into one catalog, which a host resolves arbitrarily.
  const seen = new Map<string, string>();
  for (const bundle of bundles) {
    const previous = seen.get(bundle.root);
    if (previous !== undefined)
      error(
        diagnostics,
        "AB905",
        `Bundles '${previous}' and '${bundle.path}' resolve to the same directory`,
        resolved,
      );
    else seen.set(bundle.root, bundle.path);
  }

  return {
    spec: {
      schemaVersion,
      name,
      version,
      ...(description !== undefined ? { description } : {}),
      owner,
      targets,
      bundles,
      root,
      file: resolved,
    },
    diagnostics,
  };
}
