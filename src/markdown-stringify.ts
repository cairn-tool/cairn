import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import type { Root } from "mdast";

/**
 * Every stringify option is pinned.
 *
 * Left at their defaults, a `remark-stringify` minor bump silently changes the
 * bytes of every document these converters have ever produced. `emphasis: "_"`
 * and `strong: "*"` also match this repository's own `.markdownlintrc`, so
 * converted documents lint clean where they land.
 *
 * This lives here rather than in either converter because `jira adf to-markdown`
 * and `pdf to-markdown` must emit byte-identical Markdown conventions, and one
 * const with one consumer list is the only mechanical guarantee of that — the
 * same reasoning `src/mapping-quality.ts` records for the quality-to-severity
 * rule. Importing it across toolsets instead would drag the whole ADF converter,
 * its content model, and its diagnostics into the `pdf` import graph.
 */
export const STRINGIFY_OPTIONS = {
  bullet: "-",
  bulletOrdered: ".",
  emphasis: "_",
  strong: "*",
  fence: "`",
  fences: true,
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  setext: false,
  closeAtx: false,
  incrementListMarker: true,
  listItemIndent: "one",
  resourceLink: false,
  tightDefinitions: false,
} as const;

/** Built once. Every converter shares it, which is what keeps the bytes equal. */
const processor = unified()
  .use(remarkGfm)
  .use(remarkStringify, STRINGIFY_OPTIONS as Parameters<typeof remarkStringify>[0]);

/** Renders an mdast tree with the pinned options. */
export function stringifyMarkdown(root: Root): string {
  return processor.stringify(root);
}
