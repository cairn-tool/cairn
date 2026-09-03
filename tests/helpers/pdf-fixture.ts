/**
 * Builds PDFs in memory, as Buffers.
 *
 * Generated rather than committed, for the reason
 * `tests/helpers/antigravity-fixture.ts` records about its protobuf store: the
 * structure a test asserts against is visible in source. It matters more here
 * than there, because half these fixtures are *damaged* on purpose — a writer
 * library by construction cannot emit a broken cross-reference table, and that
 * is exactly what `pdf validate` exists to find. Hand-rolling is what lets one
 * helper produce both the valid and the invalid cases.
 *
 * Everything is uncompressed and no font program is embedded: the base-14 fonts
 * are named and pdf.js supplies the metrics, so a fixture stays inspectable with
 * `strings`.
 *
 * `tests/unit/pdf-fixture.test.ts` feeds every fixture back through `pdfjs-dist`
 * and asserts what came out. The builder is tested by the library it feeds,
 * which is what makes hand-rolling safe rather than merely cheap.
 */

/** A PDF name, `/Type`. Distinguished from a string so it serializes unquoted. */
export class PdfName {
  constructor(readonly name: string) {}
}

/** An indirect reference, `3 0 R`. */
export class PdfRef {
  constructor(readonly num: number) {}
}

/** A raw token emitted verbatim — used for number trees and pre-built arrays. */
export class PdfRaw {
  constructor(readonly text: string) {}
}

export type PdfValue = number | string | boolean | PdfName | PdfRef | PdfRaw | PdfValue[] | PdfDict;

export interface PdfDict {
  [key: string]: PdfValue | undefined;
}

interface PdfObject {
  num: number;
  value: PdfValue;
  stream?: Buffer;
}

const name = (value: string): PdfName => new PdfName(value);
const ref = (num: number): PdfRef => new PdfRef(num);

/**
 * Escapes a literal string.
 *
 * `\`, `(`, and `)` must be escaped or the lexer loses the string's end; every
 * byte past ASCII becomes an octal escape so a fixture is pure ASCII on disk and
 * a diff of one stays readable.
 *
 * The few above-ASCII characters these fixtures use, in WinAnsiEncoding.
 *
 * Every fixture font declares `/WinAnsiEncoding`, so a code point has to be
 * written as its *WinAnsi byte* rather than as its Unicode value. Emitting the
 * code point directly is the trap: `\\` plus octal 8226 is five digits, and a PDF
 * lexer reads only the first three — so U+2022 BULLET became byte 0x80 followed
 * by a literal "42", which renders as "€42".
 */
const WIN_ANSI: Record<string, number> = {
  "\u2022": 0x95,
  "\u2013": 0x96,
  "\u2014": 0x97,
  "\u2018": 0x91,
  "\u2019": 0x92,
  "\u201c": 0x93,
  "\u201d": 0x94,
  "\u2026": 0x85,
};

function literal(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const byte = WIN_ANSI[char] ?? (code <= 255 ? code : 0x3f);
    if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
    else if (code < 32 || code > 126) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += char;
  }
  return `(${out})`;
}

function serialize(value: PdfValue): string {
  if (value instanceof PdfName) return `/${value.name}`;
  if (value instanceof PdfRef) return `${value.num} 0 R`;
  if (value instanceof PdfRaw) return value.text;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return literal(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(" ")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return `<< ${entries.map(([key, item]) => `/${key} ${serialize(item as PdfValue)}`).join(" ")} >>`;
}

/**
 * Concatenates objects and emits a classic cross-reference table.
 *
 * Two byte-exact requirements, and they are the usual places this goes wrong:
 * every xref entry is exactly 20 bytes (`%010d %05d n \n`), and a stream's
 * `/Length` is the exact count between `stream\n` and `\nendstream`. Both are
 * satisfied here rather than by the callers.
 */
function assemble(objects: PdfObject[], trailer: PdfDict): Buffer {
  const chunks: Buffer[] = [];
  let length = 0;
  const push = (text: string | Buffer): void => {
    const buffer = typeof text === "string" ? Buffer.from(text, "latin1") : text;
    chunks.push(buffer);
    length += buffer.length;
  };

  // The binary comment marks the file as containing 8-bit data, which is what
  // stops a naive transfer from mangling it. Real producers all emit one.
  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");

  const offsets = new Map<number, number>();
  for (const object of [...objects].sort((a, b) => a.num - b.num)) {
    offsets.set(object.num, length);
    push(`${object.num} 0 obj\n`);
    if (object.stream) {
      const dict = { ...(object.value as PdfDict), Length: object.stream.length };
      push(`${serialize(dict)}\nstream\n`);
      push(object.stream);
      push("\nendstream\nendobj\n");
    } else {
      push(`${serialize(object.value)}\nendobj\n`);
    }
  }

  const highest = Math.max(...objects.map((object) => object.num));
  const xrefOffset = length;
  push(`xref\n0 ${highest + 1}\n`);
  push("0000000000 65535 f \n");
  for (let num = 1; num <= highest; num += 1) {
    const offset = offsets.get(num);
    push(
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`,
    );
  }
  push(`trailer\n${serialize({ ...trailer, Size: highest + 1 })}\n`);
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

export interface TextRun {
  x: number;
  y: number;
  size: number;
  /** Resource key, e.g. "F1". */
  font: string;
  text: string;
  /** Emit as a kerned `TJ` array rather than a plain `Tj`. */
  kerned?: boolean;
  /** Wrap in `BDC`/`EMC` with this marked-content id, for a tagged fixture. */
  mcid?: number;
  /** Structure tag to use for the `BDC`. Defaults to `P`. */
  tag?: string;
}

/**
 * One page's content stream.
 *
 * Each run is its own `BT`/`ET` with an absolute `Td`, which is not how a real
 * producer emits text but is what makes a fixture's geometry readable in source:
 * the x and y in the spec are the x and y on the page.
 */
function contentStream(runs: TextRun[], extras: string[] = []): Buffer {
  const lines: string[] = [...extras];
  for (const run of runs) {
    const body = run.kerned
      ? // -20 thousandths, which is real kerning. A larger adjustment makes
        // pdf.js synthesize word spaces and the fixture reads "K e r n e d".
        `[${[...run.text].map((char) => literal(char)).join(" -20 ")}] TJ`
      : `${literal(run.text)} Tj`;
    const text = `BT /${run.font} ${run.size} Tf ${run.x} ${run.y} Td ${body} ET`;
    lines.push(
      run.mcid === undefined ? text : `/${run.tag ?? "P"} <</MCID ${run.mcid}>> BDC\n${text}\nEMC`,
    );
  }
  return Buffer.from(`${lines.join("\n")}\n`, "latin1");
}

export interface OutlineSpec {
  title: string;
  /** 1-based destination page. */
  page: number;
  children?: OutlineSpec[];
  /** Point the destination at a free object, so it cannot resolve. */
  broken?: boolean;
}

export interface TagSpec {
  /** Structure type: H1, H2, P, L, LI, Table, Figure, and so on. */
  role: string;
  /** 1-based page the element's content is on. */
  page: number;
  /** Marked-content ids on that page belonging to this element. */
  mcids: number[];
}

export interface PdfSpec {
  /** One array of runs per page. */
  pages: TextRun[][];
  /** Raw operators prepended to a page's content stream, by page index. */
  extras?: Record<number, string[]>;
  /** Resource key to base font name. Defaults to Helvetica and Helvetica-Bold. */
  fonts?: Record<string, string>;
  /** Info dictionary entries. Dates are fixed strings; nothing here is generated. */
  info?: Record<string, string>;
  outline?: OutlineSpec[];
  /** When present the document is tagged: /MarkInfo, /StructTreeRoot, /ParentTree. */
  tagged?: TagSpec[];
  mediaBox?: [number, number, number, number];
  /** Make /Pages point at itself, for the page-tree cycle case. */
  cyclicPageTree?: boolean;
  /**
   * Extra objects, built with the same numbering as the rest of the document.
   * The callback reserves and adds, and whatever it returns is spread into the
   * catalog — which is how /Names, /AcroForm and anything else catalog-level
   * gets in without this builder growing a field per feature.
   */
  extend?: (helpers: {
    reserve: () => number;
    add: (num: number, value: PdfValue, stream?: Buffer) => void;
    ref: (num: number) => PdfRef;
    name: (text: string) => PdfName;
    pageRef: (index: number) => PdfRef;
  }) => { catalog?: PdfDict; annots?: Record<number, PdfValue[]> };
  /** Annotations per page index, for widget annotations and links. */
  annots?: Record<number, PdfValue[]>;
}

const DEFAULT_FONTS: Record<string, string> = { F1: "Helvetica", F2: "Helvetica-Bold" };
const DEFAULT_MEDIA_BOX: [number, number, number, number] = [0, 0, 612, 792];

export function buildPdf(spec: PdfSpec): Buffer {
  const fonts = spec.fonts ?? DEFAULT_FONTS;
  const mediaBox = spec.mediaBox ?? DEFAULT_MEDIA_BOX;
  const objects: PdfObject[] = [];

  let counter = 0;
  const reserve = (): number => {
    counter += 1;
    return counter;
  };
  const add = (num: number, value: PdfValue, stream?: Buffer): void => {
    objects.push({ num, value, stream });
  };

  const catalogNum = reserve();
  const pagesNum = reserve();

  const fontNums = new Map<string, number>();
  for (const key of Object.keys(fonts)) fontNums.set(key, reserve());

  const pageNums = spec.pages.map(() => reserve());
  const contentNums = spec.pages.map(() => reserve());

  // Run before the page dictionaries are built, because a widget annotation has
  // to appear in its page's /Annots as well as in /AcroForm /Fields — pdf.js
  // takes a field's page from the annotation, not from the field.
  const extended = spec.extend
    ? spec.extend({ reserve, add, ref, name, pageRef: (index: number) => ref(pageNums[index]) })
    : {};
  const annots: Record<number, PdfValue[]> = { ...spec.annots, ...extended.annots };

  // Reserved before the elements so /P can point back at the root, and so the
  // catalog can reference the tree it has not been built yet.
  const structRootNum = spec.tagged ? reserve() : 0;
  const structDocNum = spec.tagged ? reserve() : 0;
  const parentTreeNum = spec.tagged ? reserve() : 0;
  const tagNums = (spec.tagged ?? []).map(() => reserve());

  const outlineRootNum = spec.outline ? reserve() : 0;
  const outlineNums = new Map<OutlineSpec, number>();
  const numberOutline = (entries: OutlineSpec[]): void => {
    for (const entry of entries) {
      outlineNums.set(entry, reserve());
      if (entry.children) numberOutline(entry.children);
    }
  };
  if (spec.outline) numberOutline(spec.outline);

  for (const [key, base] of Object.entries(fonts))
    add(fontNums.get(key)!, {
      Type: name("Font"),
      Subtype: name("Type1"),
      BaseFont: name(base),
      Encoding: name("WinAnsiEncoding"),
    });

  spec.pages.forEach((runs, index) => {
    add(pageNums[index], {
      Type: name("Page"),
      Parent: ref(pagesNum),
      MediaBox: [...mediaBox],
      Resources: {
        Font: Object.fromEntries(
          Object.keys(fonts).map((key) => [key, ref(fontNums.get(key)!)]),
        ) as PdfDict,
      },
      Contents: ref(contentNums[index]),
      ...(annots[index]?.length ? { Annots: annots[index] } : {}),
      ...(spec.tagged ? { StructParents: index } : {}),
    });
    add(contentNums[index], {}, contentStream(runs, spec.extras?.[index]));
  });

  add(pagesNum, {
    Type: name("Pages"),
    // A /Pages whose /Kids names itself. pdf.js must refuse rather than recurse.
    Kids: spec.cyclicPageTree ? [ref(pagesNum)] : pageNums.map(ref),
    Count: spec.pages.length,
  });

  if (spec.tagged) {
    const tags = spec.tagged;
    tags.forEach((tag, index) => {
      add(tagNums[index], {
        Type: name("StructElem"),
        S: name(tag.role),
        P: ref(structDocNum),
        Pg: ref(pageNums[tag.page - 1]),
        K: tag.mcids.length === 1 ? tag.mcids[0] : [...tag.mcids],
      });
    });
    add(structDocNum, {
      Type: name("StructElem"),
      S: name("Document"),
      P: ref(structRootNum),
      K: tagNums.map(ref),
    });
    // The parent tree maps each page's /StructParents index to an array whose
    // position is the MCID. pdf.js resolves marked content through this, not
    // through /K, so a tree without it produces an empty struct tree.
    const nums: string[] = [];
    spec.pages.forEach((_, pageIndex) => {
      const slots: string[] = [];
      tags.forEach((tag, tagIndex) => {
        if (tag.page - 1 !== pageIndex) return;
        for (const mcid of tag.mcids) slots[mcid] = `${tagNums[tagIndex]} 0 R`;
      });
      const filled = Array.from(slots, (slot) => slot ?? "null");
      nums.push(`${pageIndex} [${filled.join(" ")}]`);
    });
    add(parentTreeNum, { Nums: new PdfRaw(`[${nums.join(" ")}]`) });
    add(structRootNum, {
      Type: name("StructTreeRoot"),
      K: [ref(structDocNum)],
      ParentTree: ref(parentTreeNum),
      ParentTreeNextKey: spec.pages.length,
    });
  }

  if (spec.outline) {
    const emit = (entries: OutlineSpec[], parent: number): void => {
      entries.forEach((entry, index) => {
        const num = outlineNums.get(entry)!;
        const previous = index > 0 ? ref(outlineNums.get(entries[index - 1])!) : undefined;
        const next =
          index < entries.length - 1 ? ref(outlineNums.get(entries[index + 1])!) : undefined;
        add(num, {
          Title: entry.title,
          Parent: ref(parent),
          Prev: previous,
          Next: next,
          // A destination naming an object that was never written. pdf.js cannot
          // resolve it to a page index, which is the AP08x path.
          Dest: [ref(entry.broken ? counter + 500 : pageNums[entry.page - 1]), name("Fit")],
          ...(entry.children?.length
            ? {
                First: ref(outlineNums.get(entry.children[0])!),
                Last: ref(outlineNums.get(entry.children[entry.children.length - 1])!),
                Count: entry.children.length,
              }
            : {}),
        });
        if (entry.children?.length) emit(entry.children, num);
      });
    };
    emit(spec.outline, outlineRootNum);
    add(outlineRootNum, {
      Type: name("Outlines"),
      First: ref(outlineNums.get(spec.outline[0])!),
      Last: ref(outlineNums.get(spec.outline[spec.outline.length - 1])!),
      Count: spec.outline.length,
    });
  }

  add(catalogNum, {
    Type: name("Catalog"),
    Pages: ref(pagesNum),
    ...(spec.outline ? { Outlines: ref(outlineRootNum) } : {}),
    ...(spec.tagged ? { StructTreeRoot: ref(structRootNum), MarkInfo: { Marked: true } } : {}),
    ...extended.catalog,
  });

  const infoNum = spec.info ? reserve() : 0;
  if (spec.info) add(infoNum, spec.info as PdfDict);

  return assemble(objects, {
    Root: ref(catalogNum),
    ...(spec.info ? { Info: ref(infoNum) } : {}),
  });
}

/**
 * Points `startxref` somewhere that is not a cross-reference table.
 *
 * pdf.js falls back to `indexObjects()` and rebuilds by scanning, emitting the
 * warning `validate` reports as a recovered cross-reference. The replacement is
 * padded to the original digit count so every other offset in the file stays
 * correct.
 */
export function shiftXrefOffsets(pdf: Buffer, by: number): Buffer {
  const text = pdf.toString("latin1");
  const match = /startxref\n(\d+)\n%%EOF/.exec(text);
  if (!match) throw new Error("fixture has no startxref");
  const shifted = String(Number(match[1]) + by).padStart(match[1].length, "0");
  return Buffer.from(text.replace(match[0], `startxref\n${shifted}\n%%EOF`), "latin1");
}

/** Cuts the file off before its cross-reference table and trailer. */
export function truncateBeforeEof(pdf: Buffer): Buffer {
  const index = pdf.toString("latin1").lastIndexOf("xref");
  if (index === -1) throw new Error("fixture has no xref");
  return pdf.subarray(0, index);
}

const BODY = 11;
const HEADING = 24;

/** Three pages of body text with a running header and footer on each. */
function structuredPages(): TextRun[][] {
  const chrome = (page: number): TextRun[] => [
    { x: 72, y: 750, size: 8, font: "F1", text: "Quarterly Report" },
    { x: 72, y: 40, size: 8, font: "F1", text: `Page ${page} of 4` },
  ];
  return [
    [
      ...chrome(1),
      { x: 72, y: 700, size: HEADING, font: "F2", text: "Introduction" },
      { x: 72, y: 660, size: BODY, font: "F1", text: "The quarter closed ahead of plan. Reve-" },
      { x: 72, y: 646, size: BODY, font: "F1", text: "nue rose across every region we track." },
      { x: 72, y: 620, size: BODY, font: "F1", text: "A second paragraph begins here, set" },
      { x: 72, y: 606, size: BODY, font: "F1", text: "apart by the leading above it." },
    ],
    [
      ...chrome(2),
      { x: 72, y: 700, size: 16, font: "F2", text: "Findings" },
      { x: 72, y: 660, size: BODY, font: "F1", text: "• " },
      { x: 90, y: 660, size: BODY, font: "F1", text: "The first finding, which wraps onto" },
      { x: 90, y: 646, size: BODY, font: "F1", text: "a second line at the hanging indent." },
      { x: 72, y: 620, size: BODY, font: "F1", text: "• " },
      { x: 90, y: 620, size: BODY, font: "F1", text: "The second finding." },
    ],
    [
      ...chrome(3),
      { x: 72, y: 700, size: 16, font: "F2", text: "Outlook" },
      { x: 72, y: 660, size: BODY, font: "F1", text: "Kerned", kerned: true },
      { x: 72, y: 640, size: BODY, font: "F1", text: "Guidance is unchanged for the year." },
    ],
    [
      ...chrome(4),
      { x: 72, y: 700, size: 16, font: "F2", text: "Appendix" },
      { x: 72, y: 660, size: BODY, font: "F1", text: "Supporting detail follows overleaf." },
    ],
  ];
}

/** The same content as `structured`, with marked content and a structure tree. */
function taggedPages(): TextRun[][] {
  return [
    [
      { x: 72, y: 700, size: HEADING, font: "F2", text: "Introduction", mcid: 0, tag: "H1" },
      {
        x: 72,
        y: 660,
        size: BODY,
        font: "F1",
        text: "The quarter closed ahead of plan.",
        mcid: 1,
      },
      {
        x: 72,
        y: 620,
        size: BODY,
        font: "F1",
        text: "A second paragraph begins here.",
        mcid: 2,
      },
    ],
  ];
}

export const PDF_FIXTURES: Record<string, PdfSpec> = {
  minimal: {
    pages: [[{ x: 72, y: 700, size: BODY, font: "F1", text: "Hello from a minimal PDF." }]],
    info: { Title: "Minimal", Author: "cairn tests", CreationDate: "D:20240101000000Z" },
  },
  structured: { pages: structuredPages() },
  tagged: {
    pages: taggedPages(),
    tagged: [
      { role: "H1", page: 1, mcids: [0] },
      { role: "P", page: 1, mcids: [1] },
      { role: "P", page: 1, mcids: [2] },
    ],
  },
  outlined: {
    pages: [
      [{ x: 72, y: 700, size: BODY, font: "F1", text: "Chapter one." }],
      [{ x: 72, y: 700, size: BODY, font: "F1", text: "Chapter two." }],
    ],
    outline: [
      { title: "Chapter One", page: 1, children: [{ title: "Section 1.1", page: 1 }] },
      { title: "Chapter Two", page: 2 },
      { title: "Dangling", page: 2, broken: true },
    ],
  },
  // A filled rectangle and no BT/ET at all: a page with ink and no text layer,
  // which is what a scan looks like to the parser, without needing an image.
  noTextLayer: { pages: [[]], extras: { 0: ["0 0 0 rg 72 300 400 200 re f"] } },
  manyPages: {
    pages: Array.from({ length: 40 }, (_, index) => [
      { x: 72, y: 700, size: BODY, font: "F1", text: `This is page ${index + 1}.` },
    ]),
  },
  pageTreeCycle: {
    pages: [[{ x: 72, y: 700, size: BODY, font: "F1", text: "Unreachable." }]],
    cyclicPageTree: true,
  },

  /**
   * Two embedded files, one of which stores a traversing name.
   *
   * `evil` is the case the extractor exists to refuse: `/F` is
   * `../../etc/evil.csv`, which pdf.js already reports as a stripped
   * `filename` with `rawFilename` intact — and which this repo re-sanitizes
   * anyway rather than trusting.
   */
  attached: {
    pages: [[{ x: 72, y: 700, size: BODY, font: "F1", text: "See the attachments." }]],
    extend: ({ reserve, add, ref, name }) => {
      const plain = Buffer.from("hello,world\n1,2\n", "utf8");
      const evil = Buffer.from("owned\n", "utf8");
      const plainStream = reserve();
      const plainSpec = reserve();
      const evilStream = reserve();
      const evilSpec = reserve();
      add(plainStream, { Type: name("EmbeddedFile"), Length: plain.length }, plain);
      add(plainSpec, {
        Type: name("Filespec"),
        F: "data.csv",
        UF: "data.csv",
        Desc: "A sample table",
        EF: { F: ref(plainStream) },
      });
      add(evilStream, { Type: name("EmbeddedFile"), Length: evil.length }, evil);
      add(evilSpec, {
        Type: name("Filespec"),
        F: "../../etc/evil.csv",
        UF: "../../etc/evil.csv",
        EF: { F: ref(evilStream) },
      });
      return {
        catalog: {
          Names: {
            EmbeddedFiles: {
              Names: ["data.csv", ref(plainSpec), "escape.csv", ref(evilSpec)],
            },
          },
        },
      };
    },
  },
  /** A filled AcroForm: a text field with a value, a checkbox, a read-only and a hidden field. */
  formFilled: {
    pages: [[{ x: 72, y: 760, size: BODY, font: "F1", text: "Application form" }]],
    extend: ({ reserve, add, ref, name, pageRef }) => {
      const fields = [
        {
          dict: {
            FT: name("Tx"),
            T: "fullName",
            TU: "Your full name",
            V: "Ada Lovelace",
            MaxLen: 64,
            Rect: [72, 700, 300, 720],
          } as PdfDict,
        },
        {
          dict: {
            FT: name("Btn"),
            T: "agree",
            V: name("Off"),
            AS: name("Off"),
            Rect: [72, 660, 90, 678],
          } as PdfDict,
        },
        {
          // Ff bit 1 is ReadOnly.
          dict: {
            FT: name("Tx"),
            T: "reference",
            V: "REF-001",
            Ff: 1,
            Rect: [72, 620, 300, 640],
          } as PdfDict,
        },
        {
          // /F bit 2 is Hidden.
          dict: {
            FT: name("Tx"),
            T: "internal",
            V: "secret",
            F: 2,
            Rect: [72, 580, 300, 600],
          } as PdfDict,
        },
      ];
      const nums = fields.map(() => reserve());
      fields.forEach((field, index) => {
        add(nums[index], {
          Type: name("Annot"),
          Subtype: name("Widget"),
          P: pageRef(0),
          ...field.dict,
        });
      });
      return {
        catalog: { AcroForm: { Fields: nums.map(ref), DA: "/Helv 0 Tf 0 g" } },
        annots: { 0: nums.map(ref) },
      };
    },
  },
  /**
   * A field listed in /AcroForm /Fields but attached to no page's /Annots.
   *
   * The AP312 case: the field is real and carries a value, but there is no page
   * to report it on, so `page` is null rather than a guess.
   */
  formOrphan: {
    pages: [[{ x: 72, y: 700, size: BODY, font: "F1", text: "Detached field." }]],
    extend: ({ reserve, add, ref, name }) => {
      const num = reserve();
      add(num, {
        Type: name("Annot"),
        Subtype: name("Widget"),
        FT: name("Tx"),
        T: "orphan",
        V: "detached",
        Rect: [0, 0, 10, 10],
      });
      return { catalog: { AcroForm: { Fields: [ref(num)], DA: "/Helv 0 Tf 0 g" } } };
    },
  },
};

/** Every fixture, built. Damaged variants are mutations of `minimal`. */
export function pdfFixture(key: string): Buffer {
  if (key === "damagedXref") return shiftXrefOffsets(buildPdf(PDF_FIXTURES.minimal), 3);
  if (key === "truncated") return truncateBeforeEof(buildPdf(PDF_FIXTURES.minimal));
  if (key === "notAPdf") return Buffer.from("this is not a pdf\n", "utf8");
  const spec = PDF_FIXTURES[key];
  if (!spec) throw new Error(`no such pdf fixture: ${key}`);
  return buildPdf(spec);
}
