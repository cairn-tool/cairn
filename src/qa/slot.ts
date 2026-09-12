import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CYAN, DIM, RED, RESET, flatten, pyStrip } from "./format.js";
import { TRANSCRIPT_CAP } from "./config.js";
import type { Usage } from "./outcome.js";
import type { Case } from "./cases.js";
import type { QaEvent } from "./agents/types.js";

export type SlotStatus =
  "idle" | "run" | "ok" | "error" | "timeout" | "no-output" | "no-folder" | "skipped";

export class Slot {
  readonly index: number;
  case: Case | null = null;
  status: SlotStatus = "idle";
  startedMs: number | null = null;
  endedMs: number | null = null;
  tools = 0;
  currentTool = "";
  streamedBytes = 0;
  usage: Usage | null = null;
  sessionId = "";
  exitCode: number | null = null;
  note = "";
  thinking = "";
  transcript: string[] = [];
  logDir: string | null = null;

  private transcriptFd: number | null = null;

  constructor(index: number) {
    this.index = index;
  }

  reset(kase: Case | null, logDir: string | null = null): void {
    this.closeTranscript();
    this.case = kase;
    this.status = kase === null ? "idle" : "run";
    this.startedMs = kase ? performance.now() : null;
    this.endedMs = null;
    this.tools = 0;
    this.currentTool = "";
    this.streamedBytes = 0;
    this.usage = null;
    this.sessionId = "";
    this.exitCode = null;
    this.note = "";
    this.thinking = "";
    this.transcript = [];
    this.logDir = logDir;
    if (logDir !== null) {
      mkdirSync(logDir, { recursive: true });
      // Append + writeSync per line: a SIGKILLed harness must leave a complete transcript.
      this.transcriptFd = openSync(join(logDir, "transcript.txt"), "a");
    }
  }

  closeTranscript(): void {
    if (this.transcriptFd === null) return;
    try {
      closeSync(this.transcriptFd);
    } catch {
      /* already gone */
    }
    this.transcriptFd = null;
  }

  add(line: string): void {
    const text = line.replace(/\n+$/, "");
    if (text === "") return;
    this.transcript.push(text);
    if (this.transcript.length > TRANSCRIPT_CAP) {
      this.transcript.splice(0, this.transcript.length - TRANSCRIPT_CAP);
    }
    if (this.transcriptFd !== null) {
      try {
        writeSync(this.transcriptFd, `${text}\n`);
      } catch {
        /* the log is best-effort; never take the run down for it */
      }
    }
  }

  elapsedSeconds(nowMs: number): number {
    if (this.startedMs === null) return 0;
    const end = this.endedMs ?? nowMs;
    return (end - this.startedMs) / 1000;
  }

  applyEvent(event: QaEvent): void {
    if (event.sessionId && !this.sessionId) this.sessionId = event.sessionId;

    if (event.kind === "thinking") {
      if (event.phase === "delta") {
        this.thinking += event.text ?? "";
      } else {
        const text = event.text ?? this.thinking;
        if (pyStrip(text) !== "") {
          this.add(`${DIM}> ${RESET}${flatten(text)}`);
        }
        this.thinking = "";
      }
      return;
    }

    if (event.kind === "text") {
      this.add(`» ${flatten(event.text)}`);
      return;
    }

    if (event.kind === "tool") {
      const shown = `${event.name}  ${event.summary}`.replace(/[ \t\n\r\v\f]+$/, "");
      if (event.phase === "started") {
        this.tools += 1;
        this.currentTool = shown;
        this.add(`${CYAN}! ${RESET}${shown}`);
      } else {
        this.currentTool = "";
        if (event.failed) this.add(`${RED}x ${RESET}${shown}`);
      }
      return;
    }

    if (event.kind === "usage") {
      this.usage = event.usage;
      if (event.error) this.note = flatten(event.error).slice(0, 160);
      return;
    }

    if (event.kind === "error") {
      this.note = flatten(event.error).slice(0, 160);
      return;
    }

    if (event.kind === "init" && event.model) {
      this.add(`${DIM}model ${event.model}${RESET}`);
    }
  }
}
