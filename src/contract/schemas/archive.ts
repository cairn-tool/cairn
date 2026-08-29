import type { JsonSchema, SchemaEntry } from "../types.js";
import { schemaUri } from "../version.js";
import { DRAFT, stringArray } from "./shared.js";

/**
 * Fragments are inlined into every document that needs them rather than shared
 * by `$ref`: a schema retrieved with `cairn schema <id>` must compile on
 * its own.
 */
const ARCHIVE: JsonSchema = {
  type: "object",
  description: "The archive on disk.",
  required: ["root"],
  properties: {
    root: { type: "string" },
    present: { type: "boolean" },
    schemaVersion: {
      type: "integer",
      minimum: 0,
      description:
        "Migrated schema version of the index. Hand-owned and migrated rather than discarded; unrelated to the contract version.",
    },
    segments: { type: "integer", minimum: 0 },
    blobs: {
      type: "integer",
      minimum: 0,
      description: "Distinct stored contents. Fewer than `artifacts` wherever files duplicate.",
    },
    artifacts: {
      type: "integer",
      minimum: 0,
      description: "Rows held, counting every version of every path.",
    },
    paths: { type: "integer", minimum: 0, description: "Distinct original paths." },
    bytes: { type: "integer", minimum: 0, description: "Uncompressed bytes of stored content." },
    compressedBytes: { type: "integer", minimum: 0, description: "Bytes the segments occupy." },
    updatedAt: { type: ["string", "null"] },
    byClass: {
      type: "object",
      description:
        "Per class. `bytes` sums each artifact row's content, so a file stored once under two paths counts twice here and once in the top-level `bytes`.",
      additionalProperties: {
        type: "object",
        properties: {
          artifacts: { type: "integer", minimum: 0 },
          bytes: { type: "integer", minimum: 0 },
        },
      },
    },
    byProvider: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
  },
};

const SOURCES: JsonSchema = {
  type: "array",
  description: "Log roots read, one per provider that had any.",
  items: {
    type: "object",
    required: ["provider", "root"],
    properties: { provider: { type: "string" }, root: { type: "string" } },
  },
};

export const archiveResultSchema: SchemaEntry = {
  id: "archive-result",
  uri: schemaUri("v1", "archive-result"),
  title: "Archive operation result",
  commands: ["archive run", "archive extract", "archive verify", "archive migrate"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "archive-result"),
    title: "Archive operation result",
    description:
      "Emitted by the `archive` subcommands that act rather than list, with `--format json`. `action` says which; the block naming that action is the one to read.",
    type: "object",
    required: ["action", "archive"],
    properties: {
      provider: { type: "string" },
      action: { enum: ["run", "dry-run", "extract", "verify", "migrate"] },
      archive: ARCHIVE,
      include: {
        ...stringArray,
        description: "Artifact classes this run took in.",
      },
      sources: SOURCES,
      run: {
        type: "object",
        description: "Present for `run` and `dry-run`.",
        properties: {
          discovered: { type: "integer", minimum: 0, description: "Files the sets matched." },
          unchanged: {
            type: "integer",
            minimum: 0,
            description: "Already indexed at this size and modification time; never opened.",
          },
          hashed: { type: "integer", minimum: 0, description: "Opened and hashed." },
          duplicate: {
            type: "integer",
            minimum: 0,
            description: "Hashed, but the content was already held; only a row was written.",
          },
          stored: { type: "integer", minimum: 0, description: "Written into a segment." },
          skipped: { type: "integer", minimum: 0, description: "Matched but unreadable." },
          bytes: { type: "integer", minimum: 0, description: "Uncompressed bytes added." },
          failures: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "reason"],
              properties: { file: { type: "string" }, reason: { type: "string" } },
            },
          },
        },
      },
      segments: {
        type: "array",
        description: "Segments sealed by this run.",
        items: {
          type: "object",
          required: ["name", "bytes", "blobs"],
          properties: {
            name: { type: "string" },
            bytes: { type: "integer", minimum: 0 },
            blobs: { type: "integer", minimum: 0 },
          },
        },
      },
      byClass: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            discovered: { type: "integer", minimum: 0 },
            stored: { type: "integer", minimum: 0 },
            bytes: { type: "integer", minimum: 0 },
          },
        },
      },
      extracted: {
        type: "object",
        description: "Present for `extract`.",
        required: ["path", "sha256", "bytes", "written"],
        properties: {
          path: { type: "string", description: "The original path the content was archived from." },
          sha256: { type: "string" },
          bytes: { type: "integer", minimum: 0 },
          written: { type: "string", description: "Where it was written now." },
        },
      },
      verify: {
        type: "object",
        description: "Present for `verify`.",
        required: ["segments", "checked", "findings"],
        properties: {
          segments: { type: "integer", minimum: 0 },
          blobs: { type: "integer", minimum: 0 },
          checked: {
            type: "integer",
            minimum: 0,
            description: "Segments whose bytes matched the index.",
          },
          deep: { type: "boolean" },
          findings: {
            type: "array",
            items: {
              type: "object",
              required: ["segment", "issue"],
              properties: { segment: { type: "string" }, issue: { type: "string" } },
            },
          },
        },
      },
      migrations: {
        type: "object",
        description: "Present for `migrate`.",
        required: ["from", "to", "applied", "pending"],
        properties: {
          from: { type: "integer", minimum: 0 },
          to: { type: "integer", minimum: 0 },
          applied: { type: "array", items: { type: "integer", minimum: 0 } },
          pending: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            description: "Non-empty only under `--check`, which reports without writing.",
          },
        },
      },
    },
  },
};

export const archiveListingSchema: SchemaEntry = {
  id: "archive-listing",
  uri: schemaUri("v1", "archive-listing"),
  title: "Archive listing",
  commands: ["archive status", "archive list"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "archive-listing"),
    title: "Archive listing",
    description:
      "Emitted by `archive status` and `archive list` with `--format json`. `files` holds one row per archived path, newest version first; earlier versions of the same path are counted in `versions` rather than listed.",
    type: "object",
    required: ["action", "archive"],
    properties: {
      action: { enum: ["status", "list"] },
      archive: ARCHIVE,
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["provider", "class", "path", "sha256", "size"],
          properties: {
            provider: { type: "string" },
            set: {
              type: "string",
              description: "The declared artifact set that matched this file.",
            },
            class: { enum: ["plan", "artifact", "transcript", "log"] },
            path: { type: "string", description: "The original path on disk." },
            sha256: { type: "string" },
            size: { type: "integer", minimum: 0 },
            firstSeen: { type: "string" },
            lastSeen: { type: "string" },
            versions: {
              type: "integer",
              minimum: 1,
              description: "Distinct contents the archive holds for this path.",
            },
          },
        },
      },
    },
  },
};
