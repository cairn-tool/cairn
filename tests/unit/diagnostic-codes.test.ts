import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps `docs/formats/diagnostic-codes.md` honest in both directions.
 *
 * The same discipline `tests/e2e/contract.test.ts` applies to the command
 * registry: a code that ships undocumented fails here, and so does a documented
 * code no source file emits any more. A ~160-row hand-written table is only
 * maintainable because this test exists.
 */

const root = path.join(__dirname, "..", "..");

/**
 * Both families: `AB###` for agent bundles, `AD###` for ADF conversion.
 *
 * Built once and shared by the four matchers below. The pattern used to be
 * written out at each of them, which is three chances for a widening to be
 * applied inconsistently.
 */
const CODE = "A[BD]\\d{3}";
const EMITTED = new RegExp(`"(${CODE})"`, "g");
const ROW = new RegExp(`^\\|\\s*\`(${CODE})\`\\s*\\|`);
const ROW_WITH_SEVERITY = new RegExp(`^\\|\\s*\`(${CODE})\`\\s*\\|\\s*([a-z]+)\\s*\\|`);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Only quoted literals: prose in a comment naming a code is not an emitter. */
function emittedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of sourceFiles(path.join(root, "src")))
    for (const match of fs.readFileSync(file, "utf8").matchAll(EMITTED)) codes.add(match[1]);
  return codes;
}

function documentedCodes(): Set<string> {
  const page = fs.readFileSync(path.join(root, "docs/formats/diagnostic-codes.md"), "utf8");
  const codes = new Set<string>();
  for (const line of page.split("\n")) {
    const row = ROW.exec(line);
    if (row) codes.add(row[1]);
  }
  return codes;
}

function sorted(codes: Set<string>): string[] {
  return [...codes].sort();
}

describe("diagnostic code reference", () => {
  it("documents every code the source emits", () => {
    const undocumented = sorted(emittedCodes()).filter((code) => !documentedCodes().has(code));
    expect(undocumented).toEqual([]);
  });

  it("documents no code the source no longer emits", () => {
    const emitted = emittedCodes();
    const orphaned = sorted(documentedCodes()).filter((code) => !emitted.has(code));
    expect(orphaned).toEqual([]);
  });

  it("gives every documented code exactly one row", () => {
    const page = fs.readFileSync(path.join(root, "docs/formats/diagnostic-codes.md"), "utf8");
    const seen = new Map<string, number>();
    for (const line of page.split("\n")) {
      const row = ROW.exec(line);
      if (row) seen.set(row[1], (seen.get(row[1]) ?? 0) + 1);
    }
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  });

  it("gives every row a severity the diagnostic shape allows", () => {
    const page = fs.readFileSync(path.join(root, "docs/formats/diagnostic-codes.md"), "utf8");
    const allowed = new Set(["notice", "warning", "error", "varies"]);
    const bad: string[] = [];
    for (const line of page.split("\n")) {
      const row = ROW_WITH_SEVERITY.exec(line);
      if (row && !allowed.has(row[2])) bad.push(`${row[1]}: ${row[2]}`);
    }
    expect(bad).toEqual([]);
  });
});
