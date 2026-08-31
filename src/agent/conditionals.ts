import { visit } from "unist-util-visit";
import { parseMarkdown } from "../markdown-ast.js";
import type { Root } from "../markdown-ast.js";
import { TARGETS } from "./types.js";
import type { AgentDiagnostic, AgentTarget } from "./types.js";
import { diagnostic } from "./types.js";

/**
 * Target-conditional regions, in one place.
 *
 * The grammar used to live in two regexes — one in the parser that validated
 * markers, one in the renderer that stripped them — which could disagree about
 * what a document meant. They are the same grammar here, so a form the
 * validator accepts is a form the renderer understands.
 *
 * Two forms are read. The **legacy** form carries one literal target name and
 * nothing else, and is unchanged:
 *
 * ```markdown
 * <!-- target:cursor -->
 * <!-- /target:cursor -->
 * ```
 *
 * The **conditional** form carries the expressiveness — a list is an OR, `not`
 * negates the whole list, and a block may branch:
 *
 * ```markdown
 * <!-- if target:claude-code -->
 * <!-- elif target:codex, cursor -->
 * <!-- else -->
 * <!-- endif -->
 * ```
 */

/** Files the renderer runs conditional blocks through, and so must validate. */
export const CONDITIONAL_TEXT = /\.(?:md|txt|json|ya?ml|toml|sh|js|mjs|cjs|ts|py)$/i;

/** Every HTML comment, with its offsets. The only thing either side scans for. */
const COMMENT = /<!--([\s\S]*?)-->/g;

const LEGACY = /^(\/)?(target|platform):(\S+)$/;
const OPEN = /^(if|elif)\s+(.+)$/i;
const PREDICATE = /^(not\s+)?(?:target|platform):(\S(?:[^\s]|\s(?=[^\s]))*)$/i;

/**
 * Whether a comment is *meant* to be a conditional marker.
 *
 * A near-miss — `<!-- target: cursor -->` with a space after the colon, or
 * `<!-- targets:cursor -->` — used to match neither regex and so did nothing at
 * all, silently. Recognising the intent is what lets it be reported.
 *
 * `if`/`elif` only count when the rest mentions a predicate keyword, so an
 * ordinary `<!-- if you change this, update X -->` stays prose.
 */
const CANDIDATE =
  /^\s*(?:\/?\s*(?:target|platform)s?\b|else\s*$|endif\b|(?:el(?:se)?if|if)\b(?=[\s\S]*(?:\bnot\b|(?:target|platform)s?\s*:)))/i;

type Marker =
  | { kind: "legacy-open" | "legacy-close"; syntax: string; target: string }
  | { kind: "if" | "elif"; predicate: Predicate }
  | { kind: "else" | "endif" };

interface Predicate {
  negated: boolean;
  targets: string[];
}

interface Token {
  marker: Marker;
  /** Offset of the `<` and one past the `>`, plus a trailing newline if present. */
  start: number;
  end: number;
  line: number;
  /** The raw comment body, for a diagnostic message. */
  raw: string;
}

function parsePredicate(text: string): Predicate | null {
  const match = PREDICATE.exec(text.trim());
  if (!match) return null;
  const targets = match[2]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!targets.length) return null;
  return { negated: Boolean(match[1]), targets };
}

function classify(body: string): Marker | "malformed" | null {
  const text = body.trim();
  const legacy = LEGACY.exec(text);
  if (legacy)
    return {
      kind: legacy[1] ? "legacy-close" : "legacy-open",
      syntax: legacy[2],
      target: legacy[3],
    };
  const lower = text.toLowerCase();
  if (lower === "else") return { kind: "else" };
  if (lower === "endif") return { kind: "endif" };
  const open = OPEN.exec(text);
  if (open) {
    const predicate = parsePredicate(open[2]);
    if (predicate) return { kind: open[1].toLowerCase() === "if" ? "if" : "elif", predicate };
    // An `if` whose remainder mentions no predicate keyword is prose — the
    // whole point of the candidate test is that `<!-- if you change this -->`
    // must not become an error.
  }
  return CANDIDATE.test(body) ? "malformed" : null;
}

/**
 * Byte ranges that document the syntax rather than using it: fenced code blocks
 * and inline code spans.
 *
 * Without this, a fenced *example* of a conditional is treated as a live block
 * — which is exactly what happened to this project's own bundle-format
 * reference, whose example rendered as an empty code fence. Inline spans count
 * for the same reason: prose saying that `<!-- target: cursor -->` is wrong must
 * not itself be reported as wrong.
 *
 * It is the guard `synchronizeToc` needs and for the same reason; snippet links
 * avoid needing one by living in the fence info string, which is unreachable by
 * construction.
 */
function protectedRanges(tree: Root): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  visit(tree, (node) => {
    if (node.type !== "code" && node.type !== "inlineCode") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push([start, end]);
  });
  return ranges;
}

/**
 * The markers in `content`, in order.
 *
 * `markdown` turns on {@link protectedRanges}.
 */
function tokenize(
  content: string,
  markdown: boolean,
): { tokens: Token[]; malformed: Array<{ raw: string; line: number }> } {
  const tokens: Token[] = [];
  const malformed: Array<{ raw: string; line: number }> = [];
  const protect = markdown ? protectedRanges(parseMarkdown(content)) : [];
  // One pass over the string, counting newlines as we go, rather than a
  // `split` per match.
  let cursor = 0;
  let line = 1;
  COMMENT.lastIndex = 0;
  for (let match = COMMENT.exec(content); match; match = COMMENT.exec(content)) {
    while (cursor < match.index) {
      if (content.charCodeAt(cursor) === 10) line += 1;
      cursor += 1;
    }
    const marker = classify(match[1]);
    if (marker === null) continue;
    if (protect.some(([from, to]) => match.index >= from && match.index < to)) continue;
    if (marker === "malformed") {
      malformed.push({ raw: match[0], line });
      continue;
    }
    let end = match.index + match[0].length;
    if (content[end] === "\r") end += 1;
    if (content[end] === "\n") end += 1;
    tokens.push({ marker, start: match.index, end, line, raw: match[0] });
  }
  return { tokens, malformed };
}

function matches(predicate: Predicate, target: AgentTarget): boolean {
  const listed = predicate.targets.includes(target);
  return predicate.negated ? !listed : listed;
}

interface Frame {
  /** Whether some branch of this block has already been taken. */
  taken: boolean;
  /** Whether the branch currently open is emitted. */
  active: boolean;
  /** Whether the enclosing block emits at all. */
  enclosing: boolean;
  seenElse: boolean;
  legacy?: { syntax: string; target: string };
}

/**
 * Resolves every conditional region for one target.
 *
 * An unbalanced document is left alone rather than half-stripped: `AB121`
 * already reports it at parse time, and mangling the body would turn one
 * finding into a confusing diff.
 */
export function applyConditionals(
  content: string,
  target: AgentTarget,
  options: { markdown?: boolean } = {},
): string {
  const { tokens } = tokenize(content, options.markdown ?? true);
  if (!tokens.length) return content;

  const stack: Frame[] = [];
  const emitting = (): boolean => stack.every((frame) => frame.active && frame.enclosing);
  let out = "";
  let cursor = 0;

  for (const token of tokens) {
    if (emitting()) out += content.slice(cursor, token.start);
    cursor = token.end;
    const marker = token.marker;
    switch (marker.kind) {
      case "legacy-open": {
        const active = marker.target === target;
        stack.push({
          taken: active,
          active,
          enclosing: emitting(),
          seenElse: false,
          legacy: { syntax: marker.syntax, target: marker.target },
        });
        break;
      }
      case "if": {
        const active = matches(marker.predicate, target);
        stack.push({ taken: active, active, enclosing: emitting(), seenElse: false });
        break;
      }
      case "elif": {
        const frame = stack[stack.length - 1];
        if (!frame) return content;
        frame.active = !frame.taken && matches(marker.predicate, target);
        frame.taken = frame.taken || frame.active;
        break;
      }
      case "else": {
        const frame = stack[stack.length - 1];
        if (!frame) return content;
        frame.active = !frame.taken;
        frame.taken = true;
        frame.seenElse = true;
        break;
      }
      case "endif":
      case "legacy-close": {
        if (!stack.length) return content;
        stack.pop();
        break;
      }
    }
  }
  if (stack.length) return content;
  out += content.slice(cursor);
  return out;
}

function unknownTargets(names: string[]): string[] {
  return names.filter((name) => !(TARGETS as readonly string[]).includes(name));
}

/** Reports `AB120`, `AB121`, and `AB123` for one file's markers. */
export function validateConditionals(
  content: string,
  file: string,
  diagnostics: AgentDiagnostic[],
  options: { markdown?: boolean } = {},
): void {
  const { tokens, malformed } = tokenize(content, options.markdown ?? true);
  for (const item of malformed)
    diagnostics.push({
      ...diagnostic(
        "AB123",
        `Malformed conditional marker on line ${item.line}: ${item.raw}`,
        "unsupported",
        {
          path: file,
          remediation:
            "Write <!-- target:<name> --> with no space after the colon, or <!-- if target:<name> --> / <!-- elif ... --> / <!-- else --> / <!-- endif -->.",
        },
      ),
      severity: "error",
    });

  const unknown = (names: string[], line: number): void => {
    const bad = unknownTargets(names);
    if (!bad.length) return;
    diagnostics.push({
      ...diagnostic(
        "AB120",
        `Unknown target block '${bad.join(", ")}' on line ${line}`,
        "unsupported",
        {
          path: file,
          remediation: `Use ${TARGETS.join(", ")}.`,
        },
      ),
      severity: "error",
    });
  };
  const unbalanced = (message: string, line?: number): void => {
    diagnostics.push({
      ...diagnostic("AB121", line ? `${message} on line ${line}` : message, "unsupported", {
        path: file,
        remediation: "Close conditional blocks in nesting order.",
      }),
      severity: "error",
    });
  };

  const stack: Array<{ legacy?: { syntax: string; target: string }; seenElse: boolean }> = [];
  for (const token of tokens) {
    const marker = token.marker;
    switch (marker.kind) {
      case "legacy-open":
        unknown([marker.target], token.line);
        stack.push({ legacy: { syntax: marker.syntax, target: marker.target }, seenElse: false });
        break;
      case "if":
        unknown(marker.predicate.targets, token.line);
        stack.push({ seenElse: false });
        break;
      case "elif": {
        unknown(marker.predicate.targets, token.line);
        const frame = stack[stack.length - 1];
        if (!frame) unbalanced("elif outside a conditional block", token.line);
        else if (frame.legacy)
          unbalanced("elif inside a legacy target block; use if/elif/endif", token.line);
        else if (frame.seenElse) unbalanced("elif after else", token.line);
        break;
      }
      case "else": {
        const frame = stack[stack.length - 1];
        if (!frame) unbalanced("else outside a conditional block", token.line);
        else if (frame.legacy)
          unbalanced("else inside a legacy target block; use if/else/endif", token.line);
        else if (frame.seenElse)
          unbalanced("a conditional block has two else branches", token.line);
        else frame.seenElse = true;
        break;
      }
      case "legacy-close": {
        unknown([marker.target], token.line);
        const frame = stack.pop();
        if (
          !frame?.legacy ||
          frame.legacy.target !== marker.target ||
          frame.legacy.syntax !== marker.syntax
        )
          unbalanced("Unmatched or misnested target block", token.line);
        break;
      }
      case "endif": {
        const frame = stack.pop();
        if (!frame) unbalanced("endif outside a conditional block", token.line);
        else if (frame.legacy) unbalanced("endif closing a legacy target block", token.line);
        break;
      }
    }
  }
  if (stack.length) unbalanced("Unclosed conditional block");
}
