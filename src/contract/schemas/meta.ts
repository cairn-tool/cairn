import { CLI_SCHEMA_URI, schemaUri } from "../version.js";
import type { ExternalSchemaEntry, SchemaEntry } from "../types.js";
import { DRAFT, stringArray } from "./shared.js";

export const checkUpdateSchema: SchemaEntry = {
  id: "check-update",
  uri: schemaUri("v1", "check-update"),
  title: "Update check result",
  commands: ["check-update"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "check-update"),
    title: "Update check result",
    description:
      "Written to stdout on success. When the registry cannot be reached, the same shape with `error` set is written to stderr and the command exits 1.",
    type: "object",
    required: ["current", "latest", "updateAvailable"],
    properties: {
      current: { type: "string" },
      latest: { type: ["string", "null"] },
      updateAvailable: { type: "boolean" },
      error: { type: "string", description: "Present only when the registry was unreachable." },
    },
  },
};

/**
 * `describe` conforms to the cli-schema specification, so the document it is
 * validated against is that project's, re-served here under the id consumers
 * already know. Loaded lazily: the library index compiles a validator at import.
 */
export const describeSchema: ExternalSchemaEntry = {
  id: "describe",
  uri: CLI_SCHEMA_URI,
  title: "CLI contract description",
  commands: ["describe"],
  load: async () => (await import("@cairn-tool/cli-schema")).cliSchema,
};

export const schemaListSchema: SchemaEntry = {
  id: "schema-list",
  uri: schemaUri("v1", "schema-list"),
  title: "Published schema index",
  commands: ["schema"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "schema-list"),
    title: "Published schema index",
    description:
      "Emitted by `schema --format json` with no id. With an id the schema itself is written instead, regardless of --format.",
    type: "object",
    required: ["schemaVersion", "schemas"],
    properties: {
      schemaVersion: { type: "string" },
      schemas: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "uri", "title", "commands"],
          properties: {
            id: { type: "string" },
            uri: { type: "string" },
            title: { type: "string" },
            commands: stringArray,
          },
        },
      },
    },
  },
};

export const envelopeSchema: SchemaEntry = {
  id: "envelope",
  uri: schemaUri("v1", "envelope"),
  title: "Result envelope",
  commands: [],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "envelope"),
    title: "Result envelope",
    description:
      "Opt-in wrapper produced by `--format json --envelope`. `data` holds the command's payload verbatim, so unwrapping it yields exactly the output of the same run without the flag.",
    type: "object",
    required: ["schemaVersion", "tool", "command", "ok", "exitCode", "data"],
    properties: {
      schemaVersion: { type: "string" },
      tool: {
        type: "object",
        required: ["name", "version"],
        properties: { name: { type: "string" }, version: { type: "string" } },
      },
      command: { type: "string", description: "Space-joined command path, e.g. 'md graph'." },
      ok: { type: "boolean" },
      exitCode: { enum: [0, 1, 2] },
      schema: {
        type: ["string", "null"],
        description: "Canonical `$id` of the schema describing `data`, or null when unpublished.",
      },
      data: { description: "The command payload, unchanged from its unenveloped form." },
      summary: {
        type: "object",
        description: "Optional command-specific counters.",
      },
    },
  },
};
