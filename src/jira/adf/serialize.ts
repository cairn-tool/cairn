import type { AdfDocument, AdfMark, AdfNode } from "./types.js";

/**
 * Serializes ADF with a fixed key order.
 *
 * `JSON.stringify` follows insertion order, so key order is contract: a consumer
 * diffing converted ADF in Git sees every reordering. This is the same reason
 * `src/sarif.ts` builds its document in a load-bearing order and
 * `tests/unit/automation.test.ts` asserts byte equality against a fixed input.
 *
 * The order is `version`, `type`, `attrs`, `content`, `marks`, `text` — the
 * order Atlassian's own editor emits, so a converted document diffs cleanly
 * against one round-tripped through Jira.
 */

function orderMark(mark: AdfMark): AdfMark {
  const ordered: AdfMark = { type: mark.type };
  if (mark.attrs !== undefined) ordered.attrs = orderAttrs(mark.attrs);
  return ordered;
}

/**
 * Attribute order within `attrs` is contract too, and there is no natural one,
 * so it is byte order. Never `localeCompare`: that is ICU-build and locale
 * dependent, so a differently configured runner would reorder the output.
 */
function orderAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    ordered[key] = attrs[key];
  return ordered;
}

function orderNode(node: AdfNode): AdfNode {
  const ordered: AdfNode = { type: node.type };
  if (node.attrs !== undefined) ordered.attrs = orderAttrs(node.attrs);
  if (node.content !== undefined) ordered.content = node.content.map(orderNode);
  if (node.marks !== undefined) ordered.marks = node.marks.map(orderMark);
  if (node.text !== undefined) ordered.text = node.text;
  return ordered;
}

/** Returns the document with every key in canonical order. */
export function canonicalize(document: AdfDocument): AdfDocument {
  return {
    version: document.version,
    type: "doc",
    ...(document.content === undefined ? {} : { content: document.content.map(orderNode) }),
  };
}

/** Canonical ADF JSON, two-space indented, one trailing newline. */
export function serializeAdf(document: AdfDocument): string {
  return `${JSON.stringify(canonicalize(document), null, 2)}\n`;
}
