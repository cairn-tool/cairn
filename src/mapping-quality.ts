/**
 * How faithfully a concept survived a mapping between two formats.
 *
 * Shared by the agent-bundle renderer and the ADF converters. It lives here
 * rather than in either one because both diagnostic families derive severity
 * from it by the same rule, and a second copy would let the two drift.
 */
export type MappingQuality = "exact" | "approximate" | "unsupported";

export type DiagnosticSeverity = "notice" | "warning" | "error";

/**
 * Derives severity from quality rather than choosing it per site.
 *
 * A caller that means "refuse" sets `severity: "error"` explicitly afterward,
 * which is why an `unsupported` code can be either a warning (this feature does
 * not cross over) or an error (this input is invalid): the quality describes the
 * mapping, the severity describes the consequence.
 */
export function severityFor(quality: MappingQuality): DiagnosticSeverity {
  return quality === "exact" ? "notice" : "warning";
}
