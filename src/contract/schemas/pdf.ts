import type { SchemaEntry } from "../types.js";
import { schemaUri } from "../version.js";
import { DRAFT } from "./shared.js";

/**
 * A PDF finding.
 *
 * Inlined rather than cross-referenced: a schema retrieved with
 * `cairn schema pdf-result` must compile on its own, so no `$ref` leaves this
 * document.
 *
 * `code` is `AP###`, the third family after the `AB###` an `AgentDiagnostic`
 * carries and the `AD###` a `ConversionDiagnostic` does. It is structurally a
 * `ConversionDiagnostic` with `node` and `location` replaced by `page` and
 * `construct`, because a PDF finding is positioned by page rather than by a node
 * ancestry trail.
 */
const DIAGNOSTIC = {
  type: "object",
  required: ["code", "severity", "message", "quality"],
  properties: {
    code: { type: "string", pattern: "^AP[0-9]{3}$" },
    severity: { enum: ["notice", "warning", "error"] },
    message: { type: "string" },
    quality: {
      enum: ["exact", "approximate", "unsupported"],
      description:
        "How faithfully the construct survived: exact has a direct equivalent, approximate emitted something else, unsupported emitted nothing.",
    },
    page: {
      type: "integer",
      minimum: 1,
      description: "1-based page the finding concerns, when it concerns a single page.",
    },
    construct: {
      type: "string",
      description:
        "The PDF construct the finding concerns: a structure role, a filter name, a font name.",
    },
    remediation: { type: "string" },
  },
};

const TEXT_LAYER = {
  enum: ["present", "sparse", "absent"],
  description:
    "Glyph coverage relative to page area: present is a normal text layer, sparse is a handful of glyphs over mostly image, absent is no text at all. An absent layer means the page is an image and text extraction returns nothing for it.",
};

/**
 * Document facts, carried by every subcommand.
 *
 * Unlike `adf-result`'s `inventory`, this is not confined to one command: a
 * conversion from a tagged document and one from a scan are not the same kind of
 * artifact and must be distinguishable without a second call.
 */
const DOCUMENT = {
  type: "object",
  required: ["pageCount", "tagged", "encrypted"],
  properties: {
    pageCount: { type: "integer", minimum: 0 },
    tagged: {
      type: "boolean",
      description:
        "The document declares /MarkInfo <</Marked true>>. A tagged document names its own paragraphs, headings, lists, and table cells, so to-markdown infers almost nothing; an untagged one is inference throughout. Read this before trusting converted structure. It is a claim, not a measurement — see `structured`.",
    },
    structured: {
      enum: ["struct", "partial", "none"],
      description:
        "Whether pages actually carried a usable structure tree, measured rather than claimed: producers do set `tagged` and ship an empty tree. Absent on commands that do not walk pages.",
    },
    encrypted: {
      type: "boolean",
      description:
        "The document carries an encryption dictionary. True includes the common case of an empty user password that opens without one, in which case the restrictions are advisory only.",
    },
    textLayer: TEXT_LAYER,
    pdfVersion: { type: "string" },
    title: { type: "string" },
    author: { type: "string" },
    subject: { type: "string" },
    keywords: { type: "string" },
    creator: { type: "string" },
    producer: { type: "string" },
    created: {
      type: "string",
      description:
        "ISO-8601 in UTC, when the document's own date string parsed. Omitted rather than guessed when it did not.",
    },
    modified: { type: "string", description: "ISO-8601 in UTC; omitted when unparseable." },
  },
};

/** One row of `pdf inspect`'s page inventory. */
const PAGE = {
  type: "object",
  required: ["page", "width", "height", "rotation", "characters", "density", "textLayer"],
  properties: {
    page: { type: "integer", minimum: 1 },
    width: { type: "number", description: "Width in points, 72 to the inch, /Rotate applied." },
    height: { type: "number", description: "Height in points, /Rotate applied." },
    rotation: { type: "integer" },
    characters: {
      type: "integer",
      minimum: 0,
      description: "Non-whitespace code points on the page.",
    },
    density: {
      type: "number",
      description:
        "Characters per square inch. Published alongside textLayer so a consumer that disagrees with the threshold can re-classify from the evidence rather than the label.",
    },
    textLayer: TEXT_LAYER,
  },
};

const TEXT_PAGE = {
  type: "object",
  required: ["page", "text", "characters"],
  properties: {
    page: { type: "integer", minimum: 1 },
    text: { type: "string" },
    characters: { type: "integer", minimum: 0 },
    layout: {
      type: "object",
      description:
        "How the page was read: the columns found (method auto) or asked for with --columns (forced), the gutters' x positions in page-upright points, and how many lines crossed them and were read whole. Each stretch between such lines is read column by column.",
      required: ["columns", "method", "gutters", "spanning"],
      properties: {
        columns: { type: "integer", minimum: 1 },
        method: { enum: ["auto", "forced"] },
        gutters: { type: "array", items: { type: "number" } },
        spanning: { type: "integer", minimum: 0 },
      },
    },
  },
};

/** One outline entry. Recursive within this document, which `$ref: "#/..."` permits. */
const OUTLINE_ENTRY = {
  type: "object",
  required: ["title", "level", "page", "children"],
  properties: {
    title: { type: "string" },
    level: { type: "integer", minimum: 1 },
    page: {
      type: ["integer", "null"],
      description:
        "1-based destination page, or null when the destination did not resolve. A null keeps the entry rather than dropping it; the accompanying finding names it.",
    },
    url: {
      type: "string",
      description:
        "Present only when the parser validated the scheme. Recorded, never followed. An entry whose URL used a scheme the parser refused carries no url at all.",
    },
    children: { type: "array", items: { $ref: "#/$defs/outlineEntry" } },
  },
};

/**
 * One embedded file.
 *
 * `bytes` and `sha256` are optional because decoding is bounded: past the
 * budget, or when a file's stream could not be read, the entry is still listed
 * with its names and a finding says why the rest is missing. Listing it without
 * saying so would be indistinguishable from a zero-length file.
 */
const ATTACHMENT = {
  type: "object",
  required: ["id", "filename", "rawFilename"],
  properties: {
    id: {
      type: "string",
      description: "The name-tree key identifying this attachment inside the document.",
    },
    filename: {
      type: "string",
      description:
        "The basename the parser derived. Sanitized again before it is ever used as a path.",
    },
    rawFilename: {
      type: "string",
      description:
        "The stored name verbatim, including any directory traversal it carries. Reported so a rename is visible rather than silent.",
    },
    description: { type: "string" },
    bytes: {
      type: "integer",
      minimum: 0,
      description: "Decoded length. Absent when it was not decoded.",
    },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    binary: {
      enum: ["elf", "pe", "macho"],
      description:
        "Executable format, identified from the magic number. Absent when it is not one.",
    },
    written: {
      type: "string",
      description: "Absolute path written, present only under --extract.",
    },
  },
} as const;

/** One AcroForm field, with its widgets folded into a count. */
const FORM_FIELD = {
  type: "object",
  required: ["name", "type", "page", "readOnly", "hidden", "password", "widgets"],
  properties: {
    name: { type: "string", description: "Fully-qualified field name." },
    type: {
      type: "string",
      description: "text, checkbox, radiobutton, choice, signature, button, or unknown.",
    },
    page: {
      type: ["integer", "null"],
      minimum: 1,
      description:
        "1-based, converted from the 0-based index the parser reports. Null when it does not resolve.",
    },
    value: { type: "string" },
    defaultValue: { type: "string" },
    readOnly: { type: "boolean" },
    hidden: { type: "boolean" },
    password: {
      type: "boolean",
      description:
        "The field's password flag. The value is still reported: the same bytes are reachable through pdf text.",
    },
    charLimit: { type: "integer", minimum: 1 },
    exportValues: { type: "string" },
    widgets: {
      type: "integer",
      minimum: 1,
      description: "Widgets this field renders as; one field can appear on several pages.",
    },
  },
} as const;

const FORM = {
  type: "object",
  required: ["type", "fieldCount", "fields"],
  properties: {
    type: {
      enum: ["acroform", "xfa", "none"],
      description:
        "xfa means the field values live in an XML packet this does not read, so fields is empty for a reason rather than because there are none.",
    },
    fieldCount: { type: "integer", minimum: 0 },
    fields: { type: "array", items: { $ref: "#/$defs/formField" } },
  },
} as const;

/**
 * A box or transform in PDF default user space: points, origin at the bottom
 * left of the page's coordinate system, `/Rotate` not applied. One space for
 * `images`, `render`, and `ocr`, so a box from one can be handed to another.
 */
const USER_BOX = {
  type: "array",
  items: { type: "number" },
  minItems: 4,
  maxItems: 4,
  description:
    "[x0, y0, x1, y1] in PDF user space: points, 72 to the inch, origin at the bottom left, /Rotate not applied — the space pdf render --box takes.",
} as const;

/** One image placement. Emitted by `pdf images`. */
const IMAGE = {
  type: "object",
  required: [
    "page",
    "index",
    "object",
    "inline",
    "width",
    "height",
    "colorSpace",
    "components",
    "bitsPerComponent",
    "filters",
    "imageMask",
    "transform",
    "box",
  ],
  properties: {
    page: { type: "integer", minimum: 1 },
    index: {
      type: "integer",
      minimum: 1,
      description: "Order of placement on the page, in content-stream order.",
    },
    object: {
      type: ["string", "null"],
      description:
        "The image's object, as `12 0 R`. Null for an inline image, which is not an object.",
    },
    name: { type: "string", description: "The XObject resource name the page painted, e.g. Im1." },
    inline: { type: "boolean" },
    forms: {
      type: "array",
      items: { type: "string" },
      description:
        "Form XObjects entered to reach the image, outermost first. Absent when painted directly.",
    },
    width: { type: "integer", minimum: 0, description: "Pixel width, as declared." },
    height: { type: "integer", minimum: 0, description: "Pixel height, as declared." },
    colorSpace: {
      type: ["string", "null"],
      description:
        "DeviceGray, DeviceRGB, DeviceCMYK, CalGray, CalRGB, Lab, ICCBased(n), Indexed(base,hival), Separation(name), DeviceN(n), JPX when a JPEG 2000 image carries its own, or unsupported. Null for a stencil mask, which has none.",
    },
    components: { type: "integer", minimum: 0 },
    bitsPerComponent: { type: "integer", minimum: 1 },
    filters: {
      type: "array",
      items: { type: "string" },
      description: "The filter chain, inline abbreviations expanded. Empty for unencoded samples.",
    },
    imageMask: {
      type: "boolean",
      description: "A stencil mask: 1-bit, painted in the fill colour.",
    },
    mask: {
      type: "object",
      required: ["type"],
      properties: {
        type: { enum: ["smask", "stencil", "color-key"] },
        object: { type: "string" },
        file: {
          type: "string",
          description:
            "Present when the mask was written separately, which happens for a JPEG: the JPEG is kept as stored and its mask becomes <name>-mask.png. Otherwise the mask is the PNG's alpha channel.",
        },
      },
    },
    transform: {
      type: "array",
      items: { type: "number" },
      minItems: 6,
      maxItems: 6,
      description: "[a, b, c, d, e, f]: the image's unit square mapped into PDF user space.",
    },
    box: {
      ...USER_BOX,
      description:
        "The placement's bounds in PDF user space. The placement, not the visible area: a clipping path may show only part of the image.",
    },
    file: {
      type: "string",
      description:
        "The file written, relative to the output directory. Shared by every placement of one image.",
    },
    format: { enum: ["png", "jpeg", "jp2"] },
    bytes: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    skipped: {
      enum: ["min-size", "undecodable"],
      description: "Why no file was written. Absent when one was.",
    },
  },
} as const;

const RENDER = {
  type: "object",
  required: [
    "page",
    "dpi",
    "width",
    "height",
    "box",
    "pageBox",
    "rotation",
    "file",
    "bytes",
    "sha256",
  ],
  properties: {
    page: { type: "integer", minimum: 1 },
    dpi: { type: "number" },
    width: { type: "integer", minimum: 1, description: "PNG width in pixels." },
    height: { type: "integer", minimum: 1, description: "PNG height in pixels." },
    box: {
      ...USER_BOX,
      description:
        "The region drawn, in PDF user space, after snapping outward to whole pixels and clipping to the page. The PNG covers exactly this area.",
    },
    pageBox: {
      ...USER_BOX,
      description: "The page's visible area (its crop box) in PDF user space.",
    },
    rotation: { type: "integer", description: "The page's /Rotate, applied to the PNG." },
    file: { type: "string", description: "Absolute path of the PNG written." },
    bytes: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

const OCR = {
  type: "object",
  required: ["engine", "minConfidence", "pages"],
  properties: {
    engine: {
      type: "object",
      required: ["name", "version", "languages", "dpi", "psm"],
      properties: {
        name: { const: "tesseract" },
        version: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        dpi: {
          type: "number",
          description: "The resolution pages were rendered at for recognition.",
        },
        psm: { type: "integer", description: "Tesseract page segmentation mode." },
      },
    },
    minConfidence: { type: "number" },
    pages: {
      type: "array",
      items: {
        type: "object",
        required: ["page", "source", "textLayer", "text", "confidence", "words"],
        properties: {
          page: { type: "integer", minimum: 1 },
          source: {
            const: "ocr",
            description:
              "Always ocr: recognised text is marked wherever it goes and never merged into a text layer.",
          },
          textLayer: {
            enum: ["present", "absent"],
            description:
              "Whether the page carries its own text layer, measured before recognition.",
          },
          text: { type: "string" },
          confidence: {
            type: ["number", "null"],
            description:
              "Mean word confidence, 0 to 100, weighted by word length. Null when nothing was recognised.",
          },
          words: {
            type: "array",
            items: {
              type: "object",
              required: ["text", "confidence", "box"],
              properties: {
                text: { type: "string" },
                confidence: { type: "number" },
                box: USER_BOX,
              },
            },
          },
        },
      },
    },
  },
} as const;

export const pdfResultSchema: SchemaEntry = {
  id: "pdf-result",
  uri: schemaUri("v1", "pdf-result"),
  title: "cairn pdf result",
  commands: [
    "pdf inspect",
    "pdf text",
    "pdf outline",
    "pdf validate",
    "pdf to-markdown",
    "pdf attachments",
    "pdf forms",
    "pdf images",
    "pdf render",
    "pdf ocr",
  ],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "pdf-result"),
    title: "cairn pdf result",
    description:
      "The --format json payload of every pdf subcommand, including the failure form. The default llm format writes the primary output alone to stdout and diagnostics to stderr; this shape appears only under --format json, so -fj is not the same output in JSON.",
    type: "object",
    required: ["command", "ok", "source", "diagnostics"],
    properties: {
      command: {
        enum: [
          "inspect",
          "text",
          "outline",
          "validate",
          "to-markdown",
          "attachments",
          "forms",
          "images",
          "render",
          "ocr",
        ],
      },
      ok: {
        type: "boolean",
        description:
          "False when a blocking finding occurred. An approximation blocks only under --strict, so ok:true does not mean the conversion was lossless or the text complete — read diagnostics for that.",
      },
      source: { type: "string", description: "Input path, or '-' for stdin." },
      document: {
        description:
          "Present on every command whenever the document opened, so a result from a tagged document and one from a scan are distinguishable without a second call. Absent only in the failure form.",
        allOf: [{ $ref: "#/$defs/document" }],
      },
      pages: {
        type: "array",
        description: "Emitted by inspect: one row per page, in page order.",
        items: { $ref: "#/$defs/page" },
      },
      text: {
        type: "array",
        description:
          "Emitted by text: one entry per selected page, in page order. A page that could not be decoded is absent and reported as a finding, rather than present with an empty string, which would be indistinguishable from a blank page.",
        items: { $ref: "#/$defs/textPage" },
      },
      outline: {
        type: "array",
        description:
          "Emitted by outline: the declared bookmark tree, in document order. An empty array means the document declares no outline, which is an answer rather than a failure.",
        items: { $ref: "#/$defs/outlineEntry" },
      },
      markdown: { type: "string", description: "Emitted by to-markdown." },
      attachments: {
        type: "array",
        description:
          "Emitted by attachments: the files embedded in the document, sorted by their name-tree key. An empty array means the document embeds none.",
        items: { $ref: "#/$defs/attachment" },
      },
      form: {
        description: "Emitted by forms.",
        allOf: [{ $ref: "#/$defs/form" }],
      },
      images: {
        type: "array",
        description:
          "Emitted by images: one entry per placement, in page order and then content-stream order. The same payload is written to images.json in the output directory.",
        items: { $ref: "#/$defs/image" },
      },
      render: { description: "Emitted by render.", allOf: [{ $ref: "#/$defs/render" }] },
      ocr: { description: "Emitted by ocr.", allOf: [{ $ref: "#/$defs/ocr" }] },
      selectedPages: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        description:
          "1-based pages --pages selected, ascending and deduplicated. Absent when --pages was not given, which means every page.",
      },
      output: {
        type: "string",
        description:
          "Absolute path written: --output's file, render's PNG, ocr --out's JSON, or the directory images wrote into.",
      },
      diagnostics: { type: "array", items: DIAGNOSTIC },
    },
    $defs: {
      document: DOCUMENT,
      page: PAGE,
      textPage: TEXT_PAGE,
      outlineEntry: OUTLINE_ENTRY,
      attachment: ATTACHMENT,
      form: FORM,
      formField: FORM_FIELD,
      image: IMAGE,
      render: RENDER,
      ocr: OCR,
    },
  },
};
