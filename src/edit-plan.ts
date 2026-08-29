import fs from "node:fs";
import path from "node:path";
import { fingerprint, type FileFingerprint } from "./workspace-index.js";
import { inside } from "./workspace.js";

/**
 * A replacement of `[start, end)` with `value`.
 *
 * Offsets are UTF-16 code-unit indices into the utf-8-decoded file — exactly what
 * `content.slice(start, end)` uses, and the same unit mdast positions and
 * `MdLink.destinationStart` already carry. They are not byte offsets.
 */
export interface TextEdit {
  start: number;
  /** Exclusive. `start === end` is a pure insertion. */
  end: number;
  value: string;
}

/**
 * Applies edits back to front so earlier offsets stay valid.
 *
 * Overlapping edits are not detected here; the caller owns that, because the
 * right response depends on whether the overlap is a planner bug or a genuine
 * collision between two rules.
 */
export function applyEdits(content: string, edits: readonly TextEdit[]): string {
  let result = content;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}

/**
 * An unused path beside `file`, for staging a write that is committed by rename.
 *
 * A sibling rather than a temp directory so the rename stays within one
 * filesystem and is therefore atomic.
 */
export function temporarySibling(file: string): string {
  for (let index = 0; index < 100; index++) {
    const candidate = path.join(
      path.dirname(file),
      `.${path.basename(file)}.cairn-${process.pid}-${index}.tmp`,
    );
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate temporary file beside ${file}`);
}

/** Where an edit came from, so a plan can be reviewed rule by rule. */
export interface EditDiagnostic {
  /** Stable fixer identity, e.g. "toc" or "markdownlint/MD009". */
  rule: string;
  /** 1-based line the diagnostic anchors to. */
  line: number;
  message: string;
}

export interface PlannedEdit extends TextEdit {
  /** Absolute path of the file the edit applies to. */
  file: string;
  /**
   * The exact text currently occupying `[start, end)`.
   *
   * Mandatory, and revalidated immediately before any write. Offsets are
   * UTF-16 code units rather than bytes, so this is what lets a consumer apply
   * an edit without having to trust the unit — a mismatch aborts instead of
   * corrupting a document containing astral-plane characters.
   */
  expected: string;
  /** `value` under its role-specific name. */
  replacement: string;
  diagnostic: EditDiagnostic;
}

export interface FileSnapshot {
  file: string;
  content: string;
  fingerprint: FileFingerprint;
}

export interface FileEditPlan {
  file: string;
  /** Captured when the file was read for planning; rechecked before applying. */
  fingerprint: FileFingerprint;
  /** Non-overlapping, sorted ascending by start. */
  edits: PlannedEdit[];
}

export type PlanConflictKind =
  "overlap" | "outside-workspace" | "stale-input" | "expectation-mismatch";

export interface PlanConflict {
  kind: PlanConflictKind;
  file: string;
  message: string;
  /** Rules involved, sorted. Two for an overlap, one otherwise. */
  rules: string[];
}

export interface EditPlan {
  root: string;
  /** Sorted by path. Files with no surviving edits are omitted. */
  files: FileEditPlan[];
  /** Non-empty means applyPlan will refuse. Never thrown while planning. */
  conflicts: PlanConflict[];
}

export interface AppliedFile {
  file: string;
  edits: number;
  /** False when the edits collapsed to a no-op and the file was left alone. */
  changed: boolean;
}

export interface AppliedPlan {
  files: AppliedFile[];
  edits: number;
}

/**
 * Reads a file, checking its fingerprint on both sides.
 *
 * A write landing between the two stats is caught here rather than silently
 * absorbed into a plan built from half-old content.
 */
export function snapshot(file: string): FileSnapshot {
  const before = fingerprint(file);
  const content = fs.readFileSync(file, "utf-8");
  const after = fingerprint(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`File changed while it was being read: ${file}`);
  }
  return { file, content, fingerprint: after };
}

/** True when `file` is inside `root` both lexically and after resolving symlinks. */
function contained(root: string, file: string): boolean {
  if (!inside(root, file)) return false;
  try {
    // The parent, not the file: the file may not exist yet, and a symlinked
    // directory is the way an edit would otherwise escape the workspace.
    return inside(fs.realpathSync(root), fs.realpathSync(path.dirname(file)));
  } catch {
    return false;
  }
}

/**
 * Groups edits per file and records every reason the plan must not be applied.
 *
 * Never throws and never silently drops a conflicting edit: `--check` and
 * `--dry-run` have to be able to report exactly which rules collided, so the
 * user knows which one to leave out.
 */
export function buildPlan(
  root: string,
  edits: readonly PlannedEdit[],
  snapshots: ReadonlyMap<string, FileSnapshot>,
): EditPlan {
  const conflicts: PlanConflict[] = [];
  const byFile = new Map<string, PlannedEdit[]>();

  for (const edit of edits) {
    const file = path.resolve(edit.file);
    if (!contained(root, file)) {
      conflicts.push({
        kind: "outside-workspace",
        file,
        message: `Edit target is outside the workspace root: ${file}`,
        rules: [edit.diagnostic.rule],
      });
      continue;
    }
    const snap = snapshots.get(file);
    if (!snap) {
      conflicts.push({
        kind: "stale-input",
        file,
        message: `No snapshot was taken for ${file}`,
        rules: [edit.diagnostic.rule],
      });
      continue;
    }
    // A planner emitting the wrong `expected` is a bug, surfaced as a conflict
    // rather than allowed to corrupt the file.
    if (snap.content.slice(edit.start, edit.end) !== edit.expected) {
      conflicts.push({
        kind: "expectation-mismatch",
        file,
        message: `${edit.diagnostic.rule} expected ${JSON.stringify(edit.expected)} at [${edit.start},${edit.end})`,
        rules: [edit.diagnostic.rule],
      });
      continue;
    }
    byFile.set(file, [...(byFile.get(file) ?? []), edit]);
  }

  const files: FileEditPlan[] = [];
  for (const file of [...byFile.keys()].sort()) {
    const list = byFile.get(file)!;
    list.sort(
      (a, b) =>
        a.start - b.start ||
        a.end - b.end ||
        (a.diagnostic.rule < b.diagnostic.rule
          ? -1
          : a.diagnostic.rule > b.diagnostic.rule
            ? 1
            : 0),
    );
    for (let index = 1; index < list.length; index++) {
      const previous = list[index - 1];
      const current = list[index];
      const overlaps = previous.end > current.start;
      // Two insertions at one offset do not overlap, but their order is
      // undefined, which is the same hazard.
      const ambiguous =
        previous.start === previous.end &&
        current.start === current.end &&
        previous.start === current.start;
      if (!overlaps && !ambiguous) continue;
      conflicts.push({
        kind: "overlap",
        file,
        message:
          `${previous.diagnostic.rule} [${previous.start},${previous.end}) and ` +
          `${current.diagnostic.rule} [${current.start},${current.end}) edit the same span`,
        rules: [previous.diagnostic.rule, current.diagnostic.rule].sort(),
      });
    }
    files.push({ file, fingerprint: snapshots.get(file)!.fingerprint, edits: list });
  }

  return { root, files, conflicts };
}

export interface ApplyOptions {
  /** Called for every file whose bytes changed, and on the rollback path. */
  invalidate?: (file: string) => void;
}

/**
 * Applies a whole plan as one transaction.
 *
 * Every file is rechecked before any file is staged, so a stale input costs
 * zero writes. Each file is then written to a sibling and committed by rename,
 * which is atomic per file. The multi-file commit is not atomic: a failure
 * part way through restores already-committed files by rewriting their original
 * bytes, which is best-effort and not crash-safe.
 */
export function applyPlan(plan: EditPlan, options: ApplyOptions = {}): AppliedPlan {
  if (plan.conflicts.length) {
    throw new Error(`Refusing to write: ${plan.conflicts.length} conflict(s) in the edit plan`);
  }

  const pending: Array<{ file: string; original: Buffer; next: string; mode: number }> = [];
  for (const entry of plan.files) {
    const current = snapshot(entry.file);
    if (
      current.fingerprint.size !== entry.fingerprint.size ||
      current.fingerprint.mtimeMs !== entry.fingerprint.mtimeMs
    ) {
      throw new Error(`Aborted: ${entry.file} changed after the plan was built`);
    }
    // The fingerprint is the cheap check; re-verifying every expectation is the
    // authoritative one, and closes the coarse-mtime hole.
    for (const edit of entry.edits) {
      if (current.content.slice(edit.start, edit.end) !== edit.expected) {
        throw new Error(
          `Aborted: ${entry.file} no longer matches the plan at [${edit.start},${edit.end})`,
        );
      }
    }
    const next = applyEdits(current.content, entry.edits);
    if (next === current.content) continue;
    pending.push({
      file: entry.file,
      original: fs.readFileSync(entry.file),
      next,
      mode: fs.statSync(entry.file).mode,
    });
  }

  const staged = new Map<string, string>();
  const committed: Array<{ file: string; original: Buffer }> = [];
  try {
    for (const item of pending) {
      const temporary = temporarySibling(item.file);
      fs.writeFileSync(temporary, item.next, { encoding: "utf-8", flag: "wx" });
      fs.chmodSync(temporary, item.mode);
      staged.set(item.file, temporary);
    }
    for (const item of pending) {
      fs.renameSync(staged.get(item.file)!, item.file);
      staged.delete(item.file);
      committed.push({ file: item.file, original: item.original });
    }
  } catch (error) {
    for (const temporary of staged.values()) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    for (const item of committed) {
      try {
        fs.writeFileSync(item.file, item.original);
      } catch {
        // Best-effort rollback.
      }
      options.invalidate?.(item.file);
    }
    throw error;
  }

  const changed = new Set(pending.map((item) => item.file));
  for (const file of changed) options.invalidate?.(file);
  return {
    files: plan.files.map((entry) => ({
      file: entry.file,
      edits: entry.edits.length,
      changed: changed.has(entry.file),
    })),
    edits: plan.files.reduce((total, entry) => total + entry.edits.length, 0),
  };
}

/**
 * The root every edit in a plan must stay inside.
 *
 * A configured workspace is the authority when there is one. Without a config
 * file `config.root` is only the working directory, and refusing an absolute
 * path outside it would reject `cairn md fix /elsewhere/docs` for no
 * benefit — so the boundary becomes the directory containing the files the
 * caller actually selected. Either way an edit cannot reach beyond what was
 * asked for, which is what the guard is for.
 */
export function containmentRoot(
  files: readonly string[],
  config: { root: string; configPath?: string },
): string {
  if (config.configPath || !files.length) return config.root;
  const segments = files.map((file) => path.dirname(path.resolve(file)).split(path.sep));
  const common: string[] = [];
  for (let index = 0; index < segments[0].length; index++) {
    const part = segments[0][index];
    if (!segments.every((candidate) => candidate[index] === part)) break;
    common.push(part);
  }
  return common.join(path.sep) || path.sep;
}
