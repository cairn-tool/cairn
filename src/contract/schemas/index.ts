import type { SchemaEntry } from "../types.js";
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
 * Every published schema.
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
  describeSchema,
  schemaListSchema,
  envelopeSchema,
];

export const SCHEMA_BY_ID: ReadonlyMap<string, SchemaEntry> = new Map(
  SCHEMAS.map((entry) => [entry.id, entry]),
);

export function schemaUriFor(id: string | null | undefined): string | null {
  return (id && SCHEMA_BY_ID.get(id)?.uri) ?? null;
}
