/**
 * Executable-format magic number.
 *
 * Header parsing only, mirroring `imageKind` in the packager: pulling in a
 * binary-format library to answer "is this an executable" would be a dependency
 * for a review nicety.
 *
 * Shared by `agent audit`, which grades a bundle's files, and by
 * `pdf attachments`, which grades an embedded file — for the reason
 * `src/mapping-quality.ts` was extracted. Importing it across toolsets instead
 * would drag the whole agent audit module, and its import graph, into `pdf`.
 */
export function binaryKind(content: Buffer): "elf" | "pe" | "macho" | null {
  if (content.length < 4) return null;
  if (content.subarray(0, 4).toString("hex") === "7f454c46") return "elf";
  if (content[0] === 0x4d && content[1] === 0x5a) return "pe";
  const magic = content.subarray(0, 4).toString("hex");
  if (["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic)) return "macho";
  return null;
}
