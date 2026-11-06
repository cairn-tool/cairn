import { UnsupportedEncryption, standardDecryptor } from "./crypt.js";
import { DecodeBudgetExceeded, decodeChain, filterChain } from "./filters.js";
import {
  Lexer,
  PdfSyntaxError,
  indexOf,
  isDict,
  isName,
  isRef,
  isStream,
  latin1,
  parseIndirect,
  parseObject,
} from "./syntax.js";
import type { Decryptor, PdfDict, PdfObject, PdfRef, PdfStream } from "./syntax.js";

/**
 * The object store: cross-reference resolution, object streams, and decryption.
 *
 * It reads the cross-reference sections the file declares — classic tables,
 * cross-reference streams, hybrids, and the `/Prev` chain of incremental
 * updates — and falls back to a brute-force `N G obj` scan when they are absent
 * or wrong, which is the same recovery pdf.js performs. Object streams
 * (`/ObjStm`) are inflated on demand; modern producers put most objects in them.
 */

type Entry =
  | { type: "offset"; offset: number; gen: number }
  | { type: "compressed"; stream: number; index: number };

/** Resolution depth: a chain of references this long is a cycle or an attack. */
const MAX_RESOLVE_DEPTH = 32;

/** An object stream may claim at most this many members. */
const MAX_OBJSTM_MEMBERS = 100_000;

export interface StoreNotes {
  /** True when the declared cross-reference was unusable and objects were found by scanning. */
  rebuilt: boolean;
  encrypted: boolean;
}

export class ObjectStore {
  private readonly entries = new Map<number, Entry>();
  private readonly cache = new Map<number, PdfObject>();
  private readonly objectStreams = new Map<
    number,
    { offsets: number[]; nums: number[]; data: Uint8Array; first: number }
  >();
  private scanned: Map<number, number> | null = null;
  private resolving = new Set<number>();
  private decryptor:
    (Decryptor & { stream(bytes: Uint8Array, num: number, gen: number): Uint8Array }) | null = null;
  private encryptNum = -1;
  trailer: PdfDict = { kind: "dict", map: new Map() };
  readonly notes: StoreNotes = { rebuilt: false, encrypted: false };

  constructor(
    readonly bytes: Uint8Array,
    /** Bounds every decode the store performs on its own behalf. */
    readonly decodeLimit: number,
  ) {
    this.load();
  }

  private load(): void {
    let loaded: boolean;
    try {
      loaded = this.readDeclaredXref();
    } catch {
      loaded = false;
    }
    if (!loaded || !this.trailer.map.get("Root")) this.rebuild();

    const encrypt = this.trailer.map.get("Encrypt");
    if (encrypt !== undefined && encrypt !== null) {
      this.notes.encrypted = true;
      if (isRef(encrypt)) this.encryptNum = encrypt.num;
      const dict = this.resolve(encrypt);
      if (isDict(dict)) {
        // Constructed after the Encrypt dictionary is read, so its own strings
        // are never run through the cipher they define.
        this.cache.clear();
        this.decryptor = standardDecryptor(
          dict,
          this.resolve(this.trailer.map.get("ID") ?? null),
          (value) => this.resolve(value),
        );
      }
    }
  }

  /** Follows `startxref` and every `/Prev`. Returns false when there is nothing usable. */
  private readDeclaredXref(): boolean {
    const { bytes } = this;
    const tail = Math.max(0, bytes.length - 4096);
    let marker = -1;
    for (
      let at = indexOf(bytes, "startxref", tail);
      at >= 0;
      at = indexOf(bytes, "startxref", at + 9)
    )
      marker = at;
    if (marker < 0) return false;
    const lexer = new Lexer(bytes, marker + 9);
    const token = lexer.next();
    if (token.type !== "number") return false;

    const visited = new Set<number>();
    let offset: number | null = token.value;
    let first = true;
    while (offset !== null && !visited.has(offset) && visited.size < 64) {
      visited.add(offset);
      const section = this.readSection(offset);
      if (!section) return !first;
      if (first) this.trailer = section;
      first = false;
      const xrefStm = section.map.get("XRefStm");
      if (typeof xrefStm === "number" && !visited.has(xrefStm)) {
        visited.add(xrefStm);
        this.readSection(xrefStm);
      }
      const previous = section.map.get("Prev");
      offset = typeof previous === "number" ? previous : null;
    }
    return true;
  }

  /** Reads one section at `offset`: a table plus trailer, or a stream. Returns its trailer dictionary. */
  private readSection(offset: number): PdfDict | null {
    const { bytes } = this;
    if (offset < 0 || offset >= bytes.length) return null;
    const lexer = new Lexer(bytes, offset);
    const head = lexer.next();
    if (head.type === "keyword" && head.value === "xref") return this.readTable(lexer);
    if (head.type === "number") return this.readXrefStream(offset);
    return null;
  }

  private readTable(lexer: Lexer): PdfDict | null {
    for (;;) {
      const startToken = lexer.next();
      if (startToken.type === "keyword" && startToken.value === "trailer") {
        const trailer = parseObject(lexer);
        return isDict(trailer) ? trailer : null;
      }
      if (startToken.type !== "number") return null;
      const countToken = lexer.next();
      if (countToken.type !== "number") return null;
      for (let index = 0; index < countToken.value; index += 1) {
        const offsetToken = lexer.next();
        const genToken = lexer.next();
        const kindToken = lexer.next();
        if (
          offsetToken.type !== "number" ||
          genToken.type !== "number" ||
          kindToken.type !== "keyword"
        )
          return null;
        const num = startToken.value + index;
        if (kindToken.value === "n" && !this.entries.has(num) && offsetToken.value > 0)
          this.entries.set(num, { type: "offset", offset: offsetToken.value, gen: genToken.value });
        else if (kindToken.value === "f" && !this.entries.has(num))
          this.entries.set(num, { type: "offset", offset: -1, gen: genToken.value });
      }
    }
  }

  private readXrefStream(offset: number): PdfDict | null {
    const parsed = parseIndirect(this.bytes, offset);
    const stream = parsed.value;
    if (!isStream(stream) || !isName(stream.dict.map.get("Type"), "XRef")) return null;
    const { dict } = stream;
    // A cross-reference stream is never encrypted, and its filters never reference
    // other objects, so it decodes without the store.
    const data = decodeChain(stream.raw, filterChain(dict), this.decodeLimit).data;
    const widths = dict.map.get("W");
    if (!Array.isArray(widths) || widths.length < 3) return null;
    const [w0, w1, w2] = widths.map((value) => (typeof value === "number" ? value : 0));
    const size = typeof dict.map.get("Size") === "number" ? (dict.map.get("Size") as number) : 0;
    const indexArray = dict.map.get("Index");
    const ranges: number[] = Array.isArray(indexArray)
      ? indexArray.map((value) => (typeof value === "number" ? value : 0))
      : [0, size];
    const rowWidth = w0 + w1 + w2;
    if (rowWidth <= 0) return null;
    const field = (at: number, width: number): number => {
      let value = 0;
      for (let index = 0; index < width; index += 1) value = value * 256 + data[at + index];
      return value;
    };
    let at = 0;
    for (let range = 0; range + 1 < ranges.length; range += 2) {
      const start = ranges[range];
      const count = ranges[range + 1];
      for (let index = 0; index < count && at + rowWidth <= data.length; index += 1) {
        const type = w0 === 0 ? 1 : field(at, w0);
        const second = field(at + w0, w1);
        const third = field(at + w0 + w1, w2);
        at += rowWidth;
        const num = start + index;
        if (this.entries.has(num)) continue;
        if (type === 1) this.entries.set(num, { type: "offset", offset: second, gen: third });
        else if (type === 2)
          this.entries.set(num, { type: "compressed", stream: second, index: third });
        else this.entries.set(num, { type: "offset", offset: -1, gen: third });
      }
    }
    return dict;
  }

  /**
   * Indexes every `N G obj` in the file, last occurrence winning, and finds a
   * trailer — the last `trailer` dictionary, or a cross-reference stream's.
   */
  private rebuild(): void {
    this.notes.rebuilt = true;
    const scanned = this.scan();
    let trailer: PdfDict | null = null;
    for (
      let at = indexOf(this.bytes, "trailer", 0);
      at >= 0;
      at = indexOf(this.bytes, "trailer", at + 7)
    ) {
      try {
        const value = parseObject(new Lexer(this.bytes, at + 7));
        if (isDict(value) && value.map.get("Root")) trailer = value;
      } catch {
        // keep looking
      }
    }
    for (const [num, offset] of scanned) {
      if (!this.entries.has(num) || this.entries.get(num)?.type === "offset")
        this.entries.set(num, { type: "offset", offset, gen: 0 });
    }
    if (!trailer) {
      for (const [, offset] of scanned) {
        try {
          const parsed = parseIndirect(this.bytes, offset);
          if (
            isStream(parsed.value) &&
            isName(parsed.value.dict.map.get("Type"), "XRef") &&
            parsed.value.dict.map.get("Root")
          ) {
            trailer = parsed.value.dict;
          }
        } catch {
          // skip
        }
      }
    }
    if (!trailer) {
      // No trailer at all: find the catalog directly.
      for (const [num, offset] of scanned) {
        try {
          const parsed = parseIndirect(this.bytes, offset);
          if (isDict(parsed.value) && isName(parsed.value.map.get("Type"), "Catalog")) {
            trailer = {
              kind: "dict",
              map: new Map([["Root", { kind: "ref", num, gen: parsed.gen }]]),
            };
          }
        } catch {
          // skip
        }
      }
    }
    if (trailer) this.trailer = trailer;
    // Members of object streams the scan cannot see directly.
    for (const [num, offset] of scanned) {
      try {
        const parsed = parseIndirect(this.bytes, offset);
        if (isStream(parsed.value) && isName(parsed.value.dict.map.get("Type"), "ObjStm")) {
          const members = this.objectStream(num);
          members?.nums.forEach((member, index) => {
            if (!scanned.has(member))
              this.entries.set(member, { type: "compressed", stream: num, index });
          });
        }
      } catch {
        // skip
      }
    }
  }

  private scan(): Map<number, number> {
    if (this.scanned) return this.scanned;
    const found = new Map<number, number>();
    const { bytes } = this;
    for (let at = indexOf(bytes, "obj", 0); at >= 0; at = indexOf(bytes, "obj", at + 3)) {
      // Walk back over `N G ` before the keyword.
      let cursor = at - 1;
      while (
        cursor >= 0 &&
        (bytes[cursor] === 0x20 || bytes[cursor] === 0x0a || bytes[cursor] === 0x0d)
      )
        cursor -= 1;
      const genEnd = cursor + 1;
      while (cursor >= 0 && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor -= 1;
      if (cursor + 1 === genEnd) continue;
      while (
        cursor >= 0 &&
        (bytes[cursor] === 0x20 || bytes[cursor] === 0x0a || bytes[cursor] === 0x0d)
      )
        cursor -= 1;
      const numEnd = cursor + 1;
      while (cursor >= 0 && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor -= 1;
      if (cursor + 1 === numEnd) continue;
      const after = bytes[at + 3];
      if (
        after !== undefined &&
        after > 0x20 &&
        after !== 0x3c &&
        after !== 0x5b &&
        after !== 0x2f &&
        after !== 0x28
      )
        continue;
      const num = Number(latin1(bytes, cursor + 1, numEnd));
      if (Number.isSafeInteger(num)) found.set(num, cursor + 1);
    }
    this.scanned = found;
    return found;
  }

  private objectStream(
    num: number,
  ): { offsets: number[]; nums: number[]; data: Uint8Array; first: number } | null {
    const cached = this.objectStreams.get(num);
    if (cached) return cached;
    const value = this.get(num);
    if (!isStream(value)) return null;
    const data = this.streamData(value);
    const count = Math.min(
      MAX_OBJSTM_MEMBERS,
      Number(this.resolve(value.dict.map.get("N") ?? 0)) || 0,
    );
    const first = Number(this.resolve(value.dict.map.get("First") ?? 0)) || 0;
    const lexer = new Lexer(data, 0, Math.min(first, data.length));
    const nums: number[] = [];
    const offsets: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const a = lexer.next();
      const b = lexer.next();
      if (a.type !== "number" || b.type !== "number") break;
      nums.push(a.value);
      offsets.push(b.value);
    }
    const entry = { offsets, nums, data, first };
    this.objectStreams.set(num, entry);
    return entry;
  }

  /** A stream's bytes with decryption applied and every non-image filter decoded. */
  streamData(stream: PdfStream): Uint8Array {
    return decodeChain(
      this.decrypted(stream),
      filterChain(stream.dict, (value) => this.resolve(value)),
      this.decodeLimit,
    ).data;
  }

  /** A stream's raw bytes, deciphered when the file is encrypted. Filters are not applied. */
  decrypted(stream: PdfStream): Uint8Array {
    if (!this.decryptor || !stream.ref || stream.ref.num === this.encryptNum) return stream.raw;
    if (isName(stream.dict.map.get("Type"), "XRef")) return stream.raw;
    return this.decryptor.stream(stream.raw, stream.ref.num, stream.ref.gen);
  }

  /** The object with number `num`, or null when it is free or cannot be read. */
  get(num: number): PdfObject {
    if (this.cache.has(num)) return this.cache.get(num) ?? null;
    if (this.resolving.has(num)) return null;
    this.resolving.add(num);
    try {
      const value = this.read(num);
      this.cache.set(num, value);
      return value;
    } finally {
      this.resolving.delete(num);
    }
  }

  private read(num: number): PdfObject {
    const entry = this.entries.get(num);
    const decryptor = this.decryptor && num !== this.encryptNum ? this.decryptor : undefined;
    const resolveLength = (ref: PdfRef): number | undefined => {
      const value = this.get(ref.num);
      return typeof value === "number" ? value : undefined;
    };
    const direct = (offset: number): PdfObject | undefined => {
      try {
        const parsed = parseIndirect(this.bytes, offset, { resolveLength, decryptor });
        if (parsed.num !== num) return undefined;
        return parsed.value;
      } catch (error) {
        if (error instanceof PdfSyntaxError) return undefined;
        throw error;
      }
    };

    if (entry?.type === "offset") {
      if (entry.offset < 0) return null;
      const value = direct(entry.offset);
      if (value !== undefined) return value;
    } else if (entry?.type === "compressed") {
      const members = this.objectStream(entry.stream);
      if (members) {
        let position = members.nums[entry.index] === num ? entry.index : members.nums.indexOf(num);
        if (position < 0) position = entry.index;
        const offset = members.offsets[position];
        if (offset !== undefined) {
          try {
            return parseObject(new Lexer(members.data, members.first + offset));
          } catch {
            // fall through to the scan
          }
        }
      }
    }
    // The declared location was wrong: the scan is the last word.
    const scanned = this.scan().get(num);
    if (scanned !== undefined) {
      if (!this.notes.rebuilt && entry) this.notes.rebuilt = true;
      return direct(scanned) ?? null;
    }
    return null;
  }

  /** Follows references until a direct object, or null. */
  resolve(value: PdfObject | undefined): PdfObject {
    let current: PdfObject = value ?? null;
    for (let depth = 0; isRef(current) && depth < MAX_RESOLVE_DEPTH; depth += 1)
      current = this.get(current.num);
    return isRef(current) ? null : current;
  }

  /** `dict[key]`, resolved. */
  lookup(dict: PdfDict | null | undefined, key: string): PdfObject {
    if (!dict) return null;
    return this.resolve(dict.map.get(key));
  }

  dictAt(dict: PdfDict | null | undefined, key: string): PdfDict | null {
    const value = this.lookup(dict, key);
    if (isDict(value)) return value;
    if (isStream(value)) return value.dict;
    return null;
  }

  catalog(): PdfDict | null {
    const root = this.resolve(this.trailer.map.get("Root"));
    return isDict(root) ? root : null;
  }
}

export { DecodeBudgetExceeded, UnsupportedEncryption };

/**
 * One page as the object layer sees it: its dictionary and the inherited values
 * a page may take from an ancestor `/Pages` node.
 */
export interface PageNode {
  dict: PdfDict;
  ref: PdfRef | null;
  resources: PdfDict | null;
  mediaBox: number[];
  cropBox: number[];
  rotate: number;
}

const MAX_PAGE_TREE_DEPTH = 64;

function box(value: PdfObject): number[] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map((item) => (typeof item === "number" ? item : 0));
  return [
    Math.min(numbers[0], numbers[2]),
    Math.min(numbers[1], numbers[3]),
    Math.max(numbers[0], numbers[2]),
    Math.max(numbers[1], numbers[3]),
  ];
}

/**
 * Walks the page tree in document order, carrying inheritable attributes.
 *
 * A node visited twice is skipped rather than followed, so a cyclic tree
 * terminates; pdf.js refuses such a document before this runs anyway.
 */
export function pageList(store: ObjectStore, limit: number): PageNode[] {
  const pages: PageNode[] = [];
  const seen = new Set<number>();
  const catalog = store.catalog();
  if (!catalog) return pages;
  const visit = (
    value: PdfObject,
    inherited: {
      resources: PdfDict | null;
      mediaBox: number[] | null;
      cropBox: number[] | null;
      rotate: number;
    },
    depth: number,
  ): void => {
    if (depth > MAX_PAGE_TREE_DEPTH || pages.length >= limit) return;
    if (isRef(value)) {
      if (seen.has(value.num)) return;
      seen.add(value.num);
    }
    const node = store.resolve(value);
    if (!isDict(node)) return;
    const resources = store.dictAt(node, "Resources") ?? inherited.resources;
    const mediaBox = box(store.lookup(node, "MediaBox")) ?? inherited.mediaBox;
    const cropBox = box(store.lookup(node, "CropBox")) ?? inherited.cropBox;
    const rotateValue = store.lookup(node, "Rotate");
    const rotate = typeof rotateValue === "number" ? rotateValue : inherited.rotate;
    const kids = store.lookup(node, "Kids");
    const type = store.lookup(node, "Type");
    if (Array.isArray(kids) && !isName(type, "Page")) {
      for (const kid of kids) visit(kid, { resources, mediaBox, cropBox, rotate }, depth + 1);
      return;
    }
    const media = mediaBox ?? [0, 0, 612, 792];
    pages.push({
      dict: node,
      ref: isRef(value) ? value : null,
      resources,
      mediaBox: media,
      cropBox: cropBox ?? media,
      rotate: ((rotate % 360) + 360) % 360,
    });
  };
  visit(
    catalog.map.get("Pages") ?? null,
    { resources: null, mediaBox: null, cropBox: null, rotate: 0 },
    0,
  );
  return pages;
}
