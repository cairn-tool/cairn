import type {
  BlockContent,
  Break,
  Delete,
  Emphasis,
  Heading,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
} from "mdast";
import { stringifyMarkdown } from "../../markdown-stringify.js";
import { CODES, DiagnosticSink } from "./diagnostics.js";
import { FIDELITY, MARK_FIDELITY, PANEL_TYPES } from "./profile.js";
import type { AdfDocument, AdfMark, AdfNode, ConversionDiagnostic } from "./types.js";

/**
 * The order marks are applied, innermost first.
 *
 * Fixed rather than following the order the marks happen to appear in, because
 * mdast nests what ADF keeps flat and a varying nesting order would vary the
 * output bytes for identical input. `code` is innermost because `inlineCode` is
 * a literal and cannot contain other nodes; `link` is outermost so the whole
 * styled run becomes the link text.
 */
const MARK_ORDER = ["code", "strike", "em", "strong", "link"] as const;

const text = (value: string): Text => ({ type: "text", value });

function markNamed(marks: AdfMark[] | undefined, name: string): AdfMark | undefined {
  return marks?.find((mark) => mark.type === name);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Formats an ADF `date` in UTC. Reading the host zone would make output machine-dependent. */
function formatTimestamp(timestamp: unknown): string {
  const millis = Number(timestamp);
  if (!Number.isFinite(millis)) return String(timestamp ?? "");
  return new Date(millis).toISOString().slice(0, 10);
}

class Converter {
  readonly sink = new DiagnosticSink();

  /** `trail` is the *parent* path: `node` already names the type, so it is not repeated. */
  private note(node: AdfNode, trail: string[]): void {
    const rating = FIDELITY[node.type];
    if (!rating) {
      this.sink.add({
        code: CODES.unknownNode,
        quality: "unsupported",
        severity: "warning",
        message: `Unrecognized ADF node type '${node.type}'; nothing was emitted for it`,
        node: node.type,
        location: trail.join("/"),
        remediation:
          "This tool's content model does not know this node. Check for a newer cairn, or report the type.",
      });
      return;
    }
    if (rating.quality === "exact") return;
    this.sink.add({
      code: CODE_FOR_NODE[node.type] ?? CODES.inlineApproximated,
      quality: rating.quality,
      message: `${node.type}: ${rating.note}`,
      node: node.type,
      location: trail.join("/"),
    });
  }

  /** Applies ADF marks to a phrasing node, innermost first. */
  private applyMarks(
    content: PhrasingContent[],
    marks: AdfMark[] | undefined,
    trail: string[],
  ): PhrasingContent[] {
    if (!marks?.length) return content;

    for (const mark of marks) {
      const rating = MARK_FIDELITY[mark.type];
      if (!rating) {
        this.sink.add({
          code: CODES.unknownMark,
          quality: "unsupported",
          severity: "warning",
          message: `Unrecognized ADF mark '${mark.type}'; its formatting was dropped`,
          node: mark.type,
          location: trail.join("/"),
        });
        continue;
      }
      if (rating.quality !== "exact")
        this.sink.add({
          code: CODES.markDropped,
          quality: rating.quality,
          message: `mark ${mark.type}: ${rating.note}`,
          node: mark.type,
          location: trail.join("/"),
        });
    }

    let current = content;
    for (const name of MARK_ORDER) {
      const mark = markNamed(marks, name);
      if (!mark) continue;
      if (name === "code") {
        const literal: InlineCode = { type: "inlineCode", value: plainText(current) };
        current = [literal];
        continue;
      }
      if (name === "strike") {
        const node: Delete = { type: "delete", children: current };
        current = [node];
        continue;
      }
      if (name === "em") {
        const node: Emphasis = { type: "emphasis", children: current };
        current = [node];
        continue;
      }
      if (name === "strong") {
        const node: Strong = { type: "strong", children: current };
        current = [node];
        continue;
      }
      const href = asString(mark.attrs?.href) ?? "";
      const title = asString(mark.attrs?.title);
      const node: Link = {
        type: "link",
        url: href,
        ...(title ? { title } : {}),
        children: current,
      };
      current = [node];
    }
    return current;
  }

  /** Converts a run of ADF inline nodes to mdast phrasing content. */
  inline(nodes: AdfNode[] | undefined, trail: string[]): PhrasingContent[] {
    const out: PhrasingContent[] = [];
    for (const node of nodes ?? []) {
      const here = [...trail, node.type];
      switch (node.type) {
        case "text": {
          const value = node.text ?? "";
          if (value === "") break;
          out.push(...this.applyMarks([text(value)], node.marks, trail));
          break;
        }
        case "hardBreak": {
          const node2: Break = { type: "break" };
          out.push(node2);
          break;
        }
        case "emoji": {
          this.note(node, trail);
          out.push(text(asString(node.attrs?.text) ?? asString(node.attrs?.shortName) ?? ""));
          break;
        }
        case "mention": {
          this.note(node, trail);
          out.push(text(asString(node.attrs?.text) ?? `@${asString(node.attrs?.id) ?? "unknown"}`));
          break;
        }
        case "date": {
          this.note(node, trail);
          out.push(text(formatTimestamp(node.attrs?.timestamp)));
          break;
        }
        case "status": {
          this.note(node, trail);
          out.push({ type: "inlineCode", value: asString(node.attrs?.text) ?? "" });
          break;
        }
        case "inlineCard": {
          this.note(node, trail);
          const url = asString(node.attrs?.url) ?? "";
          out.push({ type: "link", url, children: [text(url)] });
          break;
        }
        case "mediaInline": {
          this.note(node, trail);
          out.push(this.mediaLink(node, trail));
          break;
        }
        case "placeholder":
        case "inlineExtension": {
          this.note(node, trail);
          break;
        }
        default: {
          this.note(node, trail);
          // An unknown inline node still contributes its text children, if any,
          // rather than silently taking them with it.
          out.push(...this.inline(node.content, here));
        }
      }
    }
    return out;
  }

  /** A `media` node with no fetchable URL becomes a link carrying its id. */
  private mediaLink(node: AdfNode, trail: string[]): Link {
    const id = asString(node.attrs?.id) ?? "unknown";
    this.sink.add({
      code: CODES.mediaUnresolvable,
      quality: "approximate",
      message: `Attachment ${id} has no URL, so it became a link carrying its media id`,
      node: node.type,
      location: trail.join("/"),
      remediation:
        "Resolve the attachment through the Jira API if you need a fetchable link; this tool has no site URL.",
    });
    return { type: "link", url: `media:${id}`, children: [text(`attachment ${id}`)] };
  }

  private media(node: AdfNode, trail: string[]): PhrasingContent {
    const kind = asString(node.attrs?.type);
    const url = asString(node.attrs?.url);
    if (kind === "external" && url) {
      const alt = asString(node.attrs?.alt);
      return { type: "image", url, ...(alt ? { alt } : {}) };
    }
    return this.mediaLink(node, trail);
  }

  /** Converts a run of ADF block nodes to mdast block content. */
  blocks(nodes: AdfNode[] | undefined, trail: string[]): BlockContent[] {
    const out: BlockContent[] = [];
    for (const node of nodes ?? []) {
      const here = [...trail, node.type];
      switch (node.type) {
        case "paragraph": {
          const paragraph: Paragraph = {
            type: "paragraph",
            children: this.inline(node.content, here),
          };
          out.push(paragraph);
          break;
        }
        case "heading": {
          const level = Number(node.attrs?.level);
          const depth = (
            Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1
          ) as Heading["depth"];
          const heading: Heading = {
            type: "heading",
            depth,
            children: this.inline(node.content, here),
          };
          out.push(heading);
          break;
        }
        case "rule": {
          out.push({ type: "thematicBreak" });
          break;
        }
        case "codeBlock": {
          const lang = asString(node.attrs?.language);
          out.push({
            type: "code",
            ...(lang ? { lang } : {}),
            value: (node.content ?? []).map((child) => child.text ?? "").join(""),
          });
          break;
        }
        case "blockquote": {
          out.push({ type: "blockquote", children: this.blocks(node.content, here) });
          break;
        }
        case "bulletList": {
          out.push(this.list(node, here, false));
          break;
        }
        case "orderedList": {
          out.push(this.list(node, here, true));
          break;
        }
        case "table": {
          this.note(node, trail);
          out.push(this.table(node, here));
          break;
        }
        case "taskList": {
          this.note(node, trail);
          out.push(this.taskList(node, here));
          break;
        }
        case "decisionList": {
          this.note(node, trail);
          const items: ListItem[] = (node.content ?? []).map((item) => ({
            type: "listItem",
            spread: false,
            children: [
              { type: "paragraph", children: this.inline(item.content, here) } as Paragraph,
            ],
          }));
          out.push({ type: "list", ordered: false, spread: false, children: items });
          break;
        }
        case "panel": {
          this.note(node, trail);
          const kind = asString(node.attrs?.panelType) ?? "info";
          const label = PANEL_TYPES.has(kind) ? kind : "info";
          const lead: Paragraph = {
            type: "paragraph",
            children: [
              { type: "strong", children: [text(`${label[0].toUpperCase()}${label.slice(1)}`)] },
            ],
          };
          out.push({ type: "blockquote", children: [lead, ...this.blocks(node.content, here)] });
          break;
        }
        case "expand":
        case "nestedExpand": {
          this.note(node, trail);
          const title = asString(node.attrs?.title) ?? "Details";
          const lead: Paragraph = {
            type: "paragraph",
            children: [{ type: "strong", children: [text(title)] }],
          };
          out.push(lead, ...this.blocks(node.content, here));
          break;
        }
        case "mediaSingle": {
          this.note(node, trail);
          const media = (node.content ?? [])[0];
          if (media) out.push({ type: "paragraph", children: [this.media(media, here)] });
          break;
        }
        case "mediaGroup": {
          this.note(node, trail);
          const items: ListItem[] = (node.content ?? []).map((media) => ({
            type: "listItem",
            spread: false,
            children: [{ type: "paragraph", children: [this.media(media, here)] } as Paragraph],
          }));
          if (items.length)
            out.push({ type: "list", ordered: false, spread: false, children: items });
          break;
        }
        case "layoutSection":
        case "layoutColumn": {
          this.note(node, trail);
          out.push(...this.blocks(node.content, here));
          break;
        }
        case "extension":
        case "bodiedExtension":
        case "multiBodiedExtension":
        case "extensionFrame": {
          this.note(node, trail);
          break;
        }
        default: {
          this.note(node, trail);
          out.push(...this.blocks(node.content, here));
        }
      }
    }
    return out;
  }

  private list(node: AdfNode, trail: string[], ordered: boolean): List {
    const start = Number(node.attrs?.order);
    const children: ListItem[] = (node.content ?? []).map((item) => ({
      type: "listItem",
      spread: false,
      children: this.blocks(item.content, [...trail, "listItem"]),
    }));
    return {
      type: "list",
      ordered,
      ...(ordered && Number.isInteger(start) && start !== 1 ? { start } : {}),
      spread: false,
      children,
    };
  }

  private taskList(node: AdfNode, trail: string[]): List {
    const children: ListItem[] = [];
    for (const item of node.content ?? []) {
      if (item.type === "taskList") {
        // A nested taskList is a sibling of the items in ADF; in Markdown it
        // belongs inside the preceding item, which is where its indentation puts it.
        const previous = children[children.length - 1];
        if (previous) previous.children.push(this.taskList(item, trail));
        continue;
      }
      children.push({
        type: "listItem",
        checked: asString(item.attrs?.state) === "DONE",
        spread: false,
        children: [
          {
            type: "paragraph",
            children: this.inline(item.content, [...trail, "taskItem"]),
          } as Paragraph,
        ],
      });
    }
    return { type: "list", ordered: false, spread: false, children };
  }

  private table(node: AdfNode, trail: string[]): Table {
    const rows: TableRow[] = [];
    for (const row of node.content ?? []) {
      const cells: TableCell[] = [];
      for (const cell of row.content ?? []) {
        const here = [...trail, cell.type];
        const blocks = this.blocks(cell.content, here);
        // A GFM cell holds inline content only; an ADF cell holds blocks. So the
        // blocks collapse into one run, joined by a space.
        if (blocks.length > 1 || (blocks[0] && blocks[0].type !== "paragraph"))
          this.sink.add({
            code: CODES.tableFlattened,
            quality: "approximate",
            message: "Table cell block content was flattened to inline text",
            node: cell.type,
            location: here.join("/"),
          });
        if (cell.attrs && (cell.attrs.colspan !== undefined || cell.attrs.rowspan !== undefined))
          this.sink.add({
            code: CODES.tableFlattened,
            quality: "approximate",
            message: "Table cell spans are not representable in a GFM table",
            node: cell.type,
            location: here.join("/"),
          });
        cells.push({ type: "tableCell", children: flattenToPhrasing(blocks) });
      }
      rows.push({ type: "tableRow", children: cells });
    }
    const width = Math.max(0, ...rows.map((row) => row.children.length));
    return { type: "table", align: Array.from({ length: width }, () => null), children: rows };
  }
}

/** Diagnostic code per approximated node type, so a consumer can suppress precisely. */
const CODE_FOR_NODE: Record<string, string> = {
  table: CODES.tableFlattened,
  tableRow: CODES.tableFlattened,
  tableCell: CODES.tableFlattened,
  tableHeader: CODES.tableFlattened,
  taskList: CODES.taskListApproximated,
  taskItem: CODES.taskListApproximated,
  panel: CODES.panelApproximated,
  expand: CODES.expandApproximated,
  nestedExpand: CODES.expandApproximated,
  mediaSingle: CODES.mediaApproximated,
  mediaGroup: CODES.mediaApproximated,
  media: CODES.mediaApproximated,
  mediaInline: CODES.mediaApproximated,
  decisionList: CODES.decisionApproximated,
  decisionItem: CODES.decisionApproximated,
  layoutSection: CODES.layoutCollapsed,
  layoutColumn: CODES.layoutCollapsed,
  inlineCard: CODES.cardApproximated,
  blockCard: CODES.cardApproximated,
  embedCard: CODES.cardApproximated,
  extension: CODES.extensionDropped,
  bodiedExtension: CODES.extensionDropped,
  inlineExtension: CODES.extensionDropped,
  multiBodiedExtension: CODES.extensionDropped,
  extensionFrame: CODES.extensionDropped,
  placeholder: CODES.extensionDropped,
};

/** The visible text of a phrasing run, for `inlineCode`, which holds no children. */
function plainText(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text" || node.type === "inlineCode") return node.value;
      if ("children" in node) return plainText(node.children as PhrasingContent[]);
      return "";
    })
    .join("");
}

/** Collapses block content into a single phrasing run, joining blocks with a space. */
function flattenToPhrasing(blocks: BlockContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const block of blocks) {
    if (out.length) out.push(text(" "));
    if (block.type === "paragraph" || block.type === "heading") out.push(...block.children);
    else if (block.type === "code") out.push({ type: "inlineCode", value: block.value });
    else if ("children" in block)
      out.push(...flattenToPhrasing(block.children as unknown as BlockContent[]));
  }
  return out;
}

export interface ToMarkdownResult {
  markdown: string;
  diagnostics: ConversionDiagnostic[];
}

/**
 * Converts an ADF document to Markdown.
 *
 * Emits no frontmatter, ever, and this is not an option: an ADF document carries
 * no title, key, status, or author, so there is nothing to put there. Provenance
 * belongs in the result payload, the way `agent convert` writes a report rather
 * than inlining one.
 */
export function toMarkdown(document: AdfDocument): ToMarkdownResult {
  const converter = new Converter();
  const children = converter.blocks(document.content, ["doc"]) as RootContent[];
  const root: Root = { type: "root", children };
  return { markdown: stringifyMarkdown(root), diagnostics: converter.sink.all() };
}
