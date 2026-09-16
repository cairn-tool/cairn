/**
 * Version of the contract surface itself: the envelope shape, the schema id
 * scheme, and the machine-stream guarantees.
 *
 * Hand-owned and unrelated to the semantic-release-managed package version.
 * Individual payload schemas are versioned separately by the major in their
 * `$id` path, so a breaking change to one command's output does not bump this.
 * The `describe` payload is the one shape not versioned here: it conforms to
 * the cli-schema specification and carries that project's `schemaVersion`.
 */
export const CONTRACT_VERSION = "4";

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

/**
 * The cli-schema document that `describe` conforms to. Owned by that project
 * and published here under the id `describe`; `tests/unit/contract-schemas.test.ts`
 * pins it against the library's own `cliSchema.$id`.
 */
export const CLI_SCHEMA_URI = "https://github.com/cairn-tool/cli-schema/v1/cli-schema.json";
