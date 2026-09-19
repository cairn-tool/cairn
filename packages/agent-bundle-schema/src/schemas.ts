import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function load(name: string): Record<string, unknown> {
  return Object.freeze(
    JSON.parse(readFileSync(join(here, `${name}.json`), "utf8")) as Record<string, unknown>,
  );
}

/**
 * The inline bundle artifact: the one bundle a repository installs into itself.
 *
 * Frozen JSON Schema 2020-12 document. `$id` is an identifier, not a URL; the
 * document is self-contained, so validating against it needs nothing else.
 */
export const inlineAgentBundleSchema: Record<string, unknown> = load("inline-agent-bundle");

/** The collection artifact: every bundle a repository publishes for others. */
export const installableAgentBundlesSchema: Record<string, unknown> = load(
  "installable-agent-bundles",
);

/** Every schema this package publishes, keyed by the id `cairn schema` retrieves it under. */
export const SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  "inline-agent-bundle": inlineAgentBundleSchema,
  "installable-agent-bundles": installableAgentBundlesSchema,
});

export type SchemaId = keyof typeof SCHEMAS;

/**
 * Semantic version of the payload format both artifacts carry in
 * `schemaVersion`.
 *
 * Hand-owned and unrelated to this package's version, which semantic-release
 * sets from the commit history. A consumer accepts a higher patch or minor and
 * rejects a higher major.
 */
export const PAYLOAD_SCHEMA_VERSION = "1.0.0";
