import path from "node:path";
import { extractCodeBlocks, extractTasks } from "../markdown-ast.js";
import { resolveLocalPath, splitLocalTarget } from "../link-target.js";
import { requireDirectory } from "../input.js";
import { outputPath, runtime } from "../runtime.js";
import { jsonPayload } from "../result.js";
import { nestedValue } from "../object-path.js";
import { frontmatterValueType, type EntityKind } from "../query/entities.js";
import { QueryUsageError, buildPlan, type QueryPlan } from "../query/plan.js";
import { executePlan, type QueryResult } from "../query/execute.js";
import { renderQueryText } from "../query/render.js";
import { explicitOptionKeys } from "../runtime.js";

/** The shortcut kinds, whose payloads are frozen. */
type LegacyKind =
  | "links-to"
  | "duplicates"
  | "unused-assets"
  | "code-blocks"
  | "tasks"
  | "missing-h1"
  | "frontmatter-keys";

type QueryKind = LegacyKind | EntityKind;

interface QueryOptions {
  envelope?: boolean;
  format: string;
  include: string[];
  exclude: string[];
  target?: string;
  field: string;
  lang?: string;
  content: boolean;
  status: string;
  summary: boolean;
  assetExtension: string[];
  where: string[];
  select: string[];
  groupBy?: string;
}

interface QueryEnvelope {
  kind: QueryKind;
  directory: string;
  count: number;
  results: unknown[];
  summary?: Record<string, number>;
  /** Composable mode only: the projection, in column order. */
  fields?: string[];
  /** Composable mode only, when grouping. */
  groupBy?: string;
}

function primitive(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function duplicateResults(files: string[], field: string, opts: QueryOptions): unknown[] {
  if (!["title", "slug", "heading-slug"].includes(field) && !field.startsWith("frontmatter:")) {
    throw new Error("--field must be title, slug, heading-slug, or frontmatter:<key>");
  }
  const groups = new Map<string, { value: string; occurrences: object[] }>();
  const add = (value: string, file: string, line: number): void => {
    const key = value.toLocaleLowerCase();
    const group = groups.get(key) ?? { value, occurrences: [] };
    group.occurrences.push({ file: outputPath(file, opts), line });
    groups.set(key, group);
  };
  for (const file of files) {
    const document = runtime().workspace.document(file);
    if (field === "heading-slug") {
      for (const heading of document.headings) add(heading.slug, file, heading.line);
      continue;
    }
    const data = document.frontmatter.status === "valid" ? document.frontmatter.data : {};
    if (field === "title") {
      const frontmatterTitle = primitive(data.title);
      const heading = document.headings.find((item) => item.depth === 1);
      if (frontmatterTitle !== undefined) add(frontmatterTitle, file, 1);
      else if (heading) add(heading.text, file, heading.line);
      continue;
    }
    const key = field === "slug" ? "slug" : field.slice("frontmatter:".length);
    if (!key) throw new Error("frontmatter duplicate fields require a key");
    // `arrays: false` preserves this command's long-standing refusal to index
    // into a frontmatter list; `md frontmatter --key` allows it.
    const value = primitive(nestedValue(data, key, { arrays: false }));
    if (value !== undefined) add(value, file, 1);
  }
  return [...groups.values()]
    .filter((group) => group.occurrences.length > 1)
    .sort((a, b) => a.value.localeCompare(b.value));
}

function linksToResults(files: string[], target: string, opts: QueryOptions): unknown[] {
  const parsedTarget = splitLocalTarget(target);
  const targetFile = path.resolve(parsedTarget.path);
  const targetFragment = parsedTarget.fragment;
  const results: object[] = [];
  for (const file of files) {
    for (const reference of runtime().workspace.document(file).references) {
      if (reference.isExternal || reference.isAnchorOnly) continue;
      const parsed = splitLocalTarget(reference.target);
      const resolved = resolveLocalPath(file, parsed.path, runtime().workspace.root);
      if (resolved !== targetFile) continue;
      const fragment = parsed.fragment;
      if (targetFragment !== undefined && fragment !== targetFragment) continue;
      results.push({
        sourceFile: outputPath(file, opts),
        line: reference.line,
        linkText: reference.linkText,
        rawTarget: reference.target,
      });
    }
  }
  return results;
}

function unusedAssetResults(files: string[], directory: string, opts: QueryOptions): unknown[] {
  const referenced = new Set<string>();
  for (const file of files) {
    for (const reference of runtime().workspace.document(file).references) {
      if (reference.isExternal || reference.isAnchorOnly) continue;
      const target = splitLocalTarget(reference.target).path;
      referenced.add(resolveLocalPath(file, target, runtime().workspace.root));
    }
  }
  const extensions = opts.assetExtension.length
    ? opts.assetExtension
    : runtime().config.assets.extensions;
  return runtime()
    .workspace.assetFiles(directory, extensions, opts.exclude)
    .filter((file) => !referenced.has(file))
    .map((file) => ({ file: outputPath(file, opts), extension: path.extname(file).toLowerCase() }));
}

function codeBlockResults(files: string[], opts: QueryOptions): unknown[] {
  const groups = new Map<string, object[]>();
  for (const file of files) {
    for (const block of extractCodeBlocks(runtime().workspace.document(file).tree)) {
      const language = block.lang ?? "(none)";
      if (opts.lang && language !== opts.lang) continue;
      const occurrence = {
        file: outputPath(file, opts),
        line: block.line,
        endLine: block.endLine,
        ...(opts.content ? { content: block.value } : {}),
      };
      groups.set(language, [...(groups.get(language) ?? []), occurrence]);
    }
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([language, occurrences]) => ({ language, count: occurrences.length, occurrences }));
}

function taskResults(
  files: string[],
  opts: QueryOptions,
): { results: unknown[]; summary: Record<string, number>; count: number } {
  if (!["all", "done", "pending"].includes(opts.status)) {
    throw new Error("--status must be all, done, or pending");
  }
  const results: object[] = [];
  let done = 0;
  let pending = 0;
  let matched = 0;
  for (const file of files) {
    for (const task of extractTasks(runtime().workspace.document(file).tree)) {
      if (task.checked) done++;
      else pending++;
      if (opts.status === "done" && !task.checked) continue;
      if (opts.status === "pending" && task.checked) continue;
      matched++;
      if (!opts.summary) {
        results.push({
          file: outputPath(file, opts),
          line: task.line,
          checked: task.checked,
          text: task.text,
        });
      }
    }
  }
  return { results, summary: { total: done + pending, done, pending, matched }, count: matched };
}

/**
 * Inventories top-level frontmatter key adoption across the workspace.
 *
 * An aggregate rather than a composable entity: the `frontmatter` entity emits
 * one row per key *per document*, while this emits one row per key with a
 * count, which the projection model has no way to express.
 */
function frontmatterKeyResults(files: string[]): {
  results: unknown[];
  summary: Record<string, number>;
  count: number;
} {
  let withFrontmatter = 0;
  const keys = new Map<string, { documents: number; types: Set<string> }>();
  for (const file of files) {
    const { frontmatter } = runtime().workspace.document(file);
    if (frontmatter.status !== "valid") continue;
    withFrontmatter++;
    for (const [key, value] of Object.entries(frontmatter.data)) {
      const seen = keys.get(key) ?? { documents: 0, types: new Set<string>() };
      seen.documents++;
      seen.types.add(frontmatterValueType(value));
      keys.set(key, seen);
    }
  }
  // Byte comparison, not localeCompare: the ordering must not depend on the
  // ICU build of whichever machine ran the query.
  const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const results = [...keys]
    .sort(([a], [b]) => byBytes(a, b))
    .map(([key, seen]) => ({
      key,
      documents: seen.documents,
      // Share of documents that *have* frontmatter, so adding an unrelated
      // frontmatter-less file does not depress every key's coverage.
      coverage: withFrontmatter
        ? Math.round((seen.documents / withFrontmatter) * 10000) / 10000
        : 0,
      types: [...seen.types].sort(byBytes),
    }));
  return {
    results,
    summary: { documents: files.length, withFrontmatter, keys: results.length },
    count: results.length,
  };
}

function textOutput(envelope: QueryEnvelope, human: boolean): string {
  const heading = `${envelope.kind}: ${envelope.count} result(s) in ${envelope.directory}`;
  const lines = [human ? `\x1b[1m${heading}\x1b[0m` : heading];
  if (envelope.summary) {
    const summary = envelope.summary;
    lines.push(
      // `tasks` keeps its historical wording; anything else renders generically.
      envelope.kind === "tasks"
        ? `  total=${summary.total} done=${summary.done} pending=${summary.pending}`
        : `  ${Object.entries(summary)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}`,
    );
  }
  for (const result of envelope.results) lines.push(`  ${JSON.stringify(result)}`);
  return lines.join("\n");
}

const LEGACY_KINDS: LegacyKind[] = [
  "links-to",
  "duplicates",
  "unused-assets",
  "code-blocks",
  "tasks",
  "missing-h1",
  "frontmatter-keys",
];

/** Options that belong to a shortcut kind and have no composable meaning. */
const LEGACY_OPTIONS = [
  "target",
  "field",
  "lang",
  "content",
  "status",
  "summary",
  "assetExtension",
];

/**
 * Runs a composable query.
 *
 * Reached only when `--where`, `--select`, or `--group-by` was typed, so every
 * shortcut kind keeps its historical payload byte for byte.
 */
function composableQuery(
  kindValue: string,
  directory: string,
  opts: QueryOptions,
): { envelope: QueryEnvelope; plan: QueryPlan; result: QueryResult } {
  // Detected from argv rather than by comparing against defaults, so a
  // `.cairn.yml` setting `commands.query.status` does not look like a
  // conflicting flag on every composable tasks query.
  const typed = explicitOptionKeys(opts as unknown as Record<string, unknown>);
  const conflicting = LEGACY_OPTIONS.filter((name) => typed.has(name));
  if (conflicting.length) {
    throw new QueryUsageError(
      `--${conflicting[0]} belongs to a shortcut kind and cannot be combined with --where, --select, or --group-by`,
    );
  }
  const dir = requireDirectory(directory, opts);
  const files = runtime().workspace.markdownFiles(dir, {
    include: opts.include,
    exclude: opts.exclude,
  });
  const plan = buildPlan({
    kind: kindValue,
    where: opts.where,
    select: opts.select,
    ...(opts.groupBy === undefined ? {} : { groupBy: opts.groupBy }),
  });
  const result = executePlan(plan, {
    workspace: runtime().workspace,
    files,
    displayPath: (file) => outputPath(file, opts),
  });

  return {
    plan,
    result,
    envelope: {
      kind: plan.entity,
      directory: outputPath(dir, opts),
      count: result.groups ? result.groups.length : result.rows.length,
      results: result.groups ?? result.rows,
      fields: result.fields,
      ...(plan.groupBy ? { groupBy: plan.groupBy } : {}),
      ...(result.groups
        ? { summary: { matched: result.matched, groups: result.groups.length } }
        : {}),
    },
  };
}

export async function queryAction(
  kindValue: string,
  directory: string,
  opts: QueryOptions,
): Promise<void> {
  const composable = opts.where.length > 0 || opts.select.length > 0 || Boolean(opts.groupBy);
  if (composable) {
    const { envelope, plan, result } = composableQuery(kindValue, directory, opts);
    process.stdout.write(
      opts.format === "json"
        ? jsonPayload("md query", envelope, opts)
        : renderQueryText(result, plan, envelope.directory, opts.format === "human") + "\n",
    );
    return;
  }

  if (!LEGACY_KINDS.includes(kindValue as LegacyKind)) {
    throw new Error(`Unknown query kind: ${kindValue}`);
  }
  const kind = kindValue as LegacyKind;
  const dir = requireDirectory(directory, opts);
  const files = runtime().workspace.markdownFiles(dir, {
    include: opts.include,
    exclude: opts.exclude,
  });
  let results: unknown[];
  let summary: Record<string, number> | undefined;
  let resultCount: number | undefined;
  if (kind === "links-to") {
    if (!opts.target) throw new Error("links-to requires --target <path[#heading]>");
    results = linksToResults(files, opts.target, opts);
  } else if (kind === "duplicates") {
    results = duplicateResults(files, opts.field, opts);
  } else if (kind === "unused-assets") {
    results = unusedAssetResults(files, dir, opts);
  } else if (kind === "code-blocks") {
    results = codeBlockResults(files, opts);
  } else if (kind === "tasks") {
    ({ results, summary, count: resultCount } = taskResults(files, opts));
  } else if (kind === "frontmatter-keys") {
    ({ results, summary, count: resultCount } = frontmatterKeyResults(files));
  } else {
    results = files
      .filter(
        (file) =>
          !runtime()
            .workspace.document(file)
            .headings.some((heading) => heading.depth === 1),
      )
      .map((file) => ({ file: outputPath(file, opts) }));
  }
  const envelope: QueryEnvelope = {
    kind,
    directory: outputPath(dir, opts),
    count: resultCount ?? results.length,
    results,
    ...(summary ? { summary } : {}),
  };
  process.stdout.write(
    opts.format === "json"
      ? jsonPayload("md query", envelope, opts)
      : textOutput(envelope, opts.format === "human") + "\n",
  );
}
