import path from "node:path";
import fs from "node:fs";
import { minimatch } from "minimatch";
import { lintFile } from "../lint.js";
import { buildWorkspaceGraph, type WorkspaceGraph } from "../graph.js";
import { FrontmatterValidator } from "../frontmatter-validation.js";
import { tocSynchronizationIssue, type TocOptions } from "./toc.js";
import { checkUrlOccurrences } from "./check-urls.js";
import { outputPath, runtime } from "../runtime.js";
import { requireDirectory } from "../input.js";
import { terminate } from "../command-result.js";
import type { Issue } from "../types.js";
import { formatDiagnostics } from "../automation.js";
import { changedMarkdownFiles } from "../input-selection.js";
import { extractCodeBlocks } from "../markdown-ast.js";
import { createSourceReader, synchronizeSnippets } from "../snippets.js";
import { jsonPayload } from "../result.js";
import { packageName, packageVersion } from "../version.js";
import {
  applyBaseline,
  buildBaseline,
  readBaseline,
  writeBaseline,
  type BaselineEntry,
} from "../audit-baseline.js";

interface AuditOptions extends TocOptions {
  envelope?: boolean;
  summary: boolean;
  external: boolean;
  frontmatter: boolean;
  graph: boolean;
  toc: boolean;
  snippets: boolean;
  style: boolean;
  mermaid: boolean;
  katex: boolean;
  references: boolean;
  concurrency: string;
  include: string[];
  exclude: string[];
  entry: string[];
  timeout: string;
  retry: string;
  changedSince?: string;
  baseline?: string;
  writeBaseline?: string;
}

/** The suppression report, present only when --baseline was given. */
interface BaselineReport {
  path: string;
  suppressed: number;
  stale: BaselineEntry[];
}

interface AuditResult {
  directory: string;
  enabled: string[];
  skipped: string[];
  totals: {
    files: number;
    findings: number;
    filesWithFindings: number;
    byCheck: Record<string, number>;
    byFile: Record<string, number>;
  };
  findings: Issue[];
  baseline?: BaselineReport;
  graph?: {
    nodes: number;
    edges: number;
    broken: number;
    unreachable: number;
    deadEnds: number;
    components: number;
    cycles: number;
    reachabilityEvaluated: boolean;
  };
}

async function concurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

function graphFindings(graph: WorkspaceGraph): Issue[] {
  return [
    ...graph.broken.map((edge) => ({
      file: edge.source,
      line: edge.line,
      checker: "graph/broken",
      message: `Markdown target not found: ${edge.target}`,
    })),
    ...graph.unreachable.map((file) => ({
      file,
      line: 1,
      checker: "graph/unreachable",
      message: "Document is unreachable from configured entry points",
    })),
  ];
}

/**
 * Snippet drift, reported but never repaired.
 *
 * The checker names are prefixed `snippets/` so the audit category derived
 * from the checker matches the `enabled` entry. Messages carry the target as
 * the author wrote it and no line number, because `--baseline` keys on
 * checker, workspace-relative path, and message.
 */
function snippetFindings(files: readonly string[]): Issue[] {
  const root = runtime().config.root;
  const read = createSourceReader(root);
  const issues: Issue[] = [];
  for (const file of files) {
    const document = runtime().workspace.document(file);
    const results = synchronizeSnippets(document.content, extractCodeBlocks(document.tree), {
      file,
      root,
      read,
    });
    for (const result of results) {
      if (result.status === "current") continue;
      if (result.status === "stale") {
        issues.push({
          file,
          line: result.line,
          checker: "snippets/drift",
          message: `Snippet is out of date with ${result.target}`,
        });
        continue;
      }
      const kind = result.reason.startsWith("source-")
        ? "source"
        : result.reason.startsWith("region-")
          ? "region"
          : "meta";
      issues.push({
        file,
        line: result.line,
        checker: `snippets/${kind}`,
        message: result.message,
      });
    }
  }
  return issues;
}

export async function auditAction(directory: string, opts: AuditOptions): Promise<void> {
  const dir = requireDirectory(directory, opts);
  let files = runtime().workspace.markdownFiles(dir, {
    include: opts.include,
    exclude: opts.exclude,
  });
  if (opts.changedSince) {
    const changed = new Set(changedMarkdownFiles(opts.changedSince));
    files = files.filter((file) => changed.has(file));
  }
  const enabled: string[] = [];
  const skipped: string[] = [];
  let findings: Issue[] = [];
  const lintNames = [
    ["markdownlint", opts.style],
    ["mermaid", opts.mermaid],
    ["katex", opts.katex],
    ["references", opts.references],
  ] as const;
  for (const [name, active] of lintNames) (active ? enabled : skipped).push(name);
  const lintResults = await concurrent(files, parseInt(opts.concurrency, 10) || 1, (file) =>
    lintFile(file, {
      style: opts.style,
      mermaid: opts.mermaid,
      katex: opts.katex,
      references: opts.references,
    }),
  );
  findings.push(...lintResults.flat());

  let graph: WorkspaceGraph | undefined;
  if (opts.graph) {
    enabled.push("graph");
    const entries = opts.entry.map((entry) => path.resolve(entry));
    for (const entry of entries) {
      if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
        throw new Error(`Entry point not found: ${entry}`);
      }
    }
    graph = buildWorkspaceGraph(runtime().workspace, files, entries);
    const graphIssues = graphFindings(graph);
    const duplicate = new Set(
      graph.broken.map((edge) => `${edge.source}\0${edge.line}\0${edge.target}`),
    );
    findings = findings.filter((issue) => {
      const target = issue.message.replace(/^Link target not found: /, "");
      return !(
        issue.checker === "ref/link" && duplicate.has(`${issue.file}\0${issue.line}\0${target}`)
      );
    });
    findings.push(...graphIssues);
  } else skipped.push("graph");

  const hasFrontmatter =
    Boolean(runtime().config.frontmatter.schema) ||
    Object.values(runtime().config.frontmatter.rules).some((value) =>
      Array.isArray(value) ? value.length : Object.keys(value).length,
    );
  if (opts.frontmatter && hasFrontmatter) {
    enabled.push("frontmatter");
    findings.push(
      ...new FrontmatterValidator(
        runtime().config.frontmatter.rules,
        runtime().config.frontmatter.schema,
      ).validateMany(files.map((file) => runtime().workspace.document(file))),
    );
  } else skipped.push("frontmatter");

  if (opts.toc && runtime().config.toc.files.length) {
    enabled.push("toc");
    for (const file of files) {
      const relative = path.relative(runtime().config.root, file).split(path.sep).join("/");
      if (
        !runtime().config.toc.files.some((pattern) =>
          minimatch(relative, pattern, { dot: true, nonegate: true }),
        )
      )
        continue;
      const result = tocSynchronizationIssue(file, opts);
      if (result.malformed) throw new Error(`${file}: ${result.malformed}`);
      if (!result.current) findings.push({ file, line: 1, checker: "toc", message: result.issue! });
    }
  } else skipped.push("toc");

  if (opts.snippets) {
    enabled.push("snippets");
    findings.push(...snippetFindings(files));
  } else skipped.push("snippets");

  if (opts.external) {
    enabled.push("external");
    const occurrences = files.flatMap((file) =>
      runtime()
        .workspace.document(file)
        .references.filter(
          (ref) =>
            ref.isExternal &&
            /^https?:/i.test(ref.target) &&
            !runtime().config.urls.ignore.some((pattern) =>
              minimatch(ref.target, pattern, { nonegate: true }),
            ) &&
            !runtime().config.urls.ignoreDomains.some((domain) => {
              try {
                const host = new URL(ref.target).hostname.toLowerCase();
                const normalized = domain.toLowerCase().replace(/^\*\./, "");
                return host === normalized || host.endsWith(`.${normalized}`);
              } catch {
                return false;
              }
            }),
        )
        .map((ref) => ({ file, line: ref.line, url: ref.target })),
    );
    const results = await checkUrlOccurrences(occurrences, {
      timeout: parseInt(opts.timeout, 10) || 5000,
      concurrency: parseInt(opts.concurrency, 10) || 5,
      retries: parseInt(opts.retry, 10) || 0,
      allowedStatuses: runtime().config.urls.allowedStatuses,
      headFallbackStatuses: runtime().config.urls.headFallbackStatuses,
      cache: runtime().config.urls.cache,
      cacheTtl: runtime().config.urls.cacheTtl,
    });
    findings.push(
      ...results
        .filter((result) => !result.ok)
        .map((result) => ({
          file: result.file,
          line: result.line,
          checker: "external",
          message: `${result.url}: ${result.status ?? result.error ?? "request failed"}`,
        })),
    );
  } else skipped.push("external");

  findings.sort(
    (a, b) => a.checker.localeCompare(b.checker) || a.file.localeCompare(b.file) || a.line - b.line,
  );

  const root = runtime().config.root;
  if (opts.writeBaseline) {
    // Recording is a separate act from checking: writing the file a run is
    // simultaneously being judged against has no meaning.
    if (opts.baseline) throw new Error("--baseline and --write-baseline cannot be combined");
    writeBaseline(
      opts.writeBaseline,
      buildBaseline(findings, root, { name: packageName, version: packageVersion }),
    );
    process.stdout.write(
      `Wrote ${findings.length} baseline entr${findings.length === 1 ? "y" : "ies"} to ${opts.writeBaseline}\n`,
    );
    return;
  }

  let baseline: BaselineReport | undefined;
  if (opts.baseline) {
    const applied = applyBaseline(findings, readBaseline(opts.baseline), root);
    if (applied.foreign) {
      findings.push({
        file: path.resolve(opts.baseline),
        line: 1,
        checker: "baseline",
        message: "Not a cairn-md-audit-baseline document; no findings were suppressed",
      });
      findings.sort(
        (a, b) =>
          a.checker.localeCompare(b.checker) || a.file.localeCompare(b.file) || a.line - b.line,
      );
    } else {
      findings = applied.kept;
    }
    baseline = {
      path: outputPath(path.resolve(opts.baseline), opts),
      suppressed: applied.suppressed,
      stale: applied.stale,
    };
  }

  const shown = findings.map((issue) => ({ ...issue, file: outputPath(issue.file, opts) }));
  const byCheck: Record<string, number> = Object.fromEntries(enabled.map((check) => [check, 0]));
  const byFile: Record<string, number> = {};
  for (const issue of shown) {
    const rawCategory = issue.checker.split("/")[0];
    const category = rawCategory === "ref" ? "references" : rawCategory;
    byCheck[category] = (byCheck[category] ?? 0) + 1;
    byFile[issue.file] = (byFile[issue.file] ?? 0) + 1;
  }
  const result: AuditResult = {
    directory: outputPath(dir, opts),
    enabled,
    skipped,
    totals: {
      files: files.length,
      findings: shown.length,
      filesWithFindings: Object.keys(byFile).length,
      byCheck,
      byFile,
    },
    findings: shown,
    ...(baseline ? { baseline } : {}),
    ...(graph
      ? {
          graph: {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            broken: graph.broken.length,
            unreachable: graph.unreachable.length,
            deadEnds: graph.nodes.filter((node) => node.deadEnd).length,
            components: graph.components.length,
            cycles: graph.cycles.length,
            reachabilityEvaluated: graph.reachabilityEvaluated,
          },
        }
      : {}),
  };
  // One value decides the payload counts, the stream, and the exit code.
  // Reading `findings` for the stream while the payload counted `shown` was a
  // latent split that baseline suppression would have turned into a real bug.
  const actionable = shown.length;
  // Suppression and staleness are described, never judged: a stale entry means
  // something was fixed, which must not fail a build.
  const baselineLines = baseline
    ? [
        `Baseline: ${baseline.suppressed} suppressed, ${baseline.stale.length} stale (${baseline.path})`,
      ]
    : [];
  let payload: string;
  if (opts.format === "json")
    payload = jsonPayload("md audit", result, opts, {
      exitCode: actionable ? 2 : 0,
      summary: {
        findings: actionable,
        files: result.totals.files,
        ...(baseline ? { suppressed: baseline.suppressed } : {}),
      },
    }).trimEnd();
  else if (opts.format === "jsonl" || opts.format === "sarif")
    payload = formatDiagnostics(shown, opts.format, {
      files: files.length,
      findings: actionable,
      enabled,
      skipped,
      ...(baseline ? { suppressed: baseline.suppressed } : {}),
    })!;
  else if (opts.summary)
    payload = [
      `Audit: ${result.totals.files} file(s), ${result.totals.findings} finding(s)`,
      ...baselineLines,
      ...Object.entries(byCheck).map(([check, count]) => `  ${check}: ${count}`),
      ...Object.entries(byFile).map(([file, count]) => `  ${file}: ${count}`),
    ].join("\n");
  else
    payload = (
      actionable
        ? [
            `${actionable} audit finding(s) in ${result.directory}:`,
            ...shown.map(
              (issue) => `  ${issue.file}:${issue.line} [${issue.checker}] ${issue.message}`,
            ),
            ...baselineLines,
          ]
        : [`Audit passed for ${files.length} file(s) in ${result.directory}`, ...baselineLines]
    ).join("\n");
  (actionable ? process.stderr : process.stdout).write(payload + "\n");
  if (actionable) terminate(2);
}
