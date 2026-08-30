/**
 * Version of the contract surface itself: the envelope shape, the `describe`
 * payload, the schema id scheme, and the machine-stream guarantees.
 *
 * Hand-owned and unrelated to the semantic-release-managed package version.
 * Individual payload schemas are versioned separately by the major in their
 * `$id` path, so a breaking change to one command's output does not bump this.
 */
export const CONTRACT_VERSION = "3";

export const SCHEMA_BASE = "https://github.com/cairn-tool/cairn/schema";

/** Major version segment of a schema id path. */
export type SchemaMajor = "v1";

/**
 * Builds a schema `$id`. These are identifiers, not fetchable URLs — retrieve a
 * schema with `cairn schema <id>`. Ajv resolves by registered `$id` and
 * never performs network access, so this is correct JSON Schema usage.
 */
export function schemaUri(major: SchemaMajor, id: string): string {
  return `${SCHEMA_BASE}/${major}/${id}.json`;
}

/** SARIF is an external standard; it is referenced, never redefined here. */
export const SARIF_SCHEMA_URI = "https://json.schemastore.org/sarif-2.1.0.json";
