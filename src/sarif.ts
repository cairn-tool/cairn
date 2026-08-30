/**
 * The SARIF 2.1.0 envelope, shared by the `md` diagnostic commands and by
 * `agent audit`.
 *
 * `JSON.stringify` follows insertion order, so both the document and each
 * caller's result objects must be built in a fixed order — this is what keeps
 * the `md` output byte-identical now that two producers share the envelope.
 */

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

export interface SarifRule {
  id: string;
  name: string;
}

export type SarifLevel = "error" | "warning" | "note";

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      /** Omitted by producers whose findings have no line. */
      region?: { startLine: number };
    };
  }>;
  properties?: Record<string, unknown>;
}

/** Renders one SARIF run. Returns without a trailing newline. */
export function sarifDocument(
  rules: readonly SarifRule[],
  results: readonly SarifResult[],
): string {
  return JSON.stringify(
    {
      version: SARIF_VERSION,
      $schema: SARIF_SCHEMA,
      runs: [
        {
          tool: {
            driver: {
              name: "cairn",
              informationUri: "https://github.com/cairn-tool/cairn",
              rules,
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}
