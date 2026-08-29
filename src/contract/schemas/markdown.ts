import { schemaUri } from "../version.js";
import type { SchemaEntry } from "../types.js";
import { DRAFT, ISSUE_DEF, countMap, stringArray } from "./shared.js";

export const issueSchema: SchemaEntry = {
  id: "issue",
  uri: schemaUri("v1", "issue"),
  title: "Finding record",
  commands: [],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "issue"),
    title: "Finding record",
    description: "A single diagnostic produced by a markdown check.",
    ...ISSUE_DEF,
  },
};

export const issueListSchema: SchemaEntry = {
  id: "issue-list",
  uri: schemaUri("v1", "issue-list"),
  title: "Finding list",
  commands: ["md lint", "md lint-dir", "md validate-frontmatter", "md refs", "md links"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "issue-list"),
    title: "Finding list",
    description:
      "A bare array of findings. Empty when the inputs are clean; the exit code and the stream carry the outcome.",
    type: "array",
    items: { $ref: "#/$defs/issue" },
    $defs: { issue: ISSUE_DEF },
  },
};

export const diagnosticRecordSchema: SchemaEntry = {
  id: "diagnostic-record",
  uri: schemaUri("v1", "diagnostic-record"),
  title: "Automation record",
  commands: ["md lint", "md lint-dir", "md audit", "md validate-frontmatter", "md check-urls"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "diagnostic-record"),
    title: "Automation record",
    description:
      "One line of --format jsonl output. Findings and results stream first, followed by exactly one summary record.",
    type: "object",
    required: ["type"],
    properties: {
      type: { enum: ["finding", "result", "summary"] },
      file: { type: "string" },
      line: { type: "integer", minimum: 0 },
      checker: { type: "string" },
      message: { type: "string" },
      url: { type: "string" },
      status: { type: ["integer", "null"] },
      ok: { type: "boolean" },
      files: { type: "integer", minimum: 0 },
      findings: { type: "integer", minimum: 0 },
      total: { type: "integer", minimum: 0 },
      broken: { type: "integer", minimum: 0 },
      enabled: stringArray,
      skipped: stringArray,
    },
  },
};

export const lintDirSummarySchema: SchemaEntry = {
  id: "lint-dir-summary",
  uri: schemaUri("v1", "lint-dir-summary"),
  title: "Per-file lint summary",
  commands: ["md lint-dir"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "lint-dir-summary"),
    title: "Per-file lint summary",
    description:
      "Emitted by `md lint-dir --summary --format json`. Without --summary the command emits a finding list instead.",
    type: "array",
    items: {
      type: "object",
      required: ["file", "issues", "ok"],
      properties: {
        file: { type: "string" },
        issues: { type: "integer", minimum: 0 },
        ok: { type: "boolean" },
      },
    },
  },
};

export const mdGraphSchema: SchemaEntry = {
  id: "md-graph",
  uri: schemaUri("v1", "md-graph"),
  title: "Reference graph report",
  commands: ["md graph"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-graph"),
    title: "Reference graph report",
    description:
      "Emitted by `md graph --output report`. The mermaid and dot outputs are not JSON and ignore --format.",
    type: "object",
    required: [
      "files",
      "nodes",
      "edges",
      "broken",
      "entries",
      "reachabilityEvaluated",
      "unreachable",
      "deadEnds",
      "components",
      "cycles",
    ],
    properties: {
      files: { type: "integer", minimum: 0 },
      focus: {
        description:
          "The neighborhood that was reported. Present only when --focus was given. Node counts and structural groups are still derived from the whole graph.",
        type: "object",
        required: ["files", "depth", "nodes", "omitted"],
        properties: {
          files: stringArray,
          depth: { type: "integer", minimum: 0, maximum: 6 },
          nodes: { type: "integer", minimum: 0 },
          omitted: {
            type: "integer",
            minimum: 0,
            description: "Selected documents outside the neighborhood.",
          },
        },
      },
      nodes: { type: "array", items: { $ref: "#/$defs/node" } },
      edges: { type: "array", items: { $ref: "#/$defs/edge" } },
      broken: { type: "array", items: { $ref: "#/$defs/brokenEdge" } },
      entries: stringArray,
      reachabilityEvaluated: {
        type: "boolean",
        description: "False when no entry points were resolved, making `unreachable` meaningless.",
      },
      unreachable: stringArray,
      deadEnds: stringArray,
      components: { type: "array", items: stringArray },
      cycles: { type: "array", items: stringArray },
    },
    $defs: {
      node: {
        type: "object",
        required: ["file", "inbound", "outbound", "deadEnd"],
        properties: {
          file: { type: "string" },
          inbound: { type: "integer", minimum: 0 },
          outbound: { type: "integer", minimum: 0 },
          deadEnd: { type: "boolean" },
        },
      },
      edge: {
        type: "object",
        required: ["source", "target", "lines", "occurrences"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          lines: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            description: "Every line in the source that links to the target.",
          },
          occurrences: { type: "integer", minimum: 1 },
        },
      },
      brokenEdge: {
        type: "object",
        required: ["source", "target", "resolved", "line"],
        properties: {
          source: { type: "string" },
          resolved: { type: "string", description: "The path the link resolved to." },
          target: { type: "string", description: "The raw link target as written." },
          line: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};

export const mdAuditSchema: SchemaEntry = {
  id: "md-audit",
  uri: schemaUri("v1", "md-audit"),
  title: "Workspace audit report",
  commands: ["md audit"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-audit"),
    title: "Workspace audit report",
    description:
      "The jsonl and sarif forms of this command carry only the findings, not the totals or graph summary.",
    type: "object",
    required: ["directory", "enabled", "skipped", "totals", "findings"],
    properties: {
      directory: { type: "string" },
      enabled: stringArray,
      skipped: stringArray,
      totals: {
        type: "object",
        required: ["files", "findings", "filesWithFindings", "byCheck", "byFile"],
        properties: {
          files: { type: "integer", minimum: 0 },
          findings: { type: "integer", minimum: 0 },
          filesWithFindings: { type: "integer", minimum: 0 },
          byCheck: countMap,
          byFile: countMap,
        },
      },
      findings: { type: "array", items: { $ref: "#/$defs/issue" } },
      baseline: {
        description:
          "Baseline suppression. Present only when --baseline was given. Never affects the exit code by itself: `stale` records entries that matched nothing, which means something was fixed.",
        type: "object",
        required: ["path", "suppressed", "stale"],
        properties: {
          path: { type: "string" },
          suppressed: { type: "integer", minimum: 0 },
          stale: { type: "array", items: { $ref: "#/$defs/baselineEntry" } },
        },
      },
      graph: {
        description: "Omitted entirely when the graph check is disabled.",
        type: "object",
        properties: {
          nodes: { type: "integer", minimum: 0 },
          edges: { type: "integer", minimum: 0 },
          broken: { type: "integer", minimum: 0 },
          unreachable: { type: "integer", minimum: 0 },
          deadEnds: { type: "integer", minimum: 0 },
          components: { type: "integer", minimum: 0 },
          cycles: { type: "integer", minimum: 0 },
          reachabilityEvaluated: { type: "boolean" },
        },
      },
    },
    $defs: {
      issue: ISSUE_DEF,
      baselineEntry: {
        type: "object",
        description:
          "One recorded finding. Keyed without a line number, so `count` carries multiplicity: a second identical finding in the same file is a regression.",
        required: ["checker", "file", "message", "count"],
        properties: {
          checker: { type: "string" },
          file: { type: "string", description: "Workspace-relative, with `/` separators." },
          message: { type: "string" },
          count: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

export const mdQuerySchema: SchemaEntry = {
  id: "md-query",
  uri: schemaUri("v1", "md-query"),
  title: "Workspace query result",
  commands: ["md query"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-query"),
    title: "Workspace query result",
    description:
      "Two modes share one payload. Without composable options the six shortcut kinds emit their historical shapes and `kind` determines the shape of `results`. With --where, --select, or --group-by, `kind` names an entity, `fields` carries the projection in column order, and `results` holds projected rows — or group objects when `groupBy` is present. `projectedRow` requires no keys because --select decides which are present, so it validates loosely by design; the known field names are still type-checked.",
    type: "object",
    required: ["kind", "directory", "count", "results"],
    properties: {
      kind: {
        enum: [
          "links-to",
          "duplicates",
          "unused-assets",
          "code-blocks",
          "tasks",
          "missing-h1",
          "documents",
          "headings",
          "links",
          "frontmatter",
          "frontmatter-keys",
        ],
      },
      fields: {
        description: "Projected column order. Present only for a composable query.",
        ...stringArray,
      },
      groupBy: {
        type: "string",
        description: "The --group-by field. Present only when `results` holds group objects.",
      },
      directory: { type: "string" },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: {
          // anyOf, not oneOf: the result shapes overlap by design — a task
          // result carries `file` and so also satisfies the file shape.
          anyOf: [
            { $ref: "#/$defs/linkResult" },
            { $ref: "#/$defs/duplicateResult" },
            { $ref: "#/$defs/assetResult" },
            { $ref: "#/$defs/codeBlockResult" },
            { $ref: "#/$defs/taskResult" },
            { $ref: "#/$defs/fileResult" },
            { $ref: "#/$defs/frontmatterKeyResult" },
            { $ref: "#/$defs/projectedRow" },
            { $ref: "#/$defs/groupResult" },
          ],
        },
      },
      summary: {
        description:
          "Task totals for kind 'tasks' without composable options; { documents, withFrontmatter, keys } for 'frontmatter-keys'; { matched, groups } for a grouped composable query.",
        ...countMap,
      },
    },
    $defs: {
      projectedRow: {
        type: "object",
        description:
          "A composable-query row. --select decides which keys are present, so none is required; the types of the known field names are still enforced. Dotted keys such as 'frontmatter.owner' carry raw YAML and are unconstrained.",
        properties: {
          file: { type: "string" },
          line: { type: "integer", minimum: 0 },
          endLine: { type: "integer", minimum: 0 },
          lines: { type: "integer", minimum: 0 },
          depth: { type: "integer", minimum: 1, maximum: 6 },
          text: { type: "string" },
          slug: { type: "string" },
          title: { type: ["string", "null"] },
          checked: { type: "boolean" },
          status: { type: "string" },
          language: { type: ["string", "null"] },
          content: { type: "string" },
          linkText: { type: "string" },
          target: { type: "string" },
          isImage: { type: "boolean" },
          isExternal: { type: "boolean" },
          isAnchorOnly: { type: "boolean" },
          referenceType: { type: "string" },
          key: { type: "string" },
          type: { type: "string" },
          h1: { type: "boolean" },
          headings: { type: "integer", minimum: 0 },
          tasks: { type: "integer", minimum: 0 },
          links: { type: "integer", minimum: 0 },
          code: { type: "integer", minimum: 0 },
          words: { type: "integer", minimum: 0 },
          frontmatterStatus: { type: "string" },
        },
      },
      groupResult: {
        type: "object",
        required: ["key", "count", "rows"],
        properties: {
          key: {
            type: ["string", "null"],
            description: "Null groups rows whose key was absent. A list key fans out.",
          },
          count: { type: "integer", minimum: 0 },
          rows: { type: "array", items: { $ref: "#/$defs/projectedRow" } },
        },
      },
      linkResult: {
        type: "object",
        required: ["sourceFile", "line", "linkText", "rawTarget"],
        properties: {
          sourceFile: { type: "string" },
          line: { type: "integer", minimum: 0 },
          linkText: { type: "string" },
          rawTarget: { type: "string" },
        },
      },
      duplicateResult: {
        type: "object",
        required: ["value", "occurrences"],
        properties: {
          value: { type: "string" },
          occurrences: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "line"],
              properties: { file: { type: "string" }, line: { type: "integer", minimum: 0 } },
            },
          },
        },
      },
      assetResult: {
        type: "object",
        required: ["file", "extension"],
        properties: { file: { type: "string" }, extension: { type: "string" } },
      },
      codeBlockResult: {
        type: "object",
        required: ["language", "count", "occurrences"],
        properties: {
          language: { type: "string" },
          count: { type: "integer", minimum: 0 },
          occurrences: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "line", "endLine"],
              properties: {
                file: { type: "string" },
                line: { type: "integer", minimum: 0 },
                endLine: { type: "integer", minimum: 0 },
                content: { type: "string" },
              },
            },
          },
        },
      },
      taskResult: {
        type: "object",
        required: ["file", "line", "checked", "text"],
        properties: {
          file: { type: "string" },
          line: { type: "integer", minimum: 0 },
          checked: { type: "boolean" },
          text: { type: "string" },
        },
      },
      fileResult: {
        type: "object",
        required: ["file"],
        properties: { file: { type: "string" } },
      },
      frontmatterKeyResult: {
        type: "object",
        description:
          "One top-level frontmatter key, for kind 'frontmatter-keys'. Nested keys are not inventoried.",
        required: ["key", "documents", "coverage", "types"],
        properties: {
          key: { type: "string" },
          documents: { type: "integer", minimum: 1 },
          coverage: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "documents divided by the number of documents with valid frontmatter, rounded to four decimals.",
          },
          types: {
            description: "Distinct value types seen: null, array, or a typeof result.",
            ...stringArray,
          },
        },
      },
    },
  },
};

export const mdCheckUrlsSchema: SchemaEntry = {
  id: "md-check-urls",
  uri: schemaUri("v1", "md-check-urls"),
  title: "URL check report",
  commands: ["md check-urls"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-check-urls"),
    title: "URL check report",
    type: "object",
    required: ["files", "total", "ok", "broken", "results"],
    properties: {
      file: {
        type: "string",
        description: "Present only when exactly one input file was checked.",
      },
      files: { type: "integer", minimum: 0 },
      total: { type: "integer", minimum: 0 },
      ok: { type: "integer", minimum: 0 },
      broken: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["file", "line", "url", "status", "ok"],
          properties: {
            file: { type: "string" },
            line: { type: "integer", minimum: 0 },
            url: { type: "string" },
            status: {
              type: ["integer", "null"],
              description: "Null when the request failed before a response was received.",
            },
            ok: { type: "boolean" },
            error: { type: "string" },
            redirected: { type: "boolean" },
            finalUrl: { type: "string" },
          },
        },
      },
    },
  },
};

export const mdCheckSnippetsSchema: SchemaEntry = {
  id: "md-check-snippets",
  uri: schemaUri("v1", "md-check-snippets"),
  title: "Snippet check report",
  commands: ["md check-snippets"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-check-snippets"),
    title: "Snippet check report",
    description:
      "Emitted by `md check-snippets --format json`. Counts and findings describe only fences whose info string carries a cairn:snippet= attribute; every other fence is absent.",
    type: "object",
    required: [
      "mode",
      "filesScanned",
      "linked",
      "current",
      "drift",
      "unresolved",
      "malformed",
      "unwritable",
      "applied",
      "findings",
      "conflicts",
    ],
    properties: {
      mode: { type: "string", enum: ["check", "dry-run", "write"] },
      filesScanned: { type: "integer", minimum: 0 },
      linked: { type: "integer", minimum: 0 },
      current: { type: "integer", minimum: 0 },
      drift: { type: "integer", minimum: 0 },
      unresolved: { type: "integer", minimum: 0 },
      malformed: { type: "integer", minimum: 0 },
      unwritable: {
        type: "integer",
        minimum: 0,
        description: "Stale blocks whose fence cannot be rewritten. Always 0 under --check.",
      },
      applied: {
        type: "integer",
        minimum: 0,
        description: "Files whose bytes changed. Always 0 outside --write.",
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["file", "line", "endLine", "status"],
          properties: {
            file: { type: "string" },
            line: { type: "integer", minimum: 0 },
            endLine: { type: "integer", minimum: 0 },
            status: { type: "string", enum: ["current", "stale", "unresolved", "malformed"] },
            target: {
              type: "string",
              description: "The attribute value as written. Absent when it could not be parsed.",
            },
            source: { type: "string" },
            reason: { type: "string" },
            message: { type: "string" },
            documented: { type: "string", description: "--dry-run only." },
            expected: { type: "string", description: "--dry-run only." },
            writable: { type: "boolean", description: "Stale blocks outside --check." },
            applied: { type: "boolean", description: "--write only." },
          },
        },
      },
      conflicts: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "file", "message", "rules"],
          properties: {
            kind: { type: "string" },
            file: { type: "string" },
            message: { type: "string" },
            rules: stringArray,
          },
        },
      },
    },
  },
};

export const mdOrphansSchema: SchemaEntry = {
  id: "md-orphans",
  uri: schemaUri("v1", "md-orphans"),
  title: "Orphan report",
  commands: ["md orphans"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-orphans"),
    title: "Orphan report",
    type: "object",
    required: ["directory", "totalFiles", "orphans"],
    properties: {
      directory: { type: "string" },
      totalFiles: { type: "integer", minimum: 0 },
      orphans: stringArray,
    },
  },
};

export const mdIndexSchema: SchemaEntry = {
  id: "md-index",
  uri: schemaUri("v1", "md-index"),
  title: "Workspace index status",
  commands: ["md index"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-index"),
    title: "Workspace index status",
    description:
      "The 'clear' action reports only `cleared`; 'status' and 'build' report the index counters.",
    type: "object",
    required: ["action", "directory"],
    properties: {
      action: { enum: ["status", "build", "clear"] },
      directory: { type: "string" },
      cleared: { type: "boolean", description: "Present only for the 'clear' action." },
      cachePath: { type: "string" },
      exists: { type: "boolean" },
      version: { type: "integer" },
      indexed: { type: "integer", minimum: 0 },
      current: { type: "integer", minimum: 0 },
      stale: { type: "integer", minimum: 0 },
      missing: { type: "integer", minimum: 0 },
    },
  },
};

export const mdContextSchema: SchemaEntry = {
  id: "md-context",
  uri: schemaUri("v1", "md-context"),
  title: "Context pack",
  commands: ["md context"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-context"),
    title: "Context pack",
    description:
      "Units are ordered by graph distance, then the order a document entered the traversal, then document order. The pack is a prefix of that order: the first unit that would exceed the budget stops inclusion, and every later unit is reported under `omitted`.",
    type: "object",
    required: [
      "seeds",
      "depth",
      "backlinks",
      "files",
      "units",
      "omitted",
      "broken",
      "budget",
      "totals",
    ],
    properties: {
      seeds: stringArray,
      depth: { type: "integer", minimum: 0, description: "Graph hops followed from the seeds." },
      backlinks: { type: "boolean" },
      files: {
        description: "Documents contributing at least one included unit.",
        ...stringArray,
      },
      units: { type: "array", items: { $ref: "#/$defs/unit" } },
      omitted: { type: "array", items: { $ref: "#/$defs/omission" } },
      broken: { type: "array", items: { $ref: "#/$defs/brokenDependency" } },
      budget: { $ref: "#/$defs/budget" },
      totals: {
        type: "object",
        required: ["files", "units", "bytes"],
        properties: {
          files: { type: "integer", minimum: 0 },
          units: { type: "integer", minimum: 0 },
          bytes: { type: "integer", minimum: 0 },
        },
      },
    },
    $defs: {
      provenance: {
        type: "object",
        required: ["distance", "direction", "reason"],
        properties: {
          distance: { type: "integer", minimum: 0, description: "Hops from the nearest seed." },
          via: { type: "string", description: "Document that pulled this one in." },
          viaLine: {
            type: "integer",
            minimum: 0,
            description:
              "Line carrying the link: in `via` when direction is 'link', in this document when it is 'backlink'.",
          },
          direction: { enum: ["seed", "link", "backlink"] },
          reason: { type: "string" },
        },
      },
      unit: {
        type: "object",
        required: [
          "id",
          "kind",
          "file",
          "heading",
          "slug",
          "depth",
          "startLine",
          "endLine",
          "bytes",
          "provenance",
          "content",
        ],
        properties: {
          id: { type: "string", description: "`<file>#<slug>`, `#frontmatter`, or `#preamble`." },
          kind: { enum: ["frontmatter", "preamble", "section"] },
          file: { type: "string" },
          heading: { type: ["string", "null"] },
          slug: { type: ["string", "null"] },
          depth: { type: "integer", minimum: 0, maximum: 6 },
          startLine: { type: "integer", minimum: 0 },
          endLine: { type: "integer", minimum: 0 },
          bytes: { type: "integer", minimum: 0, description: "UTF-8 bytes of `content`." },
          provenance: { $ref: "#/$defs/provenance" },
          content: { type: "string" },
        },
      },
      omission: {
        type: "object",
        required: ["id", "file", "heading", "bytes", "reason"],
        properties: {
          id: { type: "string" },
          file: { type: "string" },
          heading: { type: ["string", "null"] },
          bytes: { type: "integer", minimum: 0 },
          reason: { enum: ["budget"] },
        },
      },
      brokenDependency: {
        type: "object",
        required: ["source", "target", "resolved", "line"],
        properties: {
          source: { type: "string" },
          target: { type: "string", description: "The link target as written." },
          resolved: { type: "string" },
          line: { type: "integer", minimum: 0 },
        },
      },
      budget: {
        type: "object",
        required: ["limitBytes", "usedBytes", "omittedBytes", "tokenEstimate", "truncated"],
        properties: {
          limitBytes: { type: ["integer", "null"], minimum: 0 },
          usedBytes: { type: "integer", minimum: 0 },
          omittedBytes: { type: "integer", minimum: 0 },
          tokenEstimate: {
            type: "integer",
            minimum: 0,
            description:
              "ceil(usedBytes / 4). A size signal, not a model tokenizer; it never affects which units are included.",
          },
          truncated: { type: "boolean" },
        },
      },
    },
  },
};

export const mdDiffSchema: SchemaEntry = {
  id: "md-diff",
  uri: schemaUri("v1", "md-diff"),
  title: "Markdown structural diff",
  commands: ["md diff"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-diff"),
    title: "Markdown structural diff",
    description:
      "An AST-aware change summary, not a textual diff. Heading pairs reported with `heuristic: true` were matched by position rather than by identity and should be treated as a guess. Each change list is ordered by new line, then old line, then kind.",
    type: "object",
    required: ["mode", "files", "totals"],
    properties: {
      mode: { enum: ["files", "revision"] },
      base: { type: "string", description: "Revision mode: the revision as written." },
      baseCommit: { type: "string", description: "Revision mode: the resolved commit." },
      from: { type: "string", description: "Files mode: the first path." },
      to: { type: "string", description: "Files mode: the second path." },
      files: { type: "array", items: { $ref: "#/$defs/fileDiff" } },
      totals: {
        type: "object",
        required: [
          "files",
          "filesChanged",
          "headings",
          "frontmatter",
          "links",
          "tasks",
          "codeBlocks",
          "tables",
          "heuristicRenames",
          "diagrams",
        ],
        properties: {
          files: { type: "integer", minimum: 0 },
          filesChanged: { type: "integer", minimum: 0 },
          headings: { type: "integer", minimum: 0 },
          frontmatter: { type: "integer", minimum: 0 },
          links: { type: "integer", minimum: 0 },
          tasks: { type: "integer", minimum: 0 },
          codeBlocks: { type: "integer", minimum: 0 },
          tables: { type: "integer", minimum: 0 },
          heuristicRenames: {
            type: "integer",
            minimum: 0,
            description: "Heading pairs the positional matcher called renames.",
          },
          diagrams: {
            type: "integer",
            minimum: 0,
            description: "Code-block changes whose language is Mermaid.",
          },
        },
      },
    },
    $defs: {
      kind: { enum: ["added", "removed", "changed", "moved", "renamed"] },
      headingChange: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { $ref: "#/$defs/kind" },
          oldText: { type: "string" },
          oldSlug: { type: "string" },
          oldLine: { type: "integer", minimum: 0 },
          oldDepth: { type: "integer", minimum: 1, maximum: 6 },
          newText: { type: "string" },
          newSlug: { type: "string" },
          newLine: { type: "integer", minimum: 0 },
          newDepth: { type: "integer", minimum: 1, maximum: 6 },
          bodyChanged: { type: "boolean" },
          heuristic: {
            type: "boolean",
            description: "The rename was matched by position, not by identity.",
          },
          matchedBy: { enum: ["slug", "text", "position"] },
        },
      },
      frontmatterChange: {
        type: "object",
        required: ["kind", "key"],
        properties: {
          kind: { $ref: "#/$defs/kind" },
          key: {
            type: ["string", "null"],
            description: "Dotted path, or null for a whole-block status transition.",
          },
          oldValue: { description: "Raw YAML value; any JSON type." },
          newValue: { description: "Raw YAML value; any JSON type." },
          oldStatus: { enum: ["missing", "malformed", "non-mapping", "valid"] },
          newStatus: { enum: ["missing", "malformed", "non-mapping", "valid"] },
        },
      },
      linkChange: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { $ref: "#/$defs/kind" },
          oldTarget: { type: "string" },
          newTarget: { type: "string" },
          oldResolved: {
            type: ["string", "null"],
            description: "Null for external and anchor-only references.",
          },
          newResolved: { type: ["string", "null"] },
          oldLine: { type: "integer", minimum: 0 },
          newLine: { type: "integer", minimum: 0 },
          linkText: { type: "string" },
          fragmentChanged: { type: "boolean", description: "Only the anchor differs." },
        },
      },
      taskChange: {
        type: "object",
        required: ["kind", "text"],
        properties: {
          kind: { $ref: "#/$defs/kind" },
          text: { type: "string" },
          oldLine: { type: "integer", minimum: 0 },
          newLine: { type: "integer", minimum: 0 },
          oldChecked: { type: "boolean" },
          newChecked: { type: "boolean" },
        },
      },
      codeBlockChange: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { $ref: "#/$defs/kind" },
          oldLang: { type: ["string", "null"] },
          newLang: { type: ["string", "null"] },
          oldLine: { type: "integer", minimum: 0 },
          newLine: { type: "integer", minimum: 0 },
          langChanged: { type: "boolean" },
          contentChanged: { type: "boolean" },
          mermaid: { type: "boolean", description: "The block is a Mermaid diagram." },
        },
      },
      tableChange: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { $ref: "#/$defs/kind" },
          oldLine: { type: "integer", minimum: 0 },
          newLine: { type: "integer", minimum: 0 },
          oldColumns: { type: "integer", minimum: 0 },
          newColumns: { type: "integer", minimum: 0 },
          oldRows: { type: "integer", minimum: 0 },
          newRows: { type: "integer", minimum: 0 },
          headersChanged: { type: "boolean" },
        },
      },
      fileDiff: {
        type: "object",
        required: [
          "file",
          "status",
          "headings",
          "frontmatter",
          "links",
          "tasks",
          "codeBlocks",
          "tables",
          "totals",
        ],
        properties: {
          file: { type: "string" },
          oldPath: { type: "string", description: "Path at the base revision, when it differed." },
          status: { enum: ["added", "removed", "modified", "renamed", "unchanged"] },
          similarity: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "Git similarity index for a rename.",
          },
          headings: { type: "array", items: { $ref: "#/$defs/headingChange" } },
          frontmatter: { type: "array", items: { $ref: "#/$defs/frontmatterChange" } },
          links: { type: "array", items: { $ref: "#/$defs/linkChange" } },
          tasks: { type: "array", items: { $ref: "#/$defs/taskChange" } },
          codeBlocks: { type: "array", items: { $ref: "#/$defs/codeBlockChange" } },
          tables: { type: "array", items: { $ref: "#/$defs/tableChange" } },
          totals: {
            type: "object",
            required: [
              "headings",
              "frontmatter",
              "links",
              "tasks",
              "codeBlocks",
              "tables",
              "changes",
            ],
            properties: {
              headings: { type: "integer", minimum: 0 },
              frontmatter: { type: "integer", minimum: 0 },
              links: { type: "integer", minimum: 0 },
              tasks: { type: "integer", minimum: 0 },
              codeBlocks: { type: "integer", minimum: 0 },
              tables: { type: "integer", minimum: 0 },
              changes: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
  },
};

export const mdFixSchema: SchemaEntry = {
  id: "md-fix",
  uri: schemaUri("v1", "md-fix"),
  title: "Markdown fix plan",
  commands: ["md fix"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "md-fix"),
    title: "Markdown fix plan",
    description:
      "Offsets are UTF-16 code-unit indices into the utf-8-decoded file, not byte offsets. `expected` is the authoritative anchor: a consumer applying an edit itself should verify it first rather than trust the unit. A non-empty `conflicts` means nothing will be written in any mode.",
    type: "object",
    required: [
      "mode",
      "rules",
      "filesScanned",
      "filesWithEdits",
      "edits",
      "applied",
      "files",
      "conflicts",
      "unfixable",
    ],
    properties: {
      mode: { enum: ["check", "dry-run", "write"] },
      rules: { description: "The fixers that ran.", ...stringArray },
      filesScanned: { type: "integer", minimum: 0 },
      filesWithEdits: { type: "integer", minimum: 0 },
      edits: { type: "integer", minimum: 0 },
      applied: {
        type: "integer",
        minimum: 0,
        description: "Files whose bytes changed. Always 0 outside --write.",
      },
      files: { type: "array", items: { $ref: "#/$defs/filePlan" } },
      conflicts: { type: "array", items: { $ref: "#/$defs/conflict" } },
      unfixable: { type: "array", items: { $ref: "#/$defs/unfixable" } },
    },
    $defs: {
      diagnostic: {
        type: "object",
        required: ["rule", "line", "message"],
        properties: {
          rule: { type: "string", description: "Fixer identity, e.g. 'toc'." },
          line: { type: "integer", minimum: 0 },
          message: { type: "string" },
        },
      },
      edit: {
        type: "object",
        required: ["start", "end", "line", "expected", "replacement", "diagnostic"],
        properties: {
          start: { type: "integer", minimum: 0 },
          end: { type: "integer", minimum: 0, description: "Exclusive." },
          line: { type: "integer", minimum: 0 },
          expected: { type: "string", description: "Text currently at [start, end)." },
          replacement: { type: "string" },
          diagnostic: { $ref: "#/$defs/diagnostic" },
        },
      },
      filePlan: {
        type: "object",
        required: ["file", "edits"],
        properties: {
          file: { type: "string" },
          edits: { type: "array", items: { $ref: "#/$defs/edit" } },
          applied: { type: "boolean", description: "Present only in --write mode." },
        },
      },
      conflict: {
        type: "object",
        required: ["kind", "file", "message", "rules"],
        properties: {
          kind: {
            enum: ["overlap", "outside-workspace", "stale-input", "expectation-mismatch"],
          },
          file: { type: "string" },
          message: { type: "string" },
          rules: { description: "Two entries for an overlap, one otherwise.", ...stringArray },
        },
      },
      unfixable: {
        type: "object",
        required: ["file", "line", "rule", "message", "reason"],
        properties: {
          file: { type: "string" },
          line: { type: "integer", minimum: 0 },
          rule: { type: "string" },
          message: { type: "string" },
          reason: { type: "string", description: "Why no edit was produced." },
        },
      },
    },
  },
};
