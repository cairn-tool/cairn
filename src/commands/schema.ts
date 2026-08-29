import { BASE_FORMATS } from "../formats.js";
import { SCHEMAS, SCHEMA_BY_ID } from "../contract/schemas/index.js";
import { CONTRACT_VERSION } from "../contract/version.js";

export interface SchemaCommandOptions {
  format: string;
}

/**
 * Retrieves a published output schema, or lists what is available.
 *
 * A schema is itself a JSON document, so it is written verbatim regardless of
 * `--format`; the flag only affects the index listing.
 */
export async function schemaAction(
  id: string | undefined,
  opts: SchemaCommandOptions,
): Promise<void> {
  const format = opts.format || "llm";
  if (!BASE_FORMATS.includes(format as (typeof BASE_FORMATS)[number]))
    throw new Error(`Invalid output format: ${format}`);

  if (id) {
    const entry = SCHEMA_BY_ID.get(id);
    if (!entry)
      throw new Error(
        `Unknown schema id: ${id}. Run "cairn schema" to list the published schemas.`,
      );
    process.stdout.write(JSON.stringify(entry.schema, null, 2) + "\n");
    return;
  }

  const index = SCHEMAS.map(({ id: schemaId, uri, title, commands }) => ({
    id: schemaId,
    uri,
    title,
    commands,
  }));
  if (format === "json") {
    process.stdout.write(
      JSON.stringify({ schemaVersion: CONTRACT_VERSION, schemas: index }, null, 2) + "\n",
    );
    return;
  }
  const width = Math.max(...index.map((entry) => entry.id.length));
  process.stdout.write(
    index.map((entry) => `${entry.id.padEnd(width)}  ${entry.title}`).join("\n") + "\n",
  );
}
