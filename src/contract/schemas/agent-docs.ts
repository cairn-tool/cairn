import type { ExternalSchemaEntry } from "../types.js";
import { schemaUri } from "../version.js";

/**
 * The agent bundle documentation artifacts.
 *
 * External rather than authored here, for the same reason `describe` is: the
 * documents are published as `@cairn-tool/agent-bundle-schema`, so something
 * that is not this CLI can validate an artifact without depending on the CLI.
 * They keep cairn's own `$id` namespace because cairn is what produces them.
 *
 * Loaded on demand. The package reads its schema files from disk and compiles
 * an Ajv validator, and this module sits under `src/result.ts` on every
 * command's path.
 */
export const inlineAgentBundleSchema: ExternalSchemaEntry = {
  id: "inline-agent-bundle",
  uri: schemaUri("v1", "inline-agent-bundle"),
  title: "Inline agent bundle documentation artifact",
  commands: ["agent docs"],
  load: async () => (await import("@cairn-tool/agent-bundle-schema")).inlineAgentBundleSchema,
};

export const installableAgentBundlesSchema: ExternalSchemaEntry = {
  id: "installable-agent-bundles",
  uri: schemaUri("v1", "installable-agent-bundles"),
  title: "Installable agent bundles documentation artifact",
  commands: ["agent collection-docs"],
  load: async () => (await import("@cairn-tool/agent-bundle-schema")).installableAgentBundlesSchema,
};
