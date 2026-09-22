import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GuardMode } from "../guard/config.js";
import { posix, sourcesFor } from "../guard/sources.js";
import { matchOutputPattern, profileFor } from "../targets/index.js";
import type { AgentDiagnostic, AgentTarget, Artifact } from "../types.js";
import { diagnostic } from "../types.js";
import type { InstallInventoryEntry, InstallRecord } from "./index.js";
import { hasControlCharacters, renderGuardScript } from "./guard-script.js";
import type { GuardScriptEntry } from "./guard-script.js";
import {
  GUARD_RECORD_NAME,
  GUARD_SCRIPT,
  composeHookDocument,
  hookDocumentPath,
  parseHookDocument,
  serializeHookDocument,
  stripHookDocument,
} from "./hook-document.js";

/**
 * The edit guard a project-scope install carries: planning it from a
 * destination's records, and retiring what an earlier run left.
 *
 * A destination gets one guard script and, per target with a project hook
 * surface, one *guard record* -- a synthetic `kind: "guard"` entry in the
 * manifest owning the script and that target's hook document. Guard records
 * are rebuilt from scratch by every run at the destination and never survive
 * as "prior records outside the batch". That is what lets the script's bytes
 * change with every install without tripping the sibling-sha conflict check
 * that co-owning it through bundle records would: a partial `--name` run would
 * otherwise find a sibling recording yesterday's sha for today's script.
 *
 * Everything here is a pure function of the merged document and the settings,
 * because `agent verify` re-plans one bundle at a time and must arrive at the
 * same bytes the install wrote.
 */

export interface GuardSettings {
  mode: GuardMode;
  /** Destination-relative paths the guard never claims; a trailing `/**` covers a directory. */
  allow: string[];
  /** The command quoted back to the editor. */
  regenerate: string;
}

/**
 * The default `regenerate` is a fixed string, not the invocation that ran.
 * `agent install` without a config and `agent verify --config x.yml` describe
 * one destination and must generate one script; a repository that wants the
 * `--config` spelled out declares `agent.guard.regenerate`.
 */
export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  mode: "block",
  allow: [],
  regenerate: "cairn agent install",
};

/** Settings from a parsed `agent.guard` block, or the defaults when there is none. */
export function guardSettingsFrom(
  config: { mode: GuardMode; allow: string[]; regenerate?: string } | undefined,
): GuardSettings {
  if (!config) return DEFAULT_GUARD_SETTINGS;
  return {
    mode: config.mode,
    allow: [...config.allow],
    regenerate: config.regenerate ?? DEFAULT_GUARD_SETTINGS.regenerate,
  };
}

export function isGuardRecord(record: InstallRecord): boolean {
  return record.kind === "guard";
}

/** A batch draft, as much of it as the guard needs. */
export interface GuardDraft {
  target: AgentTarget;
  bundleName: string;
  /** Absolute bundle root, for "edit this instead" pointers. */
  bundleRoot: string;
  payload: Artifact[];
}

export interface GuardPlanInput {
  destination: string;
  /** Every bundle and collection record at the destination after this run; no guard records. */
  records: InstallRecord[];
  /** The batch's drafts, whose payloads and bundle roots are not yet on disk. */
  drafts: GuardDraft[];
  /** Guard records the destination's manifest recorded before this run. */
  priorGuards: InstallRecord[];
  settings: GuardSettings;
  /** The generator version stamped on guard records. */
  version: string;
}

export interface GuardPlan {
  /** New guard records, sorted; empty when no target has a project hook surface. */
  records: InstallRecord[];
  /** The script and each composed hook document, sorted by path. */
  artifacts: Artifact[];
  /**
   * Hook documents a batch draft rendered (a bundle with `policies`) whose
   * bytes now carry the guard's handler. The caller replaces the draft's
   * artifact and recomputes its inventory, or the record's sha describes bytes
   * that never land.
   */
  composed: Map<string, Buffer>;
  diagnostics: AgentDiagnostic[];
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inventoryOf(artifacts: Artifact[]): InstallInventoryEntry[] {
  return artifacts
    .map((artifact) => ({
      path: artifact.path,
      mode: octal(artifact.mode),
      sha256: sha256(artifact.content),
    }))
    .sort((a, b) => byBytes(a.path, b.path));
}

/**
 * The file's bytes, or `undefined` when there is no regular file there. One
 * read, no stat before it: a directory or a missing path throws, which is the
 * answer, and a check-then-read would be a race.
 */
function readIfPresent(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

/**
 * The bundle files behind one generated path, destination-relative. Empty when
 * the record predates `source` and the bundle root is unknown.
 */
function sourcesOf(
  destination: string,
  record: InstallRecord,
  bundleRoot: string | undefined,
  relative: string,
): string[] {
  if (!bundleRoot) return [];
  const match = matchOutputPattern(profileFor(record.target), record.profile, relative);
  if (!match) return [];
  return sourcesFor(bundleRoot, record.profile, match).map((file) =>
    posix(path.relative(destination, file)),
  );
}

/** Plans the guard for one destination. Reads the disk only for hook documents. */
export function planGuard(input: GuardPlanInput): GuardPlan {
  const { destination, settings } = input;
  const diagnostics: AgentDiagnostic[] = [];
  const draftsByKey = new Map<string, GuardDraft>();
  for (const draft of input.drafts) draftsByKey.set(`${draft.bundleName}\0${draft.target}`, draft);

  // Which targets need a registration, and which bundle documents already sit
  // at the hook document's path.
  const targets = [...new Set(input.records.map((record) => record.target))].sort(byBytes);
  const composed = new Map<string, Buffer>();
  const documents = new Map<AgentTarget, { content: Buffer; created: boolean }>();
  for (const target of targets) {
    const file = hookDocumentPath(target);
    if (!file) continue;
    const rendered = input.drafts
      .filter((draft) => draft.target === target)
      .flatMap((draft) => draft.payload.filter((artifact) => artifact.path === file));
    const onDisk = readIfPresent(path.join(destination, file));
    const raw = rendered[0]?.content ?? onDisk;
    const base = raw ? parseHookDocument(raw) : {};
    if (!base) {
      diagnostics.push({
        ...diagnostic(
          "AB811",
          `Cannot register the edit guard: '${file}' is not a JSON object`,
          "unsupported",
          {
            path: file,
            target,
            remediation:
              "Repair the document so it parses as a JSON object, or set agent.guard.mode: off.",
          },
        ),
        severity: "error",
      });
      continue;
    }
    const content = serializeHookDocument(composeHookDocument(target, base));
    if (rendered.length) composed.set(file, content);
    const prior = input.priorGuards.find((record) => record.target === target);
    const created = prior?.hookDocument?.created ?? (!onDisk && !rendered.length);
    documents.set(target, { content, created });
  }
  if (!documents.size) return { records: [], artifacts: [], composed, diagnostics };

  // The inventory: every generated path at the destination, with what made it.
  const owners = new Map<string, { bundles: Set<string>; sources: Set<string> }>();
  for (const record of input.records) {
    const draft = draftsByKey.get(`${record.bundle.name}\0${record.target}`);
    const bundleRoot =
      draft?.bundleRoot ??
      (record.source !== undefined ? path.resolve(destination, record.source) : undefined);
    for (const file of record.files) {
      const entry = owners.get(file.path) ?? { bundles: new Set(), sources: new Set() };
      entry.bundles.add(record.bundle.name);
      for (const source of sourcesOf(destination, record, bundleRoot, file.path))
        entry.sources.add(source);
      owners.set(file.path, entry);
    }
  }
  const entries: GuardScriptEntry[] = [{ path: GUARD_SCRIPT, sources: [] }];
  for (const [relative, entry] of owners) {
    if (hasControlCharacters(relative)) {
      diagnostics.push({
        ...diagnostic(
          "AB812",
          `The edit guard skips '${JSON.stringify(relative)}': its path carries a control character`,
          "approximate",
          { path: relative },
        ),
        severity: "warning",
      });
      continue;
    }
    entries.push({
      path: relative,
      ...(entry.bundles.size === 1 ? { bundle: [...entry.bundles][0] } : {}),
      sources: [...entry.sources].sort(byBytes),
    });
  }

  const script: Artifact = {
    path: GUARD_SCRIPT,
    content: renderGuardScript({
      mode: settings.mode === "warn" ? "warn" : "block",
      allow: [...settings.allow].sort(byBytes),
      regenerate: settings.regenerate,
      entries,
    }),
    mode: 0o755,
  };

  const records: InstallRecord[] = [];
  const artifacts = new Map<string, Artifact>([[GUARD_SCRIPT, script]]);
  for (const [target, document] of documents) {
    const file = hookDocumentPath(target)!;
    const artifact: Artifact = { path: file, content: document.content, mode: 0o644 };
    artifacts.set(file, artifact);
    records.push({
      kind: "guard",
      bundle: { name: GUARD_RECORD_NAME, version: input.version },
      target,
      profile: "project",
      scope: "project",
      layout: "merge",
      mode: "copy",
      destination,
      files: inventoryOf([script, artifact]),
      hookDocument: { created: document.created },
    });
  }
  return {
    records: records.sort((a, b) => byBytes(a.target, b.target)),
    artifacts: [...artifacts.values()].sort((a, b) => byBytes(a.path, b.path)),
    composed,
    diagnostics,
  };
}

function removePath(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}

function pruneEmptyAncestors(root: string, relative: string): void {
  let current = path.dirname(path.join(root, relative));
  const stop = path.resolve(root);
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    try {
      if (!fs.statSync(current).isDirectory() || fs.readdirSync(current).length) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

/**
 * Removes what earlier guard records placed and the new ones no longer do.
 *
 * A hook document is never deleted outright: the guard's handler is taken out
 * and the rest is written back, because the file is the user's (Claude Code's
 * `settings.json`) or a bundle's (`policies`). It goes only when the guard
 * created it, nothing else is left in it, and no bundle record claims it. The
 * handler comes out even from a bundle-claimed document, since it is ours.
 *
 * Idempotent, so every plan sharing a destination may run it.
 */
export function retireGuard(
  destination: string,
  prior: InstallRecord[],
  next: InstallRecord[],
  claimedByBundles: Set<string>,
): void {
  const keep = new Set(next.flatMap((record) => record.files.map((file) => file.path)));
  for (const record of prior) {
    const document = hookDocumentPath(record.target);
    for (const file of record.files) {
      if (keep.has(file.path)) continue;
      const absolute = path.join(destination, file.path);
      if (file.path !== document) {
        if (claimedByBundles.has(file.path)) continue;
        removePath(absolute);
        pruneEmptyAncestors(destination, file.path);
        continue;
      }
      const current = readIfPresent(absolute);
      const parsed = current ? parseHookDocument(current) : undefined;
      if (!parsed) continue;
      const stripped = stripHookDocument(record.target, parsed);
      if (stripped.empty && record.hookDocument?.created && !claimedByBundles.has(file.path)) {
        removePath(absolute);
        pruneEmptyAncestors(destination, file.path);
      } else if (stripped.changed) {
        fs.writeFileSync(absolute, serializeHookDocument(stripped.document));
      }
    }
  }
}
