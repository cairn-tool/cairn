/**
 * Reading a ustar archive.
 *
 * The counterpart to `src/agent/package/tar.ts`, which has only ever written.
 * Kept in a separate module because an archive that can be read back is what
 * makes the artifact store an archive rather than a write-only pile: `archive
 * extract` and `archive verify --deep` both go through here.
 *
 * Only the ustar features the writer emits are handled — regular files,
 * directories, and the `prefix` split for long paths. A PAX or GNU long-name
 * header is reported rather than guessed at, because this reader's whole job is
 * to say exactly what a segment contains.
 */

const BLOCK = 512;

export interface TarMember {
  /** Path inside the archive, with the `prefix` field rejoined. */
  path: string;
  mode: number;
  size: number;
  /** Byte offset of the member's *data* within the uncompressed archive. */
  offset: number;
  directory: boolean;
}

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarFormatError";
  }
}

function cstring(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number {
  const text = cstring(block, start, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new TarFormatError(`Malformed octal field: ${text}`);
  return value;
}

function isZero(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/**
 * Lists what an uncompressed archive holds, without copying any file data.
 *
 * The offsets this returns are what the archive index stores, so a later
 * extraction can decompress a segment and slice straight to one member rather
 * than walking every header again.
 */
export function listMembers(tar: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let position = 0;

  while (position + BLOCK <= tar.length) {
    const header = tar.subarray(position, position + BLOCK);
    if (isZero(header)) break; // End-of-archive marker.

    const magic = cstring(header, 257, 6);
    if (magic !== "ustar") {
      throw new TarFormatError(
        `Not a ustar header at offset ${position}: magic ${magic || "(none)"}`,
      );
    }
    const type = cstring(header, 156, 1) || "0";
    if (type !== "0" && type !== "" && type !== "5") {
      throw new TarFormatError(`Unsupported ustar entry type ${type} at offset ${position}`);
    }

    const name = cstring(header, 0, 100);
    const prefix = cstring(header, 345, 155);
    const size = octal(header, 124, 12);
    const directory = type === "5";
    const joined = prefix ? `${prefix}/${name}` : name;

    members.push({
      // The writer appends a slash to a directory entry's name; drop it so the
      // path matches what an entry list would have called it.
      path: directory ? joined.replace(/\/+$/, "") : joined,
      mode: octal(header, 100, 8),
      size,
      offset: position + BLOCK,
      directory,
    });

    const padded = Math.ceil(size / BLOCK) * BLOCK;
    position += BLOCK + (directory ? 0 : padded);
  }

  return members;
}

/** The bytes of one member, from the uncompressed archive it was listed in. */
export function readMember(tar: Buffer, member: TarMember): Buffer {
  const end = member.offset + member.size;
  if (end > tar.length) {
    throw new TarFormatError(
      `Member ${member.path} runs past the end of the archive (${end} > ${tar.length})`,
    );
  }
  return tar.subarray(member.offset, end);
}
