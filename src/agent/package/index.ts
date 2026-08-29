import crypto from "node:crypto";
import type {
  AgentBundle,
  AgentDiagnostic,
  AgentProfile,
  AgentTarget,
  Artifact,
} from "../types.js";
import { diagnostic } from "../types.js";
import type { MarketplaceEntryField, MarketplaceFieldTransform } from "../targets/index.js";
import { profileFor } from "../targets/index.js";
import { packageName, packageVersion } from "../../version.js";
import { archive } from "./tar.js";

export const PACKAGE_REPORT = "package-report.json";
export const CHECKSUMS = "checksums.sha256";
export const SBOM = "sbom.json";

export type MarketplaceMode = "repo" | "local" | "none";

export interface PackageArchive {
  target: AgentTarget;
  profile: AgentProfile;
  path: string;
  sha256: string;
  bytes: number;
}

export interface PackageReport {
  catalogs: Array<{ target: AgentTarget; profile: AgentProfile; path: string }>;
  archives: PackageArchive[];
  checksums: string;
  sbom: string;
  checks: { passed: number; failed: number };
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function error(
  code: string,
  message: string,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  return { ...diagnostic(code, message, "unsupported", extra), severity: "error" };
}

/**
 * Names the bundle key behind a catalog field, which is not always the catalog
 * key: Claude Code's `owner` and Cursor's `author` both come from
 * `marketplace.publisher`, so pointing at the catalog name would send an author
 * to a key that does not exist.
 */
function sourceField(field: MarketplaceEntryField): string {
  switch (field.source.from) {
    case "marketplace":
      return `marketplace.${field.source.field}`;
    case "manifest":
      return field.source.field;
    case "computed":
      return field.name;
  }
}

/** Reshapes a resolved value into the form the target's catalog declares. */
function reshape(value: unknown, transform: MarketplaceFieldTransform | undefined): unknown {
  switch (transform ?? "identity") {
    case "name":
      return value && typeof value === "object" ? (value as { name?: string }).name : value;
    case "first":
      return Array.isArray(value) ? value[0] : value;
    case "identity":
      return value;
  }
}

/** Resolves one catalog field from the manifest, the marketplace block, or the layout. */
function resolveField(field: MarketplaceEntryField, bundle: AgentBundle, source: string): unknown {
  switch (field.source.from) {
    case "computed":
      return reshape(source, field.transform);
    case "manifest":
      return reshape(
        (bundle.manifest as Record<string, unknown>)[field.source.field],
        field.transform,
      );
    case "marketplace":
      return reshape(
        (bundle.marketplace as Record<string, unknown> | undefined)?.[field.source.field],
        field.transform,
      );
  }
}

/**
 * Fills one catalog object from a field list, reporting AB500 per missing
 * requirement. Shared by the document and its entries so a target's identity
 * fields resolve by exactly the rules its plugin fields do.
 */
function collectFields(
  fields: MarketplaceEntryField[],
  bundle: AgentBundle,
  source: string,
  onMissing: (field: MarketplaceEntryField) => void,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = resolveField(field, bundle, source);
    if (empty(value)) {
      if (field.required) onMissing(field);
      continue;
    }
    result[field.name] = value;
  }
  return result;
}

function empty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Reads image dimensions from a PNG or JPEG header.
 *
 * Header parsing only — pulling in an image library to answer "is this a PNG"
 * would be a dependency for a validation nicety.
 */
export function imageKind(content: Buffer): "png" | "jpeg" | "svg" | null {
  if (content.length > 8 && content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (content.length > 3 && content[0] === 0xff && content[1] === 0xd8) return "jpeg";
  if (content.subarray(0, 512).toString("utf8").includes("<svg")) return "svg";
  return null;
}

export interface CatalogResult {
  artifacts: Artifact[];
  entries: PackageReport["catalogs"];
  diagnostics: AgentDiagnostic[];
}

/**
 * Builds a marketplace catalog per selected target.
 *
 * Field names and requirements come from the target profile, so the packager
 * itself contains no per-target branching and a catalog change is a data edit.
 */
export function buildCatalogs(
  bundle: AgentBundle,
  targets: AgentTarget[],
  profiles: AgentProfile[],
  mode: MarketplaceMode,
): CatalogResult {
  const artifacts: Artifact[] = [];
  const entries: PackageReport["catalogs"] = [];
  const diagnostics: AgentDiagnostic[] = [];
  if (mode === "none") return { artifacts, entries, diagnostics };

  for (const target of targets) {
    const spec = profileFor(target).marketplace;
    if (!spec) continue;
    const location = spec.catalog[mode];
    if (!location) {
      diagnostics.push(
        diagnostic("AB507", `${target} has no ${mode} marketplace catalog`, "unsupported", {
          target,
        }),
      );
      continue;
    }
    for (const profile of profiles) {
      if (profile !== "plugin") continue;
      const source = `./${target}/${profile}`;
      const missing = (field: MarketplaceEntryField): void => {
        diagnostics.push(
          error("AB500", `Catalog field '${field.name}' is required by ${target}`, {
            target,
            profile,
            remediation: `Set ${sourceField(field)} in agent-bundle.yaml.`,
          }),
        );
      };
      const document = collectFields(spec.documentFields ?? [], bundle, source, missing);
      const entry = collectFields(spec.entryFields, bundle, source, missing);
      // A catalog naming a version the manifest disagrees with would install
      // one thing and advertise another.
      if (entry.version !== undefined && entry.version !== bundle.version)
        diagnostics.push(
          error("AB501", `Catalog version '${String(entry.version)}' disagrees with the bundle`, {
            target,
            profile,
          }),
        );

      const catalogPath = `${target}/${profile}/${location.directory}/${location.file}`;
      artifacts.push({
        path: catalogPath,
        content: Buffer.from(
          JSON.stringify({ ...document, [spec.entriesKey]: [entry] }, null, 2) + "\n",
        ),
        mode: 0o644,
      });
      entries.push({ target, profile, path: catalogPath });
    }
  }
  return { artifacts, entries, diagnostics };
}

/** Validates declared marketplace assets against the target's asset rules. */
export function checkAssets(
  bundle: AgentBundle,
  targets: AgentTarget[],
  payload: Artifact[],
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const byName = new Map(payload.map((artifact) => [artifact.path, artifact]));
  for (const target of targets) {
    const spec = profileFor(target).marketplace;
    if (!spec) continue;
    for (const rule of spec.assets) {
      const declared =
        rule.role === "icon"
          ? bundle.marketplace?.icon
            ? [bundle.marketplace.icon]
            : []
          : (bundle.marketplace?.screenshots ?? []);
      if (!declared.length) {
        if (rule.required)
          diagnostics.push(
            error("AB502", `${target} requires a marketplace ${rule.role}`, {
              target,
              remediation: `Set marketplace.${rule.role === "icon" ? "icon" : "screenshots"}.`,
            }),
          );
        continue;
      }
      for (const reference of declared) {
        const found = [...byName.entries()].find(([candidate]) =>
          candidate.endsWith(`/${reference}`),
        )?.[1];
        if (!found) {
          diagnostics.push(
            error("AB502", `Marketplace ${rule.role} '${reference}' is not in the package`, {
              target,
              remediation: "Add it under the bundle's assets directory.",
            }),
          );
          continue;
        }
        if (!rule.extensions.some((extension) => reference.toLowerCase().endsWith(extension)))
          diagnostics.push(
            diagnostic(
              "AB503",
              `Marketplace ${rule.role} '${reference}' is not one of ${rule.extensions.join(", ")}`,
              "approximate",
              { target },
            ),
          );
        else if (imageKind(found.content) === null)
          diagnostics.push(
            diagnostic(
              "AB503",
              `Marketplace ${rule.role} '${reference}' does not look like an image`,
              "approximate",
              { target },
            ),
          );
        if (rule.maxBytes !== null && found.content.length > rule.maxBytes)
          diagnostics.push(
            diagnostic(
              "AB503",
              `Marketplace ${rule.role} '${reference}' exceeds ${rule.maxBytes} bytes`,
              "approximate",
              { target },
            ),
          );
      }
    }
  }
  return diagnostics;
}

/** Flags executable files outside the directories where a script belongs. */
export function checkExecutables(payload: Artifact[]): AgentDiagnostic[] {
  return payload
    .filter((artifact) => (artifact.mode & 0o111) !== 0)
    .filter((artifact) => !/(^|\/)(hooks|scripts|bin)\//.test(artifact.path))
    .map((artifact) =>
      diagnostic(
        "AB504",
        `Executable file outside hooks/, scripts/, or bin/: ${artifact.path}`,
        "approximate",
        { path: artifact.path, remediation: "Move it, or clear the execute bit." },
      ),
    );
}

/** Flags paths that collide when the filesystem is case-insensitive. */
export function checkCaseCollisions(payload: Artifact[]): AgentDiagnostic[] {
  const seen = new Map<string, string>();
  const diagnostics: AgentDiagnostic[] = [];
  for (const artifact of payload) {
    const key = artifact.path.toLowerCase();
    const existing = seen.get(key);
    if (existing && existing !== artifact.path)
      diagnostics.push(
        error("AB505", `Paths collide case-insensitively: '${existing}' and '${artifact.path}'`, {
          path: artifact.path,
        }),
      );
    else seen.set(key, artifact.path);
  }
  return diagnostics;
}

/** Notes MCP servers invoked through an unpinned package specifier. */
export function checkPinning(bundle: AgentBundle): AgentDiagnostic[] {
  const servers = bundle.mcp?.value.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const diagnostics: AgentDiagnostic[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const server = value as { command?: unknown; args?: unknown };
    if (server.command !== "npx" || !Array.isArray(server.args)) continue;
    const spec = server.args.map(String).find((arg) => !arg.startsWith("-"));
    // A bare package name resolves to whatever is newest at install time.
    if (spec && !/.@[^/]+$/.test(spec))
      diagnostics.push(
        diagnostic("AB506", `MCP server '${name}' invokes an unpinned package: ${spec}`, "exact", {
          path: bundle.mcp?.path,
          remediation: "Pin a version, for example package@1.2.3.",
        }),
      );
  }
  return diagnostics;
}

/** `sha256sum -c` compatible, sorted by byte order for reproducibility. */
export function buildChecksums(payload: Artifact[]): Artifact {
  const lines = payload
    .map((artifact) => `${sha256(artifact.content)}  ${artifact.path}`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  return { path: CHECKSUMS, content: Buffer.from(lines.join("\n") + "\n"), mode: 0o644 };
}

/**
 * Content-derived file type, as recorded in `sbom.json`. Exported because
 * `agent audit --baseline` reads that `type` field back and must classify the
 * current side by the same rule.
 */
export function classify(artifact: Artifact): string {
  if ((artifact.mode & 0o111) !== 0)
    return artifact.content.subarray(0, 2).toString("utf8") === "#!" ? "script" : "executable";
  if (artifact.content.includes(0)) return "binary";
  if (/\.(json|ya?ml|toml)$/i.test(artifact.path)) return "config";
  if (/\.md$/i.test(artifact.path)) return "document";
  return "asset";
}

/**
 * A file inventory, deliberately not a CycloneDX claim.
 *
 * `bomFormat` and `specVersion` identify it as this tool's own format so a
 * later `--sbom cyclonedx` can be added without changing what this one means.
 */
export function buildSbom(bundle: AgentBundle, payload: Artifact[]): Artifact {
  const document = {
    bomFormat: "cairn-inventory",
    specVersion: "1",
    generator: { name: packageName, version: packageVersion },
    subject: { name: bundle.name, version: bundle.version },
    components: payload.map((artifact) => ({
      path: artifact.path,
      type: classify(artifact),
      sha256: sha256(artifact.content),
      bytes: artifact.content.length,
      mode: `0${artifact.mode.toString(8)}`,
      origin: artifact.origin ?? "portable",
    })),
  };
  return {
    path: SBOM,
    content: Buffer.from(JSON.stringify(document, null, 2) + "\n"),
    mode: 0o644,
  };
}

/** One deterministic archive per target and profile. */
export function buildArchives(
  bundle: AgentBundle,
  payload: Artifact[],
  targets: AgentTarget[],
  profiles: AgentProfile[],
): { artifacts: Artifact[]; archives: PackageArchive[] } {
  const artifacts: Artifact[] = [];
  const archives: PackageArchive[] = [];
  for (const target of targets) {
    const spec = profileFor(target).marketplace;
    if (!spec) continue;
    for (const profile of profiles) {
      const prefix = `${target}/${profile}/`;
      const entries = payload
        .filter((artifact) => artifact.path.startsWith(prefix))
        .map((artifact) => ({
          path: artifact.path.slice(prefix.length),
          content: artifact.content,
          mode: artifact.mode,
        }));
      if (!entries.length) continue;
      const name = spec.archiveName
        .replace("{name}", bundle.name)
        .replace("{version}", bundle.version)
        .replace("{target}", target)
        .replace("{profile}", profile);
      const content = archive(entries);
      const destination = `archives/${name}`;
      artifacts.push({ path: destination, content, mode: 0o644 });
      archives.push({
        target,
        profile,
        path: destination,
        sha256: sha256(content),
        bytes: content.length,
      });
    }
  }
  return { artifacts, archives };
}
