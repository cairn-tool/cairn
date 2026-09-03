import fs from "node:fs";
import { buildContextPack, selectSections, type ContextSeed } from "../context.js";
import { documentSections } from "../sections.js";
import { buildWorkspaceGraph, focusGraph, type WorkspaceGraph } from "../graph.js";
import { findSection } from "../sections.js";
import { buildOutline } from "../outline.js";
import { documentsReferencing } from "../backlinks.js";
import { extractCodeBlocks, extractTasks } from "../markdown-ast.js";
import { nestedValue } from "../object-path.js";
import { lintFile } from "../lint.js";
import { buildPlan } from "../query/plan.js";
import { executePlan } from "../query/execute.js";
import { ENTITY_KINDS } from "../query/entities.js";
import type { Issue } from "../types.js";
import { confine, PathRejected, relativeTo } from "./paths.js";
import { PDF_SERVE_TOOLS } from "./pdf-tools.js";
import type { ServeContext, ServeTool } from "./types.js";

export type { ServeContext, ServeTool } from "./types.js";

// --- argument readers -------------------------------------------------------
// Arguments have already been validated against the tool's schema, so these
// only narrow types; they never re-report a shape error.

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`Missing required argument: ${key}`);
  return value;
}

function stringList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function boolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function integer(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

// --- workspace helpers ------------------------------------------------------

/** A confined file path, rejected unless it exists and is a regular file. */
function fileArgument(args: Record<string, unknown>, key: string, context: ServeContext): string {
  const target = confine(context.root, requiredString(args, key), key);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new PathRejected(`File not found: ${relativeTo(context.root, target)}`);
  }
  return target;
}

/** A confined directory path, defaulting to the served root. */
function directoryArgument(args: Record<string, unknown>, context: ServeContext): string {
  const value = optionalString(args, "directory");
  const target = value === undefined ? context.root : confine(context.root, value, "directory");
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new PathRejected(`Directory not found: ${relativeTo(context.root, target)}`);
  }
  return target;
}

/**
 * The Markdown files under `directory`, with anything that physically escapes
 * the root dropped.
 *
 * `Workspace.markdownFiles` skips symlinked directories but deliberately admits
 * symlinked files, so a link inside the root pointing outside it would
 * otherwise be walked into the result under an in-root name.
 */
function documentsUnder(
  directory: string,
  args: Record<string, unknown>,
  context: ServeContext,
): string[] {
  const include = stringList(args, "include");
  const exclude = stringList(args, "exclude");
  const files = context.workspace.markdownFiles(directory, {
    ...(include.length ? { include } : {}),
    ...(exclude.length ? { exclude } : {}),
  });
  return files.filter((file) => {
    try {
      confine(context.root, file, "file");
      return true;
    } catch {
      return false;
    }
  });
}

const STRING_ARRAY = { type: "array", items: { type: "string" } } as const;

function selection(): Record<string, unknown> {
  return {
    include: {
      ...STRING_ARRAY,
      description: "Glob patterns to include, overriding configuration.",
    },
    exclude: {
      ...STRING_ARRAY,
      description: "Glob patterns to exclude, overriding configuration.",
    },
  };
}

const DIRECTORY = {
  type: "string",
  description: "Directory relative to the served root. Defaults to the root itself.",
} as const;

const FILE = {
  type: "string",
  description: "Markdown file relative to the served root.",
} as const;

// --- tools ------------------------------------------------------------------

const listDocuments: ServeTool = {
  name: "list_documents",
  description:
    "List the Markdown documents under a directory of the served workspace, honoring the workspace's configured include and exclude patterns.",
  inputSchema: {
    type: "object",
    properties: { directory: DIRECTORY, ...selection() },
  },
  handler: (args, context) => {
    const directory = directoryArgument(args, context);
    const files = documentsUnder(directory, args, context);
    return {
      directory: relativeTo(context.root, directory),
      count: files.length,
      files: files.map((file) => relativeTo(context.root, file)),
    };
  },
};

const getSection: ServeTool = {
  name: "get_section",
  description:
    "Extract one section of a Markdown document by heading text or slug, with its line range. Mirrors `md section`.",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE,
      heading: { type: "string", description: "Heading text or slug to locate." },
      children: {
        type: "boolean",
        description: "Extend the section through deeper headings. Defaults to true.",
      },
      includeHeading: {
        type: "boolean",
        description: "Include the heading line itself. Defaults to true.",
      },
    },
    required: ["file", "heading"],
  },
  handler: (args, context) => {
    const file = fileArgument(args, "file", context);
    const heading = requiredString(args, "heading");
    const document = context.workspace.document(file);
    const section = findSection(document, heading, {
      children: boolean(args, "children", true),
      includeHeading: boolean(args, "includeHeading", true),
    });
    if (!section) throw new Error(`Heading not found: ${heading}`);
    return {
      file: relativeTo(context.root, file),
      heading: section.heading.text,
      slug: section.heading.slug,
      depth: section.heading.depth,
      startLine: section.startLine,
      endLine: section.endLine,
      content: section.content,
    };
  },
};

const queryWorkspace: ServeTool = {
  name: "query_workspace",
  description:
    "Run a composable query over the workspace: filter an entity with `where` predicates, project fields with `select`, and optionally group. Mirrors `md query`.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...ENTITY_KINDS], description: "Entity to query." },
      where: {
        ...STRING_ARRAY,
        description:
          "Predicates, conjoined. Comparisons such as `depth=2` or `frontmatter.status=published`, or named forms such as `has:h1` and `links-to:docs/api.md`, optionally negated with a leading `!`.",
      },
      select: { ...STRING_ARRAY, description: "Fields to project, in column order." },
      groupBy: { type: "string", description: "Field to group results by." },
      directory: DIRECTORY,
      ...selection(),
    },
    required: ["kind"],
  },
  handler: (args, context) => {
    const directory = directoryArgument(args, context);
    const files = documentsUnder(directory, args, context);
    const groupBy = optionalString(args, "groupBy");
    const plan = buildPlan({
      kind: requiredString(args, "kind"),
      where: stringList(args, "where"),
      select: stringList(args, "select"),
      ...(groupBy === undefined ? {} : { groupBy }),
    });
    const result = executePlan(plan, {
      workspace: context.workspace,
      files,
      displayPath: (file) => relativeTo(context.root, file),
    });
    // Key for key the same envelope `md query --format json` emits in composable
    // mode, so a consumer can move between the two without a shape surprise.
    return {
      kind: plan.entity,
      directory: relativeTo(context.root, directory),
      count: result.groups ? result.groups.length : result.rows.length,
      results: result.groups ?? result.rows,
      fields: result.fields,
      ...(plan.groupBy ? { groupBy: plan.groupBy } : {}),
      ...(result.groups
        ? { summary: { matched: result.matched, groups: result.groups.length } }
        : {}),
    };
  },
};

const buildContext: ServeTool = {
  name: "build_context",
  description:
    "Assemble a reproducible context pack by traversing the reference graph from one or more seed documents, with per-section provenance and a byte budget. Mirrors `md context`.",
  inputSchema: {
    type: "object",
    properties: {
      seeds: {
        ...STRING_ARRAY,
        description: "Seed documents relative to the served root.",
        minItems: 1,
      },
      section: {
        type: "string",
        description: "Restrict a single seed to one heading. Only valid with exactly one seed.",
      },
      children: {
        type: "boolean",
        description: "Include the selected section's descendants. Defaults to true.",
      },
      depth: { type: "integer", minimum: 0, description: "Graph hops to traverse. Defaults to 1." },
      backlinks: {
        type: "boolean",
        description: "Traverse inbound links as well as outbound. Defaults to false.",
      },
      frontmatter: {
        type: "boolean",
        description: "Include each document's frontmatter as a unit. Defaults to false.",
      },
      budgetBytes: {
        type: "integer",
        minimum: 0,
        description: "Byte budget; 0 means unlimited. Defaults to 0.",
      },
      directory: DIRECTORY,
      ...selection(),
    },
    required: ["seeds"],
  },
  handler: (args, context) => {
    const directory = directoryArgument(args, context);
    const files = documentsUnder(directory, args, context);
    const seedPaths = stringList(args, "seeds").map((seed) => {
      const target = confine(context.root, seed, "seed");
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new PathRejected(`File not found: ${relativeTo(context.root, target)}`);
      }
      return target;
    });
    if (seedPaths.length === 0) throw new Error("At least one seed is required");

    const section = optionalString(args, "section");
    let seeds: ContextSeed[] = seedPaths.map((file) => ({ file }));
    if (section !== undefined) {
      if (seedPaths.length !== 1) {
        throw new Error("section requires exactly one seed");
      }
      const sections = documentSections(context.workspace.document(seedPaths[0]));
      const selected = selectSections(sections, section, boolean(args, "children", true));
      if (selected.length === 0) throw new Error(`Heading not found: ${section}`);
      seeds = [{ file: seedPaths[0], sections: selected }];
    }

    return buildContextPack({
      workspace: context.workspace,
      seeds,
      // Seeds outside the selected set would traverse to nothing.
      files: [...new Set([...files, ...seedPaths])].sort(),
      depth: integer(args, "depth", 1),
      backlinks: boolean(args, "backlinks", false),
      frontmatter: boolean(args, "frontmatter", false),
      budgetBytes: integer(args, "budgetBytes", 0),
      path: (file) => relativeTo(context.root, file),
    });
  },
};

/** The `md graph --format json` report, with paths rendered relative to the served root. */
function graphReport(
  graph: WorkspaceGraph,
  show: (file: string) => string,
  focus?: { files: string[]; depth: number; nodes: number; omitted: number },
): Record<string, unknown> {
  return {
    files: graph.nodes.length,
    ...(focus ? { focus } : {}),
    nodes: graph.nodes.map((node) => ({ ...node, file: show(node.file) })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      source: show(edge.source),
      target: show(edge.target),
    })),
    broken: graph.broken.map((edge) => ({
      ...edge,
      source: show(edge.source),
      resolved: show(edge.resolved),
    })),
    entries: graph.entries.map(show),
    reachabilityEvaluated: graph.reachabilityEvaluated,
    unreachable: graph.unreachable.map(show),
    deadEnds: graph.nodes.filter((node) => node.deadEnd).map((node) => show(node.file)),
    components: graph.components.map((group) => group.map(show)),
    cycles: graph.cycles.map((group) => group.map(show)),
  };
}

const inspectGraph: ServeTool = {
  name: "inspect_graph",
  description:
    "Build the reference graph for a directory: edges, broken targets, reachability from entry points, dead ends, weak components, and cycles. Mirrors `md graph`.",
  inputSchema: {
    type: "object",
    properties: {
      directory: DIRECTORY,
      entry: {
        ...STRING_ARRAY,
        description: "Entry-point documents, which enable the reachability analysis.",
      },
      focus: {
        ...STRING_ARRAY,
        description: "Project an undirected neighborhood around these documents.",
      },
      depth: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Neighborhood radius for focus. Defaults to 6.",
      },
      ...selection(),
    },
  },
  handler: (args, context) => {
    const directory = directoryArgument(args, context);
    const files = documentsUnder(directory, args, context);
    const show = (file: string): string => relativeTo(context.root, file);

    const entries = stringList(args, "entry").map((entry) => {
      const target = confine(context.root, entry, "entry");
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new PathRejected(`Entry point not found: ${relativeTo(context.root, target)}`);
      }
      return target;
    });
    const full = buildWorkspaceGraph(context.workspace, files, entries);

    const focusFiles = stringList(args, "focus");
    if (focusFiles.length === 0) return graphReport(full, show);

    // Projected from the complete graph, so a link leaving the radius stays a
    // resolved edge rather than becoming a fabricated broken target.
    const depth = integer(args, "depth", 6);
    const selected = new Set(full.nodes.map((node) => node.file));
    const roots = focusFiles.map((file) => confine(context.root, file, "focus"));
    for (const root of roots) {
      if (!selected.has(root)) {
        throw new Error(`Focus document not in the selected set: ${show(root)}`);
      }
    }
    const graph = focusGraph(full, roots, depth);
    return graphReport(graph, show, {
      files: roots.map(show),
      depth,
      nodes: graph.nodes.length,
      omitted: full.nodes.length - graph.nodes.length,
    });
  },
};

const auditMarkdown: ServeTool = {
  name: "audit_markdown",
  description:
    "Lint Markdown documents for style, Mermaid, KaTeX, and local-reference problems, using the workspace's configured checks. Mirrors `md lint-dir`.",
  inputSchema: {
    type: "object",
    properties: {
      files: {
        ...STRING_ARRAY,
        description: "Specific documents to check. Defaults to every document under `directory`.",
      },
      directory: DIRECTORY,
      style: { type: "boolean", description: "Run markdownlint style rules." },
      mermaid: { type: "boolean", description: "Validate Mermaid diagrams." },
      katex: { type: "boolean", description: "Validate KaTeX math." },
      references: { type: "boolean", description: "Validate local references." },
      ...selection(),
    },
  },
  handler: async (args, context) => {
    const explicit = stringList(args, "files");
    const directory = directoryArgument(args, context);
    const targets = explicit.length
      ? explicit.map((file) => fileArgument({ file }, "file", context))
      : documentsUnder(directory, args, context);

    const options: Record<string, boolean> = {};
    for (const key of ["style", "mermaid", "katex", "references"]) {
      const value = args[key];
      if (typeof value === "boolean") options[key] = value;
    }

    // The SDK does not serialize requests, so an unbounded fan-out here would
    // starve the transport on a large workspace.
    const results = new Array<Issue[]>(targets.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        const index = next++;
        const file = targets[index];
        results[index] = await lintFile(file, options, context.workspace.document(file));
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(context.concurrency, targets.length)) }, worker),
    );

    const issues = results.flat().map((issue) => ({
      ...issue,
      file: relativeTo(context.root, issue.file),
    }));
    return {
      directory: relativeTo(context.root, directory),
      checked: targets.length,
      count: issues.length,
      issues,
    };
  },
};

const getOutline: ServeTool = {
  name: "get_outline",
  description: "Return the heading tree of a Markdown document. Mirrors `md outline`.",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE,
      maxDepth: {
        type: "integer",
        minimum: 1,
        maximum: 6,
        description: "Deepest heading level to include. Defaults to 6.",
      },
    },
    required: ["file"],
  },
  handler: (args, context) => {
    const file = fileArgument(args, "file", context);
    const maxDepth = Math.min(6, Math.max(1, integer(args, "maxDepth", 6)));
    const headings = context.workspace
      .document(file)
      .headings.filter((heading) => heading.depth <= maxDepth);
    return {
      file: relativeTo(context.root, file),
      outline: buildOutline(headings),
    };
  },
};

const getFrontmatter: ServeTool = {
  name: "get_frontmatter",
  description:
    "Read a document's YAML frontmatter, or one key within it using dotted path notation. Mirrors `md frontmatter`.",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE,
      key: { type: "string", description: "Dotted key path, for example `authors.0.name`." },
    },
    required: ["file"],
  },
  handler: (args, context) => {
    const file = fileArgument(args, "file", context);
    const shown = relativeTo(context.root, file);
    const frontmatter = context.workspace.document(file).frontmatter;
    const key = optionalString(args, "key");

    if (frontmatter.status === "missing") {
      if (key !== undefined) throw new Error(`Key not found: ${key} (no frontmatter in file)`);
      return { file: shown, status: "missing", frontmatter: null };
    }
    if (frontmatter.status === "malformed") throw new Error(`${shown}: ${frontmatter.message}`);
    if (frontmatter.status === "non-mapping") {
      return { file: shown, status: "non-mapping", frontmatter: frontmatter.data };
    }

    if (key === undefined) {
      return { file: shown, status: "valid", frontmatter: frontmatter.data };
    }
    const value = nestedValue(frontmatter.data, key);
    if (value === undefined) throw new Error(`Key not found: ${key}`);
    return { file: shown, status: "valid", key, value };
  },
};

const listTasks: ServeTool = {
  name: "list_tasks",
  description: "List the task-list items in a Markdown document. Mirrors `md tasks`.",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE,
      status: {
        type: "string",
        enum: ["all", "done", "pending"],
        description: "Filter by completion. Defaults to all.",
      },
    },
    required: ["file"],
  },
  handler: (args, context) => {
    const file = fileArgument(args, "file", context);
    const all = extractTasks(context.workspace.document(file).tree);
    const status = optionalString(args, "status") ?? "all";
    const tasks =
      status === "done"
        ? all.filter((task) => task.checked)
        : status === "pending"
          ? all.filter((task) => !task.checked)
          : all;
    return {
      file: relativeTo(context.root, file),
      total: tasks.length,
      done: tasks.filter((task) => task.checked).length,
      pending: tasks.filter((task) => !task.checked).length,
      tasks: tasks.map((task) => ({ line: task.line, checked: task.checked, text: task.text })),
    };
  },
};

const listCodeBlocks: ServeTool = {
  name: "list_code_blocks",
  description:
    "List the fenced code blocks in a Markdown document, optionally with their contents. Mirrors `md code-blocks`.",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE,
      lang: { type: "string", description: "Only blocks with this info string." },
      content: { type: "boolean", description: "Include block contents. Defaults to false." },
    },
    required: ["file"],
  },
  handler: (args, context) => {
    const file = fileArgument(args, "file", context);
    const lang = optionalString(args, "lang");
    const withContent = boolean(args, "content", false);
    const blocks = extractCodeBlocks(context.workspace.document(file).tree).filter(
      (block) => lang === undefined || block.lang === lang,
    );
    return {
      file: relativeTo(context.root, file),
      count: blocks.length,
      blocks: blocks.map((block) => ({
        line: block.line,
        endLine: block.endLine,
        lang: block.lang,
        lines: block.endLine - block.line + 1,
        ...(withContent ? { content: block.value } : {}),
      })),
    };
  },
};

const findReferences: ServeTool = {
  name: "find_references",
  description:
    "Find every local reference in the workspace that resolves to a given file — its backlinks. Mirrors `md refs-to`.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "The referenced file, relative to the served root. Need not be Markdown.",
      },
      directory: DIRECTORY,
      ...selection(),
    },
    required: ["file"],
  },
  handler: (args, context) => {
    const target = confine(context.root, requiredString(args, "file"), "file");
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new PathRejected(`File not found: ${relativeTo(context.root, target)}`);
    }
    const directory = directoryArgument(args, context);
    const files = documentsUnder(directory, args, context);
    const references = documentsReferencing(files, target);
    return {
      file: relativeTo(context.root, target),
      directory: relativeTo(context.root, directory),
      count: references.length,
      references: references.map((reference) => ({
        ...reference,
        sourceFile: relativeTo(context.root, reference.sourceFile),
      })),
    };
  },
};

export const SERVE_TOOLS: readonly ServeTool[] = [
  listDocuments,
  getSection,
  queryWorkspace,
  buildContext,
  inspectGraph,
  auditMarkdown,
  getOutline,
  getFrontmatter,
  listTasks,
  listCodeBlocks,
  findReferences,
  // The PDF tools live in their own module: this file is uniformly the Markdown
  // workspace engine, and registration is still one list.
  ...PDF_SERVE_TOOLS,
];

export const TOOL_BY_NAME: ReadonlyMap<string, ServeTool> = new Map(
  SERVE_TOOLS.map((tool) => [tool.name, tool]),
);
