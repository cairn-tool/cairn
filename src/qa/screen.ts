import { writeSync } from "node:fs";
import { padClip } from "./format.js";
import { KeyDecoder } from "./keys.js";

const ENTER = "\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[H\x1b[2J";
const LEAVE = "\x1b[?7h\x1b[?25h\x1b[?1049l";

/** What Screen needs from the harness to act on a keypress. */
export interface KeyTarget {
  requestStop(): void;
  requestDrain(): void;
  togglePause(): void;
}

export class Screen {
  readonly enabled: boolean;
  mode: "panes" | "table" = "panes";
  /** The zoomed *slot id*, not a screen position — panes come and go as cases start and finish. */
  zoom: number | null = null;
  /** Slot ids currently on screen, in order, refreshed each frame. Digit `k` picks the k-th. */
  visibleSlots: readonly number[] = [];
  scroll = 0;
  page = 10;

  private entered = false;
  private restored = false;
  private stopKeys: (() => void) | null = null;

  constructor(enabled: boolean) {
    this.enabled = enabled && process.stdout.isTTY === true && process.stdin.isTTY === true;
  }

  enter(): void {
    if (!this.enabled || this.entered) return;
    this.entered = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // writeSync, not process.stdout.write: guaranteed to land even during teardown.
    writeSync(1, ENTER);
  }

  /** Idempotent, synchronous, safe to call from an exit handler. */
  restore(): void {
    if (!this.entered || this.restored) return;
    this.restored = true;
    this.stopKeys?.();
    this.stopKeys = null;
    try {
      writeSync(1, LEAVE);
    } catch {
      /* stdout already gone */
    }
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* not a tty any more */
    }
    // Not optional: a resumed TTY holds an active handle and the CLI would hang on exit.
    process.stdin.pause();
  }

  size(): [rows: number, cols: number] {
    return [process.stdout.rows || 24, process.stdout.columns || 80];
  }

  render(frame: readonly string[], rows: number, cols: number): void {
    if (!this.enabled) return;
    const shown = frame.slice(0, rows);
    const buf: string[] = ["\x1b[H"];
    const last = shown.length - 1;
    for (const [i, line] of shown.entries()) {
      buf.push(padClip(line, cols), "\x1b[K");
      if (i !== last) buf.push("\r\n");
    }
    if (shown.length < rows) buf.push("\x1b[J");
    process.stdout.write(buf.join(""));
  }

  /**
   * Read keys in raw mode. The 250 ms debounce replaces the Python's separate keyboard task:
   * a buffer still holding a lone ESC after that long is a real Escape keypress.
   */
  listen(target: KeyTarget, onKey?: () => void): void {
    if (!this.enabled || this.stopKeys) return;
    const decoder = new KeyDecoder();
    let timer: NodeJS.Timeout | undefined;

    const deliver = (keys: readonly string[]): void => {
      for (const key of keys) this.handleKey(key, target);
      if (keys.length > 0) onKey?.();
    };

    const onData = (chunk: Buffer): void => {
      if (timer) clearTimeout(timer);
      deliver(decoder.push(chunk.toString("utf8")));
      if (decoder.pending) {
        timer = setTimeout(() => deliver(decoder.flush()), 250);
        timer.unref();
      }
    };

    process.stdin.on("data", onData);
    this.stopKeys = (): void => {
      process.stdin.off("data", onData);
      if (timer) clearTimeout(timer);
    };
  }

  handleKey(key: string, target: KeyTarget): void {
    if (key === "q" || key === "Q" || key === "\x03") {
      target.requestStop();
      return;
    }
    if (key === "p" || key === "P") {
      target.togglePause();
      return;
    }
    if (key === "d" || key === "D") {
      target.requestDrain();
      return;
    }
    if (key === "r" || key === "R") {
      this.mode = this.mode === "table" ? "panes" : "table";
      return;
    }
    if (this.mode === "table") {
      if (key === "esc" || key === "0") this.mode = "panes";
      else if (key === "up") this.scroll -= 1;
      else if (key === "down") this.scroll += 1;
      else if (key === "pgup") this.scroll -= this.page;
      else if (key === "pgdn") this.scroll += this.page;
      else if (key === "home") this.scroll = 0;
      else if (key === "end") this.scroll = 10 ** 9;
      return;
    }
    if (key === "esc" || key === "0") {
      this.zoom = null;
    } else if (key.length === 1 && key >= "1" && key <= "9") {
      // The digit is the pane's position on screen, which is the number its header shows.
      const slot = this.visibleSlots[Number.parseInt(key, 10) - 1];
      if (slot !== undefined) this.zoom = this.zoom === slot ? null : slot;
    }
  }
}
