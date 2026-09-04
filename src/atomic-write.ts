import fs from "node:fs";
import path from "node:path";

/**
 * Writes one file atomically: staged beside the destination with `wx`, then
 * renamed. The same pattern as `src/edit-plan.ts`; `src/agent/writer.ts` stages
 * whole artifact trees and is the wrong tool for a single file.
 *
 * Shared by `jira adf --output`, `pdf --output`, and `pdf attachments --extract`
 * rather than copied into each, for the reason `src/mapping-quality.ts` was
 * extracted: the `wx` flag, the directory refusal, and the unlink-on-rename-failure
 * are one invariant, and a second copy is how the two stop agreeing. The refusal
 * message is user-facing text in two toolsets' documented behavior and must be one
 * string.
 *
 * `content` widened to accept bytes when `pdf attachments --extract` needed to
 * write an embedded file, which is binary and must not go through a utf-8 encode.
 *
 * Note what the `wx` does and does not buy: it guards the *staging* file, so two
 * processes cannot stage over each other. The `rename` still replaces whatever is
 * at the destination. That is right for `--output`, which names one file the user
 * asked to write, and wrong for extracting many attacker-named files — so
 * `src/pdf/attachments.ts` resolves collisions while planning, before calling this.
 */
export function writeAtomically(destination: string, content: string | Uint8Array): void {
  const resolved = path.resolve(destination);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())
    throw new Error(`--output is a directory: ${destination}`);
  const staged = `${resolved}.cairn-${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (typeof content === "string")
    fs.writeFileSync(staged, content, { encoding: "utf-8", flag: "wx" });
  else fs.writeFileSync(staged, content, { flag: "wx" });
  try {
    fs.renameSync(staged, resolved);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}
