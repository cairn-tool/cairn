import type {
  Definition,
  FootnoteDefinition,
  Heading,
  Image,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
} from "mdast";
import { parseMarkdown } from "../../markdown-ast.js";
import { CODES, DiagnosticSink } from "./diagnostics.js";
import { accepts, degradationFor } from "./profile.js";
import type { AdfDocument, AdfMark, AdfNode, ConversionDiagnostic } from "./types.js";

/**
 * Markdown to ADF.
 *
 * The hard direction, and not because of missing node types: ADF validates
 * per-node content, and Markdown permits nestings ADF forbids. So this is not a
 * node-for-node walk — every emission is checked against the content model in
 * `profile.ts`, and an illegal pair takes that table's degradation rather than
 * being emitted and rejected downstream.
 *
 * The rule the degradations follow: flatten in place, never lift. Promoting a
 * heading out of a list item would move it past the text that followed it, so
 * the output would be legal, plausible, and saying something the input did not.
 */

const text = (value: string, marks?: AdfMark[]): AdfNode => ({
  type: "text",
  ...(marks?.length ? { marks } : {}),
  text: value,
});

/** An empty paragraph, the filler for containers ADF requires to be nonempty. */
const emptyParagraph = (): AdfNode => ({ type: "paragraph", content: [] });

/** Marks accumulated walking down nested mdast phrasing content. */
type MarkSet = AdfMark[];

function withMark(marks: MarkSet, mark: AdfMark): MarkSet {
  return marks.some((existing) => existing.type === mark.type) ? marks : [...marks, mark];
}

class Converter {
  readonly sink = new DiagnosticSink();
  private readonly definitions = new Map<string, Definition>();
  private readonly footnotes: FootnoteDefinition[] = [];
  private localIds = 0;

  constructor(private readonly root: Root) {
    collect(root, this.definitions, this.footnotes);
  }

  /**
   * Derived, never generated.
   *
   * `taskList` and `taskItem` require a `localId`, and `crypto.randomUUID()`
   * here would make every test that compares output bytes unrunnable.
   */
  private nextLocalId(prefix: string): string {
    this.localIds += 1;
    return `${prefix}-${this.localIds}`;
  }

  convert(): AdfDocument {
    const content = this.blocks(this.root.children, "doc", ["doc"]);
    if (this.footnotes.length) content.push(...this.footnoteBlocks());
    return { version: 1, type: "doc", content };
  }

  /**
   * Footnote definitions become paragraphs after a trailing rule.
   *
   * Order-preserving in practice: footnote definitions conventionally sit at the
   * end of a document already.
   */
  private footnoteBlocks(): AdfNode[] {
    const out: AdfNode[] = [{ type: "rule" }];
    for (const [index, definition] of this.footnotes.entries()) {
      const label = definition.label ?? definition.identifier ?? String(index + 1);
      const body = this.blocks(definition.children as RootContent[], "doc", ["doc", "footnote"]);
      out.push({
        type: "paragraph",
        content: [text(`[${label}]`, [{ type: "strong" }])],
      });
      out.push(...body);
    }
    return out;
  }

  /** Converts mdast flow content into ADF blocks legal inside `parent`. */
  blocks(nodes: RootContent[], parent: string, trail: string[]): AdfNode[] {
    const out: AdfNode[] = [];
    for (const node of nodes) out.push(...this.block(node, parent, trail));
    return out;
  }

  private block(node: RootContent, parent: string, trail: string[]): AdfNode[] {
    switch (node.type) {
      case "yaml": {
        // Frontmatter is metadata about the document, not content of it, so it
        // never becomes ADF body content.
        this.sink.add({
          code: CODES.frontmatterDropped,
          quality: "approximate",
          message: "YAML frontmatter is metadata and was not converted into the document body",
          node: "yaml",
          location: trail.join("/"),
          remediation: "Carry the frontmatter separately if the receiving system needs it.",
        });
        return [];
      }
      case "definition":
        // Consumed while resolving references, not emitted.
        return [];
      case "footnoteDefinition":
        // Emitted at the end of the document instead.
        return [];
      case "html": {
        this.sink.add({
          code: CODES.htmlPreserved,
          quality: "approximate",
          message: "ADF has no raw HTML node, so the markup was preserved verbatim in a code block",
          node: "html",
          location: trail.join("/"),
        });
        return this.place({ type: "codeBlock", content: [text(node.value)] }, parent, trail);
      }
      case "paragraph":
        return this.paragraph(node, parent, trail);
      case "heading":
        return this.place(this.heading(node, trail), parent, trail);
      case "thematicBreak":
        return this.place({ type: "rule" }, parent, trail);
      case "code": {
        const language = node.lang ?? undefined;
        return this.place(
          {
            type: "codeBlock",
            ...(language ? { attrs: { language } } : {}),
            content: node.value === "" ? [] : [text(node.value)],
          },
          parent,
          trail,
        );
      }
      case "blockquote": {
        const children = this.blocks(node.children as RootContent[], "blockquote", [
          ...trail,
          "blockquote",
        ]);
        if (!children.length) {
          this.sink.add({
            code: CODES.contentDropped,
            quality: "unsupported",
            message: "An empty block quote was dropped: ADF requires a quote to hold content",
            node: "blockquote",
            location: trail.join("/"),
          });
          return [];
        }
        return this.place({ type: "blockquote", content: children }, parent, trail);
      }
      case "list":
        return this.lists(node, parent, trail);
      case "table":
        return this.place(this.table(node, trail), parent, trail);
      default:
        return [];
    }
  }

  /**
   * Emits `node` inside `parent`, degrading it when the content model forbids it.
   *
   * Every block goes through here, which is what makes the legality pass total
   * rather than a set of special cases.
   */
  private place(node: AdfNode, parent: string, trail: string[]): AdfNode[] {
    if (accepts(parent, node.type)) return [node];
    const rule = degradationFor(parent, node.type);
    if (!rule) {
      // Unreachable while tests/unit/jira-adf-profile.test.ts passes: it fails the
      // build on any pair this walk can form that has neither a legal mapping
      // nor a rule. Reported rather than thrown so a gap degrades visibly.
      this.sink.add({
        code: CODES.contentDropped,
        quality: "unsupported",
        message: `ADF does not allow ${node.type} inside ${parent}, and no degradation is defined`,
        node: node.type,
        location: trail.join("/"),
      });
      return [];
    }

    const location = trail.join("/");
    switch (rule.action) {
      case "drop":
        this.sink.add({
          code: CODES.contentDropped,
          quality: rule.quality,
          message: `ADF does not allow ${node.type} inside ${parent}; it carries no content, so it was omitted`,
          node: node.type,
          location,
        });
        return [];
      case "strong-paragraph": {
        this.sink.add({
          code: CODES.headingFlattened,
          quality: rule.quality,
          message: `ADF does not allow ${node.type} inside ${parent}; it became a paragraph in bold, in place`,
          node: node.type,
          location,
        });
        return [{ type: "paragraph", content: boldRun(node.content ?? []) }];
      }
      case "unwrap": {
        this.sink.add({
          code: CODES.blockquoteUnwrapped,
          quality: rule.quality,
          message: `ADF does not allow ${node.type} inside ${parent}; its contents were lifted in place`,
          node: node.type,
          location,
        });
        // Re-place each child, so an unwrapped child that is itself illegal is
        // degraded rather than emitted.
        return (node.content ?? []).flatMap((child) => this.place(child, parent, trail));
      }
      case "rows-as-paragraphs": {
        this.sink.add({
          code: CODES.tableFlattenedToRows,
          quality: rule.quality,
          message: `ADF does not allow ${node.type} inside ${parent}; each row became a paragraph`,
          node: node.type,
          location,
        });
        return (node.content ?? []).map((row) => ({
          type: "paragraph",
          content: joinCells(row.content ?? []),
        }));
      }
      case "list-downgrade": {
        this.sink.add({
          code: CODES.listSplit,
          quality: rule.quality,
          message: `ADF does not allow ${node.type} inside ${parent}; it became a bulleted list keeping each state as a text prefix`,
          node: node.type,
          location,
        });
        return [downgradeTaskList(node)];
      }
      case "inline-flatten": {
        this.sink.add({
          code: CODES.contentDropped,
          quality: rule.quality,
          message: `ADF allows only inline content inside ${parent}; block content was flattened`,
          node: node.type,
          location,
        });
        return [];
      }
    }
  }

  private heading(node: Heading, trail: string[]): AdfNode {
    return {
      type: "heading",
      attrs: { level: node.depth },
      content: this.inline(node.children, [], [...trail, "heading"]),
    };
  }

  /**
   * A paragraph, split around any block-level image it contains.
   *
   * `mediaInline` cannot carry an external URL — verified against the published
   * schema — so a Markdown image cannot stay inside its paragraph. Splitting
   * preserves reading order exactly: nothing moves past anything else, which is
   * what separates this from lifting.
   */
  private paragraph(node: Paragraph, parent: string, trail: string[]): AdfNode[] {
    const here = [...trail, "paragraph"];
    const images = node.children.filter((child): child is Image => child.type === "image");
    if (!images.length || !accepts(parent, "mediaSingle"))
      return this.place(
        { type: "paragraph", content: this.inline(node.children, [], here) },
        parent,
        trail,
      );

    this.sink.add({
      code: CODES.paragraphSplit,
      quality: "approximate",
      message:
        "ADF images are block-level, so the paragraph was split around the image rather than reordered",
      node: "image",
      location: here.join("/"),
    });

    const out: AdfNode[] = [];
    let run: PhrasingContent[] = [];
    const flush = (): void => {
      // Trimmed at the edges: the split leaves the space that sat beside the
      // image, and a text node that is only whitespace serializes back as a
      // literal `&#x20;`.
      const content = trimEdges(this.inline(run, [], here));
      if (content.length) out.push({ type: "paragraph", content });
      run = [];
    };
    for (const child of node.children) {
      if (child.type !== "image") {
        run.push(child);
        continue;
      }
      flush();
      out.push({
        type: "mediaSingle",
        content: [
          {
            type: "media",
            attrs: {
              type: "external",
              url: child.url,
              ...(child.alt ? { alt: child.alt } : {}),
            },
          },
        ],
      });
    }
    flush();
    return out;
  }

  /**
   * A GFM list, split into runs so a mixed list keeps every item in place.
   *
   * ADF has no list that holds both task items and plain items, so a contiguous
   * run of checkbox items becomes a `taskList` and a run without becomes a
   * bulleted or ordered list.
   */
  private lists(node: List, parent: string, trail: string[]): AdfNode[] {
    const isTask = (item: ListItem): boolean => item.checked === true || item.checked === false;
    const runs: Array<{ task: boolean; items: ListItem[] }> = [];
    for (const child of node.children) {
      const task = isTask(child);
      const last = runs[runs.length - 1];
      if (last && last.task === task) last.items.push(child);
      else runs.push({ task, items: [child] });
    }
    if (runs.length > 1)
      this.sink.add({
        code: CODES.listSplit,
        quality: "approximate",
        message:
          "ADF has no list holding both task and plain items, so the list was split into runs in place",
        node: "list",
        location: trail.join("/"),
      });

    const out: AdfNode[] = [];
    for (const run of runs) {
      const emitted = run.task
        ? this.taskList(run.items, trail)
        : this.plainList(node, run.items, trail);
      if (emitted) out.push(...this.place(emitted, parent, trail));
    }
    return out;
  }

  private plainList(node: List, items: ListItem[], trail: string[]): AdfNode | undefined {
    const type = node.ordered ? "orderedList" : "bulletList";
    const here = [...trail, type];
    const content: AdfNode[] = [];
    for (const item of items) {
      const blocks = this.blocks(item.children as RootContent[], "listItem", [...here, "listItem"]);
      // ADF requires a list item to hold at least one block.
      content.push({ type: "listItem", content: blocks.length ? blocks : [emptyParagraph()] });
    }
    if (!content.length) {
      this.sink.add({
        code: CODES.contentDropped,
        quality: "unsupported",
        message: "An empty list was dropped: ADF requires a list to hold at least one item",
        node: type,
        location: trail.join("/"),
      });
      return undefined;
    }
    const start = node.start ?? 1;
    return {
      type,
      ...(node.ordered && start !== 1 ? { attrs: { order: start } } : {}),
      content,
    };
  }

  private taskList(items: ListItem[], trail: string[]): AdfNode | undefined {
    const here = [...trail, "taskList"];
    const content: AdfNode[] = [];
    for (const item of items) {
      const inline = this.taskItemInline(item, here);
      content.push({
        type: "taskItem",
        attrs: { localId: this.nextLocalId("item"), state: item.checked ? "DONE" : "TODO" },
        content: inline,
      });
    }
    if (!content.length) return undefined;
    return { type: "taskList", attrs: { localId: this.nextLocalId("list") }, content };
  }

  /**
   * A task item holds inline content only, so a multi-block item collapses into
   * one run separated by hard breaks.
   */
  private taskItemInline(item: ListItem, trail: string[]): AdfNode[] {
    const blocks = item.children as RootContent[];
    const out: AdfNode[] = [];
    let flattened = false;
    for (const block of blocks) {
      if (out.length) {
        out.push({ type: "hardBreak" });
        flattened = true;
      }
      if (block.type === "paragraph" || block.type === "heading") {
        out.push(...this.inline(block.children, [], [...trail, "taskItem"]));
        continue;
      }
      flattened = true;
      out.push(...flattenBlockToInline(block));
    }
    if (flattened)
      this.sink.add({
        code: CODES.contentDropped,
        quality: "approximate",
        message:
          "ADF allows only inline content in a task item, so its blocks were joined in place",
        node: "taskItem",
        location: trail.join("/"),
      });
    return out;
  }

  private table(node: Table, trail: string[]): AdfNode {
    const here = [...trail, "table"];
    if (node.align?.some((value) => value !== null && value !== undefined))
      this.sink.add({
        code: CODES.alignmentDropped,
        quality: "unsupported",
        message: "An ADF table cell has no alignment attribute, so column alignment was dropped",
        node: "table",
        location: here.join("/"),
      });

    const rows: AdfNode[] = node.children.map((row, rowIndex) => ({
      type: "tableRow",
      content: row.children.map((cell: TableCell) => {
        const inline = this.inline(cell.children, [], [...here, "tableCell"]);
        return {
          // A GFM table always has a header row; ADF spells that as tableHeader.
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          // ADF requires a cell to hold at least one block, and an empty cell is
          // ordinary Markdown, so the filler is load-bearing rather than defensive.
          content: [inline.length ? { type: "paragraph", content: inline } : emptyParagraph()],
        };
      }),
    }));
    return { type: "table", content: rows };
  }

  /** Converts mdast phrasing content to ADF inline nodes, accumulating marks. */
  inline(nodes: PhrasingContent[], marks: MarkSet, trail: string[]): AdfNode[] {
    const out: AdfNode[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          if (node.value !== "") out.push(text(node.value, marks));
          break;
        case "inlineCode":
          if (node.value !== "") out.push(text(node.value, withMark(marks, { type: "code" })));
          break;
        case "strong":
          out.push(...this.inline(node.children, withMark(marks, { type: "strong" }), trail));
          break;
        case "emphasis":
          out.push(...this.inline(node.children, withMark(marks, { type: "em" }), trail));
          break;
        case "delete":
          out.push(...this.inline(node.children, withMark(marks, { type: "strike" }), trail));
          break;
        case "break":
          out.push({ type: "hardBreak" });
          break;
        case "link": {
          const mark: AdfMark = {
            type: "link",
            attrs: { href: node.url, ...(node.title ? { title: node.title } : {}) },
          };
          out.push(...this.inline(node.children, withMark(marks, mark), trail));
          break;
        }
        case "linkReference": {
          const definition = this.definitions.get(node.identifier);
          // Always resolves: CommonMark makes an unresolved reference literal
          // text, so remark never produces a reference node without a matching
          // definition. Kept as a fallback rather than an assertion, but there
          // is no diagnostic for it because nothing can reach it.
          if (!definition) {
            out.push(...this.inline(node.children, marks, trail));
            break;
          }
          const mark: AdfMark = {
            type: "link",
            attrs: {
              href: definition.url,
              ...(definition.title ? { title: definition.title } : {}),
            },
          };
          out.push(...this.inline(node.children, withMark(marks, mark), trail));
          break;
        }
        case "image": {
          // Reached only inside a container that cannot hold a mediaSingle, such
          // as a table cell. The alt text keeps a link to the source.
          this.sink.add({
            code: CODES.paragraphSplit,
            quality: "approximate",
            message: "An image in inline-only content became a link to its source",
            node: "image",
            location: trail.join("/"),
          });
          const mark: AdfMark = { type: "link", attrs: { href: node.url } };
          out.push(text(node.alt ?? node.url, withMark(marks, mark)));
          break;
        }
        case "imageReference": {
          const definition = this.definitions.get(node.identifier);
          // Unreachable for the same reason as linkReference above.
          if (!definition) {
            out.push(text(node.alt ?? node.identifier, marks));
            break;
          }
          const mark: AdfMark = { type: "link", attrs: { href: definition.url } };
          out.push(text(node.alt ?? definition.url, withMark(marks, mark)));
          break;
        }
        case "footnoteReference": {
          this.sink.add({
            code: CODES.footnoteApproximated,
            quality: "approximate",
            message:
              "ADF has no footnotes, so the marker became superscript text and the definition moved to the end",
            node: "footnoteReference",
            location: trail.join("/"),
          });
          const label = node.label ?? node.identifier;
          out.push(text(label, withMark(marks, { type: "subsup", attrs: { type: "sup" } })));
          break;
        }
        case "html": {
          this.sink.add({
            code: CODES.htmlPreserved,
            quality: "approximate",
            message: "ADF has no raw HTML, so inline markup was preserved as inline code",
            node: "html",
            location: trail.join("/"),
          });
          out.push(text(node.value, withMark(marks, { type: "code" })));
          break;
        }
        default: {
          // Exhaustive over mdast's own phrasing types, so this is reached only
          // if a future parser plugin introduces one. Contribute its text rather
          // than taking the content with it.
          const unknown = node as { children?: PhrasingContent[]; value?: unknown };
          if (unknown.children) out.push(...this.inline(unknown.children, marks, trail));
          else if (typeof unknown.value === "string" && unknown.value !== "")
            out.push(text(unknown.value, marks));
        }
      }
    }
    return out;
  }
}

function collect(
  root: Root,
  definitions: Map<string, Definition>,
  footnotes: FootnoteDefinition[],
): void {
  const walk = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === "definition") definitions.set(node.identifier, node);
      else if (node.type === "footnoteDefinition") footnotes.push(node);
      if ("children" in node) walk(node.children as RootContent[]);
    }
  };
  walk(root.children);
}

/** The text of an ADF inline run, with `strong` applied. */
function boldRun(content: AdfNode[]): AdfNode[] {
  const value = adfText(content);
  return value === "" ? [] : [text(value, [{ type: "strong" }])];
}

function adfText(nodes: AdfNode[]): string {
  return nodes.map((node) => node.text ?? adfText(node.content ?? [])).join("");
}

/** Joins a table row's cells into one inline run, separated by a pipe. */
function joinCells(cells: AdfNode[]): AdfNode[] {
  const parts = cells.map((cell) => adfText(cell.content ?? []));
  const value = parts.join(" | ");
  return value === "" ? [] : [text(value)];
}

function flattenBlockToInline(block: RootContent): AdfNode[] {
  if ("children" in block) {
    const value = mdastText(block.children as RootContent[]);
    return value === "" ? [] : [text(value)];
  }
  if ("value" in block && typeof block.value === "string" && block.value !== "")
    return [text(block.value)];
  return [];
}

/**
 * Drops whitespace-only nodes at both ends of an inline run and trims the text
 * at the edges. Only used where a run is produced by splitting, never on author
 * text that stands on its own.
 */
function trimEdges(nodes: AdfNode[]): AdfNode[] {
  const out = [...nodes];
  while (out.length && isBlank(out[0])) out.shift();
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  if (out.length) {
    const first = out[0];
    if (first.type === "text" && first.text !== undefined)
      out[0] = { ...first, text: first.text.replace(/^\s+/, "") };
    const last = out[out.length - 1];
    if (last.type === "text" && last.text !== undefined)
      out[out.length - 1] = { ...last, text: last.text.replace(/\s+$/, "") };
  }
  return out.filter((node) => node.type !== "text" || node.text !== "");
}

function isBlank(node: AdfNode): boolean {
  return node.type === "text" && (node.text ?? "").trim() === "";
}

function mdastText(nodes: RootContent[]): string {
  return nodes
    .map((node) => {
      if ("value" in node && typeof node.value === "string") return node.value;
      if ("children" in node) return mdastText(node.children as RootContent[]);
      return "";
    })
    .join(" ")
    .trim();
}

/**
 * A `taskList` as a `bulletList`, each item keeping a literal state prefix.
 *
 * The prefix keeps the state visible to a reader. It does not survive a round
 * trip as a checkbox: converting back to Markdown escapes the bracket to
 * `\[x]`, because an unescaped one at the start of a list item would silently
 * become a task item again. Visible, not reversible.
 */
function downgradeTaskList(node: AdfNode): AdfNode {
  return {
    type: "bulletList",
    content: (node.content ?? []).map((item) => ({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [text(item.attrs?.state === "DONE" ? "[x] " : "[ ] "), ...(item.content ?? [])],
        },
      ],
    })),
  };
}

export interface FromMarkdownResult {
  document: AdfDocument;
  diagnostics: ConversionDiagnostic[];
}

export function fromMarkdown(markdown: string): FromMarkdownResult {
  // Must be the frontmatter-aware parser. Under the plain one, `---\ntitle: x\n---`
  // parses as a thematic break plus a level-2 heading, so the frontmatter does
  // not go missing — it converts into a rule and a heading reading "title: x".
  const converter = new Converter(parseMarkdown(markdown));
  return { document: converter.convert(), diagnostics: converter.sink.all() };
}
