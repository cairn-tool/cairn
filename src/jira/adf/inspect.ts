import { FIDELITY, MARK_FIDELITY } from "./profile.js";
import type { AdfDocument, AdfNode, InventoryEntry } from "./types.js";

/**
 * Counts every node and mark type in a document and rates each against the
 * fidelity tables.
 *
 * The question this answers is "what will converting this cost me", asked before
 * paying it. A type absent from the fidelity tables is reported as `unsupported`
 * with a note saying so, rather than omitted — an inventory that quietly skips
 * what it does not recognize is worse than no inventory.
 */
export function inspectAdf(document: AdfDocument): InventoryEntry[] {
  const nodes = new Map<string, number>();
  const marks = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const walk = (node: AdfNode): void => {
    bump(nodes, node.type);
    for (const mark of node.marks ?? []) bump(marks, mark.type);
    for (const child of node.content ?? []) walk(child);
  };
  for (const child of document.content ?? []) walk(child);

  const entries: InventoryEntry[] = [];
  for (const [type, count] of nodes) {
    const rating = FIDELITY[type];
    entries.push({
      type,
      kind: "node",
      count,
      quality: rating?.quality ?? "unsupported",
      note: rating?.note ?? "Unrecognized by this tool's content model.",
    });
  }
  for (const [type, count] of marks) {
    const rating = MARK_FIDELITY[type];
    entries.push({
      type,
      kind: "mark",
      count,
      quality: rating?.quality ?? "unsupported",
      note: rating?.note ?? "Unrecognized by this tool's content model.",
    });
  }

  // Nodes before marks, then by byte comparison of the type. Never
  // `localeCompare`: it is ICU-build dependent and would reorder output on a
  // differently configured runner.
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "node" ? -1 : 1;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
}
