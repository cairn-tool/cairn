/**
 * Progress reporting for a long archive run.
 *
 * A full run is tens of thousands of files and several gigabytes, and without
 * this it printed nothing at all until it finished. Two levels, because they
 * answer different questions:
 *
 * - the **transient line** answers "is it still going, and how far in" — it
 *   rewrites itself in place, so it belongs only on a terminal
 * - **verbose** answers "what exactly did it do to which file" — one durable
 *   line per artifact, so it is worth redirecting to a file and grepping later
 *
 * The transient line is gated the same way the update notifier is: stderr must
 * be a TTY, the format must not be machine-readable, and `CI` must be unset.
 * Those gates exist because a `\r`-rewritten line is corruption in a log file
 * and noise in a CI transcript. Verbose has no such gate — being redirectable is
 * the whole point of it.
 */

export type Disposition = "stored" | "duplicate" | "unchanged" | "skipped";

export interface FileEvent {
  path: string;
  class: string;
  size: number;
  disposition: Disposition;
  /** Absent for `unchanged`, which is decided without opening the file. */
  sha256?: string;
}

export interface SegmentEvent {
  name: string;
  bytes: number;
  blobs: number;
}

/** What `runArchive` reports as it goes. Every hook is optional. */
export interface RunReporter {
  start?(total: { files: number; bytes: number }): void;
  file?(event: FileEvent): void;
  segment?(event: SegmentEvent): void;
  failure?(event: { file: string; reason: string }): void;
  finish?(): void;
}

function formatBytes(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}B`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Trims a path to fit, keeping its end.
 *
 * From the left, because the tail of a path is what identifies it — the head is
 * a project root repeated on every line.
 */
function fitPath(text: string, width: number): string {
  if (width <= 1) return "";
  if (text.length <= width) return text;
  return `…${text.slice(text.length - width + 1)}`;
}

export interface ReporterOptions {
  /** Draw the transient status line. */
  progress: boolean;
  /** Emit one durable line per artifact. */
  verbose: boolean;
  stream?: NodeJS.WriteStream;
  now?: () => number;
}

/**
 * Decides whether the transient line may be drawn.
 *
 * Kept separate from the reporter so the command can report the decision, and
 * so the rule is testable without a terminal.
 */
export function progressAllowed(
  format: string,
  stream: NodeJS.WriteStream = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (format === "json") return false;
  if (env.CI) return false;
  return stream.isTTY === true;
}

export function createReporter(options: ReporterOptions): RunReporter {
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? (() => Date.now());
  // Verbose owns the terminal when both are on: a transient line would be
  // overwritten by the next verbose line and leave fragments behind.
  const drawLine = options.progress && !options.verbose;
  if (!drawLine && !options.verbose) return {};

  const started = now();
  let totalFiles = 0;
  let totalBytes = 0;
  let seenFiles = 0;
  let seenBytes = 0;
  let storedBytes = 0;
  let segments = 0;
  let lastDraw = 0;
  let dirty = false;

  const width = (): number => Math.max(40, Math.min(stream.columns ?? 100, 160));

  const clear = (): void => {
    if (dirty) {
      stream.write(`\r${" ".repeat(width() - 1)}\r`);
      dirty = false;
    }
  };

  const draw = (label: string, force = false): void => {
    if (!drawLine) return;
    const at = now();
    // Throttled: redrawing per file over 24k files is most of the work.
    if (!force && at - lastDraw < 100) return;
    lastDraw = at;
    const elapsed = at - started;
    const rate = elapsed > 0 ? (seenBytes / elapsed) * 1000 : 0;
    const percent = totalBytes > 0 ? Math.floor((seenBytes / totalBytes) * 100) : 0;
    const head =
      `  ${percent}% ${seenFiles}/${totalFiles} files · ` +
      `${formatBytes(seenBytes)}/${formatBytes(totalBytes)} · ` +
      `${segments} seg · ${formatBytes(rate)}/s · ${formatDuration(elapsed)} · `;
    // The counters survive a narrow terminal and the path gives way, rather than
    // the other way round: how far along it is matters more than which file.
    const room = width() - 1 - head.length;
    const line = room > 1 ? head + fitPath(label, room) : head.slice(0, width() - 1);
    stream.write(`\r${line}`);
    dirty = true;
  };

  return {
    start(total) {
      totalFiles = total.files;
      totalBytes = total.bytes;
      if (options.verbose) {
        stream.write(
          `archiving ${total.files} artifacts, ${formatBytes(total.bytes)} uncompressed\n`,
        );
      }
      draw("", true);
    },

    file(event) {
      seenFiles += 1;
      seenBytes += event.size;
      if (event.disposition === "stored") storedBytes += event.size;
      if (options.verbose) {
        const hash = event.sha256 ? event.sha256.slice(0, 12) : "-".repeat(12);
        stream.write(
          `${event.disposition.padEnd(9)} ${event.class.padEnd(10)} ` +
            `${formatBytes(event.size).padStart(8)}  ${hash}  ${event.path}\n`,
        );
      }
      draw(event.path);
    },

    segment(event) {
      segments += 1;
      if (options.verbose) {
        clear();
        stream.write(
          `sealed    ${event.name}  ${formatBytes(event.bytes)}  ${event.blobs} blobs\n`,
        );
      }
      draw("", true);
    },

    failure(event) {
      // Always durable, at either level: a file that could not be read is the
      // one thing in a run nobody should have to scroll back for.
      clear();
      stream.write(`unreadable ${event.file}: ${event.reason}\n`);
      draw("", true);
    },

    finish() {
      clear();
      if (options.verbose) {
        stream.write(
          `archived ${formatBytes(storedBytes)} of new content in ` +
            `${formatDuration(now() - started)}\n`,
        );
      }
    },
  };
}
