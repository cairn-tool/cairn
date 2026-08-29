import fs from "node:fs";
import {
  extractCodeBlocks,
  isLineInCodeBlock,
  parseMarkdown,
  type MdCodeBlock,
} from "./markdown-ast.js";
import { resolveLocalPath } from "./link-target.js";
import { inside } from "./workspace.js";
import { fingerprint, type FileFingerprint } from "./workspace-index.js";
import type { PlannedEdit } from "./edit-plan.js";

/**
 * The fence info-string attribute linking a block to a source region.
 *
 * Read from mdast `Code.meta` and never by scanning the document text. That is
 * what makes a fenced example *documenting* this syntax harmless: remark parses
 * an inner fence as characters inside the outer block's value rather than as a
 * code node, so a documentation sample is unreachable by construction. A raw
 * scan would reintroduce exactly the hazard `synchronizeToc` has to guard
 * against, with no guard available on this side.
 */
export const SNIPPET_ATTRIBUTE = "cairn:snippet";

/** The pre-rename attribute, still read so existing fences keep resolving. */
export const LEGACY_SNIPPET_ATTRIBUTE = "claude-cli:snippet";

/** Alternation over both spellings, for the two patterns below. */
const ATTRIBUTE_ALTERNATION = "(?:cairn|claude-cli):snippet";

/**
 * A region delimiter in a source file of unknown language.
 *
 * Deliberately unanchored: the comment leader (`//`, `#`, `--`, `/*`, `<!--`)
 * is not knowable, and whatever trails the name on the line is ignored. A
 * regex rather than a substring test so that the name is captured and so that
 * `cairn:snippet:startup` cannot match `…:start`.
 *
 * Region markers live in source files, which this command only ever reads, so
 * accepting both spellings costs nothing and there is never anything to migrate.
 */
export const REGION_MARKER = new RegExp(
  `${ATTRIBUTE_ALTERNATION}:(start|end)[ \\t]+([A-Za-z0-9][A-Za-z0-9._-]*)`,
);

/** Sources above this are refused unread; a snippet is never this large. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

// Alternating over both spellings also makes the duplicate check right for free:
// a fence carrying one of each counts two matches, which is what it is.
const ATTRIBUTE_PATTERN = new RegExp(
  `(?:^|\\s)${ATTRIBUTE_ALTERNATION}=("[^"]*"|'[^']*'|\\S+)`,
  "g",
);
const REGION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BLANK_LINE = /^[ \t]*$/;
const MARKDOWN_SOURCE = /\.(?:md|markdown|mdown)$/i;

/** No fragment means the whole file. */
export type SnippetSelector = { kind: "file" } | { kind: "region"; name: string };

/** Why a link could not be turned into an expected body, or written back. */
export type SnippetReason =
  // Authoring
  | "no-language"
  | "duplicate-attribute"
  | "empty-target"
  | "malformed-region-name"
  // Source
  | "source-outside-root"
  | "source-not-found"
  | "source-not-a-file"
  | "source-too-large"
  | "source-binary"
  | "source-unreadable"
  // Region
  | "region-missing"
  | "region-ambiguous"
  | "region-unterminated"
  | "region-inverted"
  // Write
  | "not-a-fence"
  | "unterminated-fence"
  | "container-prefix"
  | "fence-collision";

export interface SnippetFailure {
  reason: SnippetReason;
  message: string;
}

function fail(reason: SnippetReason, message: string): SnippetFailure {
  return { reason, message };
}

/** Renders a selector the way it was written on the fence. */
export function describeSelector(targetPath: string, selector: SnippetSelector): string {
  return selector.kind === "file" ? targetPath : `${targetPath}#${selector.name}`;
}

// ---------------------------------------------------------------------------
// Fence metadata
// ---------------------------------------------------------------------------

export type SnippetLinkParse =
  | { status: "unlinked" }
  | ({ status: "malformed" } & SnippetFailure)
  | { status: "linked"; targetPath: string; selector: SnippetSelector };

/**
 * Reads a snippet link off one fence.
 *
 * Two substring tests for the overwhelming majority of blocks, which carry no
 * link at all.
 */
export function parseSnippetLink(block: Pick<MdCodeBlock, "lang" | "meta">): SnippetLinkParse {
  // Both spellings gate the fast path, or a legacy fence would report `unlinked`
  // without the regex below ever seeing it.
  const carries = (text: string, at: "anywhere" | "start"): boolean =>
    [SNIPPET_ATTRIBUTE, LEGACY_SNIPPET_ATTRIBUTE].some((attribute) =>
      at === "start" ? text.startsWith(`${attribute}=`) : text.includes(`${attribute}=`),
    );

  if (!block.meta || !carries(block.meta, "anywhere")) {
    // A fence with no language puts the whole info string into `lang`, so the
    // attribute lands there and would otherwise be silently inert forever.
    if (block.lang && carries(block.lang, "start")) {
      return {
        status: "malformed",
        ...fail(
          "no-language",
          `A snippet link needs a language before the attribute; write \`\`\`text ${SNIPPET_ATTRIBUTE}=…`,
        ),
      };
    }
    return { status: "unlinked" };
  }

  ATTRIBUTE_PATTERN.lastIndex = 0;
  const matches = [...block.meta.matchAll(ATTRIBUTE_PATTERN)];
  if (!matches.length) return { status: "unlinked" };
  if (matches.length > 1) {
    return {
      status: "malformed",
      ...fail("duplicate-attribute", `A fence may carry only one ${SNIPPET_ATTRIBUTE}= attribute`),
    };
  }

  const raw = matches[0][1];
  const value =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  // The first `#`, not the last: a region name may not contain one, but a path
  // theoretically may, and splitting late would silently mangle it.
  const hash = value.indexOf("#");
  const targetPath = hash === -1 ? value : value.slice(0, hash);
  const fragment = hash === -1 ? "" : value.slice(hash + 1);

  if (!targetPath) {
    return { status: "malformed", ...fail("empty-target", `${SNIPPET_ATTRIBUTE}= needs a path`) };
  }
  if (hash !== -1 && !REGION_NAME.test(fragment)) {
    return {
      status: "malformed",
      ...fail("malformed-region-name", `Not a valid region name: ${fragment || "(empty)"}`),
    };
  }

  return {
    status: "linked",
    targetPath,
    selector: fragment ? { kind: "region", name: fragment } : { kind: "file" },
  };
}

// ---------------------------------------------------------------------------
// Region extraction
// ---------------------------------------------------------------------------

/**
 * Strips the longest common literal leading-whitespace prefix.
 *
 * A literal prefix rather than a column count: a region mixing a tab-indented
 * and a space-indented line then yields an empty prefix instead of having one
 * of them mangled. Blank lines become empty, never whitespace.
 */
export function dedent(lines: readonly string[]): string[] {
  const indents = lines
    .filter((line) => !BLANK_LINE.test(line))
    .map((line) => /^[ \t]*/.exec(line)![0]);
  if (!indents.length) return lines.map(() => "");
  let prefix = indents[0];
  for (const indent of indents) {
    let index = 0;
    while (index < prefix.length && index < indent.length && prefix[index] === indent[index]) {
      index++;
    }
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return lines.map((line) => (BLANK_LINE.test(line) ? "" : line.slice(prefix.length)));
}

/**
 * The comparison form, shared by the comparator and the writer.
 *
 * Exactly three differences are ignored, because exactly these three are
 * applied by ambient tooling without an author's intent: line endings
 * (`core.autocrlf`), trailing horizontal whitespace (trim-on-save), and
 * trailing blank lines (final-newline rules). Everything else — reindentation,
 * a renamed identifier — is genuine drift. Because `--write` emits this form,
 * writing and then checking is clean by construction.
 */
export function normalizeSnippet(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
}

export type RegionExtraction =
  { status: "found"; text: string } | ({ status: "failed" } & SnippetFailure);

/**
 * Pulls a selector's text out of a source file.
 *
 * When the source is itself Markdown, marker matches inside fenced code are
 * skipped — the same guard `synchronizeToc` applies, for the same reason: a
 * document explaining this syntax would otherwise appear to declare a region.
 */
export function extractRegion(
  source: string,
  selector: SnippetSelector,
  markdownSource = false,
): RegionExtraction {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized ? normalized.replace(/\n$/, "").split("\n") : [];

  const fenced = markdownSource ? extractCodeBlocks(parseMarkdown(source)) : [];
  const markers: Array<{ index: number; kind: string; name: string }> = [];
  lines.forEach((line, index) => {
    const match = REGION_MARKER.exec(line);
    if (!match) return;
    if (markdownSource && isLineInCodeBlock(index + 1, fenced)) return;
    markers.push({ index, kind: match[1], name: match[2] });
  });

  let from = 0;
  let to = lines.length;
  if (selector.kind === "region") {
    const starts = markers.filter((m) => m.kind === "start" && m.name === selector.name);
    const ends = markers.filter((m) => m.kind === "end" && m.name === selector.name);
    if (!starts.length && !ends.length) {
      return { status: "failed", ...fail("region-missing", `No region named ${selector.name}`) };
    }
    if (starts.length > 1 || ends.length > 1) {
      return {
        status: "failed",
        ...fail("region-ambiguous", `Region ${selector.name} is declared more than once`),
      };
    }
    if (!starts.length) {
      return {
        status: "failed",
        ...fail("region-missing", `Region ${selector.name} has an end marker but no start marker`),
      };
    }
    if (!ends.length) {
      return {
        status: "failed",
        ...fail("region-unterminated", `Region ${selector.name} has no end marker`),
      };
    }
    if (ends[0].index < starts[0].index) {
      return {
        status: "failed",
        ...fail("region-inverted", `Region ${selector.name} ends before it starts`),
      };
    }
    from = starts[0].index + 1;
    to = ends[0].index;
  }

  // Marker lines are dropped before the dedent, so a nested region's own
  // indentation cannot skew the common prefix — and its scaffolding never
  // reaches the documentation.
  const dropped = new Set(markers.map((marker) => marker.index));
  const body = lines.slice(from, to).filter((_, offset) => !dropped.has(from + offset));
  while (body.length && BLANK_LINE.test(body[0])) body.shift();
  while (body.length && BLANK_LINE.test(body[body.length - 1])) body.pop();

  return { status: "found", text: dedent(body).join("\n") };
}

// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

export type SourceRead =
  | { status: "read"; content: string; fingerprint: FileFingerprint }
  | ({ status: "failed" } & SnippetFailure);

/**
 * Reads a snippet source, refusing anything a document must not absorb.
 *
 * `md check-snippets --write` copies this content into a tracked file, so an
 * unbounded read is a content-exfiltration primitive rather than a nuisance:
 * a pull request naming an absolute path plus a CI refresh would commit the
 * result. Neither `resolveLocalPath` nor the reference checker performs any
 * containment check, because there the only leak is a boolean.
 *
 * Messages name no path: the caller knows the target as the author wrote it,
 * and `md audit --baseline` keys on the message, so an absolute path would
 * make a baseline valid on exactly one machine.
 */
export function readSnippetSource(resolved: string, root: string): SourceRead {
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return { status: "failed", ...fail("source-not-found", "Source file not found") };
  }

  // Resolved on both sides, so a symlinked directory cannot be the way out.
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // An unresolvable root can only make the check stricter.
  }
  if (!inside(realRoot, real)) {
    return {
      status: "failed",
      ...fail("source-outside-root", "Source file is outside the workspace root"),
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(real);
  } catch {
    return {
      status: "failed",
      ...fail("source-unreadable", "Source file is unreadable"),
    };
  }
  // A FIFO or a character device would block the read forever, leaving a CI
  // job wedged with no output at all.
  if (!stat.isFile()) {
    return {
      status: "failed",
      ...fail("source-not-a-file", "Source path is not a regular file"),
    };
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    return {
      status: "failed",
      ...fail("source-too-large", `Source file is larger than ${MAX_SOURCE_BYTES} bytes`),
    };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(real);
  } catch {
    return {
      status: "failed",
      ...fail("source-unreadable", "Source file is unreadable"),
    };
  }
  // A lossy utf-8 decode would otherwise write U+FFFD into the document.
  if (buffer.subarray(0, 8192).includes(0)) {
    return { status: "failed", ...fail("source-binary", "Source file is not text") };
  }

  // A byte-order mark would become a permanent, invisible difference.
  const content = buffer.toString("utf-8").replace(/^\uFEFF/, "");
  return { status: "read", content, fingerprint: fingerprint(real) };
}

/**
 * A reader memoized for one run.
 *
 * Deliberately not `Workspace.document`: that parses as Markdown and writes
 * the result into the persistent workspace index, which has no business
 * holding records for source files.
 */
export function createSourceReader(root: string): (resolved: string) => SourceRead {
  const cache = new Map<string, SourceRead>();
  return (resolved) => {
    const cached = cache.get(resolved);
    if (cached) return cached;
    const read = readSnippetSource(resolved, root);
    cache.set(resolved, read);
    return read;
  };
}

// ---------------------------------------------------------------------------
// Synchronization
// ---------------------------------------------------------------------------

/** The bytes strictly between the two fence lines, and what belongs there. */
export interface SnippetWrite {
  start: number;
  /** Exclusive: the first byte of the closing fence line. */
  end: number;
  interior: string;
}

interface SnippetLocation {
  /** 1-based line of the opening fence. */
  line: number;
  /** 1-based line of the closing fence. */
  endLine: number;
}

interface ResolvedSnippet extends SnippetLocation {
  /** The attribute value as written, e.g. `src/toc.ts#render`. */
  target: string;
  /** Absolute path of the source file. */
  source: string;
  selector: SnippetSelector;
}

export type SnippetSynchronization =
  | ({ status: "malformed" } & SnippetLocation & SnippetFailure)
  | ({ status: "unresolved" } & SnippetLocation &
      SnippetFailure & { target: string; source?: string; selector: SnippetSelector })
  | ({ status: "current" } & ResolvedSnippet & { sourceFingerprint: FileFingerprint })
  | ({ status: "stale" } & ResolvedSnippet & {
        sourceFingerprint: FileFingerprint;
        /** The body as documented today, container indentation removed. */
        documented: string;
        /** The body the source says it should be. */
        expected: string;
        /** Absent when the block cannot be rewritten in place. */
        write?: SnippetWrite;
        /** Why `write` is absent. */
        unwritable?: SnippetFailure;
      });

export interface SnippetContext {
  /** Absolute path of the document the blocks came from. */
  file: string;
  /** Source paths resolve against this, and reads may not leave it. */
  root: string;
  read: (resolved: string) => SourceRead;
}

/**
 * Where a refreshed body would go, and whether it can go there at all.
 *
 * The range is the interior only, so the fence line is never rewritten and its
 * info string — including attributes owned by some other toolchain — survives
 * byte for byte at no cost.
 */
function planWrite(
  content: string,
  block: MdCodeBlock,
  body: string,
): SnippetWrite | SnippetFailure {
  const raw = content.slice(block.start, block.end);
  const fence = /^(`{3,}|~{3,})/.exec(raw);
  // An indented code block is a `code` node too, and has no fence to write into.
  if (!fence) return fail("not-a-fence", "Only fenced code blocks can be refreshed");
  const fenceChar = fence[1][0];
  const fenceLength = fence[1].length;

  const lineStart = content.lastIndexOf("\n", block.start - 1) + 1;
  const indent = content.slice(lineStart, block.start);
  // Whitespace admits a fence indented inside a list item and refuses one in a
  // blockquote: mdast reports a dedented value, but the raw lines carry the
  // `> ` prefix, so writing without it would break the fence out of its quote.
  if (!BLANK_LINE.test(indent)) {
    return fail("container-prefix", "Fence is nested in a container this command cannot rewrite");
  }

  const openNewline = content.indexOf("\n", block.start);
  if (openNewline === -1 || openNewline >= block.end) {
    return fail("unterminated-fence", "Fence has no body");
  }
  const start = openNewline + 1;
  const end = content.lastIndexOf("\n", block.end - 1) + 1;
  const closing = content.slice(end, block.end);
  // A fence closed by end-of-file has no closing line; inserting one would
  // change the document's structure rather than refresh a snippet.
  // Neither fence character is a regular-expression metacharacter.
  const closingPattern = new RegExp(`^[ \\t]*${fenceChar}{${fenceLength},}[ \\t]*$`);
  if (end < start || !closingPattern.test(closing)) {
    return fail("unterminated-fence", "Fence is not closed by a matching fence line");
  }
  if (indent && !closing.startsWith(indent)) {
    return fail("container-prefix", "Opening and closing fences are indented differently");
  }
  for (const line of content.slice(start, end).split("\n").slice(0, -1)) {
    if (!BLANK_LINE.test(line) && indent && !line.startsWith(indent)) {
      return fail("container-prefix", "Fence body is not uniformly indented");
    }
  }

  const lines = body === "" ? [] : body.split("\n");
  if (lines.some((line) => closingPattern.test(line))) {
    return fail(
      "fence-collision",
      `Source contains a line that would close the ${fenceLength}-character fence`,
    );
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const interior =
    lines.map((line) => (line ? indent + line : "")).join(eol) + (lines.length ? eol : "");
  return { start, end, interior };
}

/**
 * Resolves every linked block in one document, in document order.
 *
 * Unlinked blocks are absent from the result rather than reported as current.
 */
export function synchronizeSnippets(
  content: string,
  blocks: readonly MdCodeBlock[],
  context: SnippetContext,
): SnippetSynchronization[] {
  const results: SnippetSynchronization[] = [];

  for (const block of blocks) {
    const parsed = parseSnippetLink(block);
    if (parsed.status === "unlinked") continue;
    const at = { line: block.line, endLine: block.endLine };
    if (parsed.status === "malformed") {
      results.push({ status: "malformed", ...at, reason: parsed.reason, message: parsed.message });
      continue;
    }

    const { targetPath, selector } = parsed;
    const target = describeSelector(targetPath, selector);
    const resolved = resolveLocalPath(context.file, targetPath, context.root);
    const read = context.read(resolved);
    if (read.status === "failed") {
      results.push({
        status: "unresolved",
        ...at,
        target,
        selector,
        reason: read.reason,
        message: `${read.message}: ${targetPath}`,
      });
      continue;
    }

    const region = extractRegion(read.content, selector, MARKDOWN_SOURCE.test(resolved));
    if (region.status === "failed") {
      results.push({
        status: "unresolved",
        ...at,
        target,
        source: resolved,
        selector,
        reason: region.reason,
        message: `${region.message} in ${targetPath}`,
      });
      continue;
    }

    const expected = normalizeSnippet(region.text);
    const documented = normalizeSnippet(block.value);
    const common = {
      ...at,
      target,
      source: resolved,
      selector,
      sourceFingerprint: read.fingerprint,
    };
    if (documented === expected) {
      results.push({ status: "current", ...common });
      continue;
    }

    const write = planWrite(content, block, expected);
    results.push({
      status: "stale",
      ...common,
      documented,
      expected,
      ...("interior" in write ? { write } : { unwritable: write }),
    });
  }

  return results;
}

/** Turns stale results into transactional edits, shared by the command and the fixer. */
export function snippetEdits(
  file: string,
  content: string,
  results: readonly SnippetSynchronization[],
): PlannedEdit[] {
  const edits: PlannedEdit[] = [];
  for (const result of results) {
    if (result.status !== "stale" || !result.write) continue;
    const { start, end, interior } = result.write;
    edits.push({
      file,
      start,
      end,
      value: interior,
      // Kept free of line numbers so `md audit --baseline`, which keys on
      // checker, file, and message, does not go stale on an unrelated edit.
      expected: content.slice(start, end),
      replacement: interior,
      diagnostic: {
        rule: "snippets",
        line: result.line,
        message: `Snippet is out of date with ${result.target}`,
      },
    });
  }
  return edits;
}
