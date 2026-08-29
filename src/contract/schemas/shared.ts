import type { JsonSchema } from "../types.js";

export const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The shared finding record. Duplicated inline into every schema that needs it
 * rather than cross-referenced: a schema retrieved with `cairn schema <id>`
 * must be independently compilable, so no `$ref` may leave its own document.
 */
export const ISSUE_DEF: JsonSchema = {
  type: "object",
  required: ["file", "line", "checker", "message"],
  properties: {
    file: { type: "string", description: "Path to the file the finding is in." },
    line: { type: "integer", minimum: 0, description: "1-indexed line, or 1 when unpositioned." },
    checker: {
      type: "string",
      description: "Which check produced the finding, e.g. 'katex' or 'frontmatter/schema'.",
    },
    message: { type: "string" },
  },
};

/** Helper for a `{ [key: string]: integer }` tally. */
export const countMap: JsonSchema = {
  type: "object",
  additionalProperties: { type: "integer", minimum: 0 },
};

export const stringArray: JsonSchema = { type: "array", items: { type: "string" } };
