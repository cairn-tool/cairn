import type { ExternalSchemaEntry, JsonSchema, SchemaEntry, SchemaRef } from "../types.js";
import { agentResultSchema } from "./agent.js";
import {
  diagnosticRecordSchema,
  issueListSchema,
  issueSchema,
  lintDirSummarySchema,
  mdAuditSchema,
  mdCheckSnippetsSchema,
  mdCheckUrlsSchema,
  mdContextSchema,
  mdDiffSchema,
  mdFixSchema,
  mdGraphSchema,
  mdIndexSchema,
  mdOrphansSchema,
  mdQuerySchema,
} from "./markdown.js";
import { archiveListingSchema, archiveResultSchema } from "./archive.js";
import { adfResultSchema } from "./jira.js";
import { pdfResultSchema } from "./pdf.js";
import { qaResultSchema } from "./qa.js";
import { checkUpdateSchema, describeSchema, envelopeSchema, schemaListSchema } from "./meta.js";
import { scriptListSchema, scriptRunSchema, scriptWhichSchema } from "./scripts.js";
import {
  usageIndexSchema,
  usageImportSchema,
  usageProvidersSchema,
  usageRollupSchema,
  usageSummarySchema,
} from "./usage.js";

/**
 * Every schema authored here.
 *
 * These are TypeScript modules rather than a data directory on purpose:
 * tsconfig sets `rootDir: "src"` with no `resolveJsonModule`, so `.json` files
 * would never reach `dist` and the package would ship without them.
 */
export const SCHEMAS: readonly SchemaEntry[] = [
  issueSchema,
  issueListSchema,
  diagnosticRecordSchema,
  lintDirSummarySchema,
  mdGraphSchema,
  mdAuditSchema,
  mdQuerySchema,
  mdCheckUrlsSchema,
  mdCheckSnippetsSchema,
  mdOrphansSchema,
  mdIndexSchema,
  mdContextSchema,
  mdDiffSchema,
  mdFixSchema,
  agentResultSchema,
  adfResultSchema,
  pdfResultSchema,
  qaResultSchema,
  scriptRunSchema,
  scriptWhichSchema,
  scriptListSchema,
  usageSummarySchema,
  usageRollupSchema,
  usageProvidersSchema,
  usageIndexSchema,
  usageImportSchema,
  archiveResultSchema,
  archiveListingSchema,
  checkUpdateSchema,
  schemaListSchema,
  envelopeSchema,
];

/** Schemas another project owns; `describe` is the cli-schema document. */
export const EXTERNAL_SCHEMAS: readonly ExternalSchemaEntry[] = [describeSchema];

export const SCHEMA_BY_ID: ReadonlyMap<string, SchemaEntry> = new Map(
  SCHEMAS.map((entry) => [entry.id, entry]),
);

const ref = ({ id, uri, title, commands }: SchemaRef): SchemaRef => ({ id, uri, title, commands });

/**
 * Every published schema, owned or external, without bodies — the listing
 * `schema` and `describe` report. `describe` keeps the position it held when
 * it was authored here, so the listing order is unchanged.
 */
export const SCHEMA_REFS: readonly SchemaRef[] = [
  ...SCHEMAS.slice(0, SCHEMAS.indexOf(schemaListSchema)).map(ref),
  ref(describeSchema),
  ...SCHEMAS.slice(SCHEMAS.indexOf(schemaListSchema)).map(ref),
];

export const SCHEMA_REF_BY_ID: ReadonlyMap<string, SchemaRef> = new Map(
  SCHEMA_REFS.map((entry) => [entry.id, entry]),
);

export function schemaUriFor(id: string | null | undefined): string | null {
  return (id && SCHEMA_REF_BY_ID.get(id)?.uri) ?? null;
}

/** The document behind a published id, or undefined when the id is not one. */
export async function loadSchema(id: string): Promise<JsonSchema | undefined> {
  const owned = SCHEMA_BY_ID.get(id);
  if (owned) return owned.schema;
  return EXTERNAL_SCHEMAS.find((entry) => entry.id === id)?.load();
}
