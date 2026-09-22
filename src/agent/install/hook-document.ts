import { profileFor } from "../targets/index.js";
import type { AgentTarget } from "../types.js";

/**
 * The edit guard's registration in a host's *project-level* hook document.
 *
 * Claude Code reads project hooks from `.claude/settings.json`, which is also
 * where a user keeps `permissions` and hooks of their own; Cursor reads them
 * from `.cursor/hooks.json`, which is also where the `policies` writer puts a
 * bundle's override. Neither file is cairn's to overwrite, so this module never
 * serializes a whole document from scratch: it takes whatever is there, puts
 * one handler in, or takes that one handler out, and leaves every other byte of
 * meaning alone.
 *
 * The handler is found by its command, not by position, and is replaced *in
 * place* when found. Remove-then-append would move cairn's entry below one the
 * user added after it, and the bytes would then never settle: every
 * `agent install --check` and every `agent verify` would report the document
 * as drifted.
 *
 * The document's shape -- envelope, nesting, native event name -- is the same
 * `HookProfile` data the renderer reads for a bundle's own hooks, so a host is
 * described once.
 */

/** The generated guard script, at the destination root beside the manifest. */
export const GUARD_SCRIPT = ".cairn-guard.sh";

/** The tools whose calls write a file, in the matcher form Claude Code reads. */
export const GUARD_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

/** Seconds. The script itself forks nothing on the allow path and takes milliseconds. */
export const GUARD_TIMEOUT = 10;

/** The name guard records carry; a leading dot is not a legal bundle name. */
export const GUARD_RECORD_NAME = ".cairn-guard";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The command the hook document runs, in the host's own spelling of the project
 * root. A root that is a variable is quoted, because it is a path.
 */
export function guardCommand(target: AgentTarget): string {
  const root = profileFor(target).placeholders.bundleRoot.project;
  const spelled = root.includes("$") ? `"${root}"` : root;
  return `${spelled}/${GUARD_SCRIPT}`;
}

/** The document the target registers project hooks in, or `null`. */
export function hookDocumentPath(target: AgentTarget): string | null {
  return profileFor(target).paths.project.hooksFile;
}

function isGuardCommand(value: unknown): boolean {
  return typeof value === "string" && value.endsWith(`/${GUARD_SCRIPT}`);
}

function nested(target: AgentTarget): boolean {
  const hooks = profileFor(target).hooks;
  return (
    hooks.handlerShape === "claude-nested" ||
    (hooks.handlerShape === "nested-for-matcher-events" &&
      hooks.matcherEvents.includes("pre-tool-use"))
  );
}

/** True when `entry` is the guard's handler, in either handler shape. */
function isGuardHandler(entry: unknown, target: AgentTarget): boolean {
  if (!isObject(entry)) return false;
  if (!nested(target)) return isGuardCommand(entry.command);
  return (
    Array.isArray(entry.hooks) &&
    entry.hooks.some((hook) => isObject(hook) && isGuardCommand(hook.command))
  );
}

function guardHandler(target: AgentTarget): JsonObject {
  const command = guardCommand(target);
  if (!nested(target)) return { matcher: GUARD_MATCHER, command, timeout: GUARD_TIMEOUT };
  return { matcher: GUARD_MATCHER, hooks: [{ type: "command", command, timeout: GUARD_TIMEOUT }] };
}

/** The key under which the event lists live, per the envelope. */
function containerKey(target: AgentTarget): string {
  return profileFor(target).hooks.envelope === "named" ? GUARD_RECORD_NAME : "hooks";
}

function nativeEvent(target: AgentTarget): string {
  const event = profileFor(target).hooks.events["pre-tool-use"];
  if (!event) throw new Error(`${target} maps no native event for pre-tool-use`);
  return event;
}

/** Deep copy of plain JSON. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `base` with the guard's handler present exactly once. Everything else in the
 * document is preserved; a `versioned` envelope gains `version: 1` only when it
 * has no version at all.
 */
export function composeHookDocument(target: AgentTarget, base: JsonObject): JsonObject {
  const document = clone(base);
  if (profileFor(target).hooks.envelope === "versioned" && document.version === undefined)
    document.version = 1;
  const key = containerKey(target);
  if (!isObject(document[key])) document[key] = {};
  const container = document[key] as JsonObject;
  const event = nativeEvent(target);
  if (!Array.isArray(container[event])) container[event] = [];
  const list = container[event] as unknown[];
  const handler = guardHandler(target);
  const index = list.findIndex((entry) => isGuardHandler(entry, target));
  if (index === -1) list.push(handler);
  else list[index] = handler;
  return document;
}

/**
 * `base` without the guard's handler. `empty` is true when nothing but the
 * envelope's own `version` remains, which is the caller's cue that the file was
 * cairn's alone and may go.
 */
export function stripHookDocument(
  target: AgentTarget,
  base: JsonObject,
): { document: JsonObject; changed: boolean; empty: boolean } {
  const document = clone(base);
  const key = containerKey(target);
  const event = nativeEvent(target);
  let changed = false;
  if (isObject(document[key])) {
    const container = document[key] as JsonObject;
    if (Array.isArray(container[event])) {
      const kept = container[event].filter((entry) => !isGuardHandler(entry, target));
      if (kept.length !== container[event].length) {
        changed = true;
        if (kept.length) container[event] = kept;
        else delete container[event];
      }
    }
    if (changed && !Object.keys(container).length) delete document[key];
  }
  const empty = Object.keys(document).every((name) => name === "version");
  return { document, changed, empty };
}

/** The bytes a hook document is written with: the renderer's own `json()` form. */
export function serializeHookDocument(document: JsonObject): Buffer {
  return Buffer.from(JSON.stringify(document, null, 2) + "\n");
}

/** Parses a hook document, or `undefined` when the bytes are not a JSON object. */
export function parseHookDocument(content: Buffer): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(content.toString("utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
