import fs from "node:fs";
import path from "node:path";
import { wrap } from "../../result.js";
import type { AgentDiagnostic } from "../types.js";

export interface WrittenArtifact {
  path: string;
  bytes: number;
  mode: string;
}

/**
 * Writes the standalone documentation artifact: the versioned result envelope
 * with the payload as its `data`.
 *
 * stdout carries an `AgentResult` like every other agent command, so a caller
 * piping this command gets the shape it already knows. The file is the other
 * thing -- the document a documentation pipeline publishes -- and it is the
 * envelope around the bare payload, not around a command result. That is the
 * form `kps-docs` reads from a docs branch, and the same split `agent convert`
 * makes when it writes `conversion-report.json` beside an unchanged stdout.
 */
export function writeArtifactFile(
  destination: string,
  command: string,
  schemaId: string,
  payload: unknown,
): WrittenArtifact {
  const target = path.resolve(destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const contents =
    JSON.stringify(wrap(payload, { command, ok: true, exitCode: 0, schema: schemaId }), null, 2) +
    "\n";
  fs.writeFileSync(target, contents, "utf8");
  return { path: target, bytes: Buffer.byteLength(contents), mode: "0644" };
}

/**
 * Whether anything went wrong badly enough to fail the command.
 *
 * Deliberately narrower than the agent toolset's usual {@link hasFindings}:
 * that treats any approximate mapping as a finding, and an approximate mapping
 * is exactly what these artifacts exist to document. Every Codex bundle carries
 * one, so the usual rule would make documenting one an error.
 */
export function hasBlockingFindings(diagnostics: AgentDiagnostic[], strict: boolean): boolean {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.severity === "warning"),
  );
}
