#!/usr/bin/env node
// PreToolUse: refuse an edit to a file cairn generated.
//
// The decision is `cairn agent guard`'s, not this script's. Everything here is
// plumbing: read the host's event, pull out the path, ask, and write the answer
// back in the shape this host reads.
//
// Every failure of our own exits 0. `cairn` is a separate install, so its
// absence is a normal state rather than an error, and a guard that failed closed
// would block editing on any machine without it — far worse than the edit it
// prevents. Only an explicit refusal from `cairn agent guard` blocks.
import { spawnSync } from "node:child_process";
import { readSync } from "node:fs";

/** A hook event larger than this is not one a host wrote. */
const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * Tools whose call writes to a file.
 *
 * Checked here rather than relied on from the `matcher`, because Cursor's
 * handler shape is `flat` and drops it — without this the hook would ask about
 * every Bash command Cursor runs.
 */
const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "edit_file",
  "write_file",
  "create_file",
  "search_replace",
]);

/**
 * The whole of stdin, or `undefined`.
 *
 * Read in a loop rather than with `readFileSync(0)` because a host may hand us
 * a non-blocking pipe, where the first read raises `EAGAIN` before the event is
 * written. Bounded, so a stream that never ends cannot hold the edit open.
 */
function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  let total = 0;
  const deadline = Date.now() + 2000;
  while (total <= MAX_INPUT_BYTES) {
    let read;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EAGAIN" && Date.now() < deadline) {
        // A real sleep, not a spin: this runs before every write the assistant
        // makes, and busy-waiting a core for up to two seconds each time is not
        // a cost a hook gets to impose.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      if (error?.code === "EOF") break;
      return undefined;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
  }
  return total > MAX_INPUT_BYTES ? undefined : Buffer.concat(chunks).toString("utf8");
}

function readEvent() {
  const raw = readStdin();
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The tool name, under whichever key this host uses. */
function toolNameOf(event) {
  for (const key of ["tool_name", "toolName", "tool"]) {
    const value = event[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * The file the call writes.
 *
 * Probed across the shapes the hosts use rather than branching on which host
 * this is: they agree far more than they differ, and a host that spells it a
 * sixth way should make the hook do nothing rather than throw.
 */
function filePathOf(event) {
  const input =
    event.tool_input && typeof event.tool_input === "object"
      ? event.tool_input
      : event.toolInput && typeof event.toolInput === "object"
        ? event.toolInput
        : event;
  for (const key of ["file_path", "filePath", "notebook_path", "notebookPath", "path", "file"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * True when the event came from Cursor, which reads a JSON decision on stdout
 * and ignores the exit code. Claude Code and Codex both send `hook_event_name`.
 */
function isCursor(event) {
  if (typeof event.hook_event_name === "string") return false;
  return typeof event.conversation_id === "string" || Array.isArray(event.workspace_roots);
}

function main() {
  const event = readEvent();
  if (!event) return 0;

  const tool = toolNameOf(event);
  if (tool !== undefined && !WRITE_TOOLS.has(tool)) return 0;

  const file = filePathOf(event);
  if (!file) return 0;

  const result = spawnSync("cairn", ["agent", "guard", file, "--format", "json"], {
    encoding: "utf8",
    timeout: 5000,
    // The guard reads no stdin. Leaving it inherited would hand it the
    // remainder of the host's event.
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Not installed, killed by the timeout, or an invocation error: all normal.
  if (result.error || result.signal || result.status === null || result.status === 1) return 0;
  if (result.status !== 2) return 0;

  let message = "";
  try {
    message = JSON.parse(result.stdout)?.guard?.message ?? "";
  } catch {
    // The refusal is real even when its payload is not readable; say so plainly
    // rather than letting the edit through on a formatting problem.
  }
  if (!message) message = `Refusing to edit a cairn-generated file: ${file}`;

  if (isCursor(event)) {
    process.stdout.write(
      JSON.stringify({ permission: "deny", agentMessage: message, userMessage: message }),
    );
    return 0;
  }

  process.stderr.write(`${message}\n`);
  return 2;
}

process.exitCode = main();
