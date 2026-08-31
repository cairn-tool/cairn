import type { SchemaEntry } from "../types.js";
import { schemaUri } from "../version.js";
import { DRAFT } from "./shared.js";

/**
 * A conversion finding.
 *
 * Inlined rather than cross-referenced: a schema retrieved with
 * `cairn schema adf-result` must compile on its own, so no `$ref` leaves this
 * document.
 *
 * `code` is `AD###`, not the `AB###` an `AgentDiagnostic` carries. The two
 * finding families are separate on purpose — see docs/formats/diagnostics.md — and a
 * consumer keying suppression on the prefix can tell them apart.
 */
const DIAGNOSTIC = {
  type: "object",
  required: ["code", "severity", "message", "quality"],
  properties: {
    code: { type: "string", pattern: "^AD[0-9]{3}$" },
    severity: { enum: ["notice", "warning", "error"] },
    message: { type: "string" },
    quality: {
      enum: ["exact", "approximate", "unsupported"],
      description:
        "How faithfully the construct survived: exact has a direct equivalent, approximate emitted something else, unsupported emitted nothing.",
    },
    node: { type: "string", description: "ADF node or mark type the finding concerns." },
    location: {
      type: "string",
      description: "Slash-joined ancestor node types, e.g. 'doc/bulletList/listItem'.",
    },
    remediation: { type: "string" },
  },
};

/** One ADF node. Recursive within this document, which `$ref: "#/..."` permits. */
const NODE = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string" },
    attrs: { type: "object" },
    content: { type: "array", items: { $ref: "#/$defs/node" } },
    marks: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        properties: { type: { type: "string" }, attrs: { type: "object" } },
      },
    },
    text: { type: "string" },
  },
};

export const adfResultSchema: SchemaEntry = {
  id: "adf-result",
  uri: schemaUri("v1", "adf-result"),
  title: "cairn jira adf result",
  commands: [
    "jira adf to-markdown",
    "jira adf from-markdown",
    "jira adf validate",
    "jira adf inspect",
  ],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "adf-result"),
    title: "cairn jira adf result",
    description:
      "The --format json payload of every jira adf subcommand, including the failure form. Note that the default llm format writes the converted document alone to stdout; this shape appears only under --format json.",
    type: "object",
    required: ["command", "ok", "source", "diagnostics"],
    properties: {
      command: { enum: ["to-markdown", "from-markdown", "validate", "inspect"] },
      ok: {
        type: "boolean",
        description:
          "False when a blocking finding occurred. An approximation blocks only under --strict, so ok:true does not mean the conversion was lossless — read diagnostics for that.",
      },
      source: { type: "string", description: "Input path, or '-' for stdin." },
      markdown: { type: "string", description: "Emitted by to-markdown." },
      adf: {
        description: "Emitted by from-markdown. Keys are in canonical order.",
        allOf: [{ $ref: "#/$defs/node" }],
      },
      inventory: {
        type: "array",
        description: "Emitted by inspect: every node and mark type, counted and rated.",
        items: {
          type: "object",
          required: ["type", "kind", "count", "quality", "note"],
          properties: {
            type: { type: "string" },
            kind: { enum: ["node", "mark"] },
            count: { type: "integer", minimum: 1 },
            quality: { enum: ["exact", "approximate", "unsupported"] },
            note: { type: "string" },
          },
        },
      },
      output: { type: "string", description: "Absolute path written, when --output was given." },
      diagnostics: { type: "array", items: DIAGNOSTIC },
    },
    $defs: { node: NODE },
  },
};
