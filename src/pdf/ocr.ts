import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PdfOcrWord } from "./types.js";

/**
 * Optical character recognition through the `tesseract` binary.
 *
 * The engine is the installed Tesseract executable, spawned with a fixed argv
 * and no shell, reading a PNG on stdin and writing TSV on stdout. It was chosen
 * over `tesseract.js` because the WebAssembly build fetches its language data
 * from a CDN by default, weighs tens of megabytes before any language data, and
 * would make cairn the distributor of trained models; the binary uses the
 * language data its own package manager installed, and nothing here touches the
 * network.
 *
 * Determinism: `OMP_THREAD_LIMIT=1` is set, because Tesseract's OpenMP builds
 * can otherwise vary in the last digit of a confidence between runs. The same
 * Tesseract version and language data give the same words and boxes.
 */

export class OcrUnavailable extends Error {
  constructor(
    readonly code: "engine" | "language",
    message: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = "OcrUnavailable";
  }
}

export interface OcrEngine {
  /** Absolute path of the executable that ran. */
  binary: string;
  version: string;
  /** The language data directory Tesseract reported. */
  tessdata: string | null;
  languages: string[];
}

export interface OcrSettings {
  /** An explicit executable; otherwise `tesseract` is found on PATH. */
  binary?: string;
  /** An explicit language data directory, passed as `--tessdata-dir`. */
  tessdata?: string;
}

const INSTALL_HINT =
  "Install Tesseract and its English data: `brew install tesseract` (macOS), " +
  "`apt install tesseract-ocr tesseract-ocr-eng` (Debian/Ubuntu), or `dnf install tesseract` (Fedora); " +
  "or name the executable with --tesseract.";

/** Finds an executable on PATH without a shell. */
function onPath(command: string): string | null {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of directories)
    for (const suffix of suffixes) {
      const candidate = path.join(directory, command + suffix);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
  return null;
}

function run(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) reject(error);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const LANGUAGE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

/**
 * Locates the engine and confirms the requested languages are installed.
 *
 * Both failures are reported before any page is rendered: a missing engine or
 * missing language data is a property of the machine, not of the document.
 */
export async function locateEngine(
  settings: OcrSettings,
  language: string,
  timeoutMs: number,
): Promise<OcrEngine> {
  if (!LANGUAGE.test(language))
    throw new OcrUnavailable(
      "language",
      `Invalid --lang value: ${language}`,
      "Use a Tesseract language code such as eng, or eng+deu.",
    );
  const binary = settings.binary ? path.resolve(settings.binary) : onPath("tesseract");
  if (!binary || !fs.existsSync(binary))
    throw new OcrUnavailable(
      "engine",
      settings.binary
        ? `The OCR engine ${settings.binary} does not exist`
        : "The OCR engine (tesseract) is not installed or not on PATH",
      INSTALL_HINT,
    );

  let version = "unknown";
  try {
    const result = await run(binary, ["--version"], timeoutMs);
    const match = /tesseract\s+v?([0-9][^\s]*)/i.exec(`${result.stdout}\n${result.stderr}`);
    if (match) version = match[1];
  } catch (error) {
    throw new OcrUnavailable(
      "engine",
      `The OCR engine ${binary} could not be run: ${(error as Error).message}`,
      INSTALL_HINT,
    );
  }

  const listArgs = [
    "--list-langs",
    ...(settings.tessdata ? ["--tessdata-dir", settings.tessdata] : []),
  ];
  const listed = await run(binary, listArgs, timeoutMs).catch(() => ({ stdout: "", stderr: "" }));
  const text = `${listed.stdout}\n${listed.stderr}`;
  const dirMatch = /languages in "([^"]+)"/.exec(text);
  const languages = text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_]+$/.test(line))
    .sort();
  const tessdata = dirMatch ? dirMatch[1] : (settings.tessdata ?? null);
  const missing = language.split("+").filter((code) => !languages.includes(code));
  if (missing.length)
    throw new OcrUnavailable(
      "language",
      `Tesseract has no language data for ${missing.join(", ")}` +
        (tessdata ? ` in ${tessdata}` : ""),
      `Install the traineddata file (for example \`apt install tesseract-ocr-${missing[0]}\`, or copy ${missing[0]}.traineddata ` +
        "from github.com/tesseract-ocr/tessdata_fast into the data directory), or point --tessdata at a directory that has it.",
    );
  return { binary, version, tessdata, languages };
}

export interface RecognisedLine {
  block: number;
  words: {
    text: string;
    confidence: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }[];
}

/** Runs the engine over one PNG and returns its words, grouped into lines in reading order. */
export function recognise(
  engine: OcrEngine,
  settings: OcrSettings,
  png: Buffer,
  options: { language: string; dpi: number; timeoutMs: number },
): Promise<RecognisedLine[]> {
  const args = [
    "stdin",
    "stdout",
    "-l",
    options.language,
    "--dpi",
    String(options.dpi),
    "--psm",
    "3",
    ...(settings.tessdata ? ["--tessdata-dir", settings.tessdata] : []),
    "-c",
    "tessedit_create_tsv=1",
    "-c",
    "tessedit_create_txt=0",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(engine.binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new Error(`OCR exceeded the ${options.timeoutMs}ms remaining in the budget`));
      },
      Math.max(1, options.timeoutMs),
    );
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) child.kill("SIGKILL");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(err)
          .toString("utf8")
          .trim()
          .split(/\r?\n/)
          .slice(-2)
          .join(" ");
        reject(new Error(`tesseract exited with status ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(parseTsv(Buffer.concat(out).toString("utf8")));
    });
    child.stdin.on("error", () => {
      // The engine closed stdin early; its exit status says why.
    });
    child.stdin.end(png);
  });
}

/** Parses Tesseract's TSV: level-5 rows are words, keyed by block, paragraph, and line. */
export function parseTsv(tsv: string): RecognisedLine[] {
  const lines = new Map<string, RecognisedLine>();
  const order: string[] = [];
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const text = cells.slice(11).join("\t").trim();
    const confidence = Number(cells[10]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    const key = `${cells[1]}:${cells[2]}:${cells[3]}:${cells[4]}`;
    let line = lines.get(key);
    if (!line) {
      line = { block: Number(cells[2]), words: [] };
      lines.set(key, line);
      order.push(key);
    }
    line.words.push({
      text,
      confidence,
      left: Number(cells[6]),
      top: Number(cells[7]),
      width: Number(cells[8]),
      height: Number(cells[9]),
    });
  }
  return order.map((key) => lines.get(key)!);
}

/** One decimal place, never `-0`. */
export function r1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Turns recognised lines into page text, word boxes in user space, and a confidence.
 *
 * Confidence is the mean of the word confidences, weighted by each word's length,
 * so one confidently read paragraph is not outvoted by stray specks read as `.`.
 */
export function assemble(
  lines: RecognisedLine[],
  toUser: (x: number, y: number) => [number, number],
): { text: string; words: PdfOcrWord[]; confidence: number | null } {
  const words: PdfOcrWord[] = [];
  const parts: string[] = [];
  let previousBlock: number | null = null;
  let weighted = 0;
  let weight = 0;
  for (const line of lines) {
    if (previousBlock !== null && line.block !== previousBlock) parts.push("");
    previousBlock = line.block;
    parts.push(line.words.map((word) => word.text).join(" "));
    for (const word of line.words) {
      const a = toUser(word.left, word.top);
      const b = toUser(word.left + word.width, word.top + word.height);
      words.push({
        text: word.text,
        confidence: r1(word.confidence),
        box: [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
        ],
      });
      const length = [...word.text].length;
      weighted += word.confidence * length;
      weight += length;
    }
  }
  return { text: parts.join("\n"), words, confidence: weight ? r1(weighted / weight) : null };
}
