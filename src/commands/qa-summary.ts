import { CommandExit, terminate } from "../command-result.js";
import { BASE_FORMATS } from "../formats.js";
import { jsonPayload } from "../result.js";
import type { OutputFormat } from "../types.js";
import { UserError } from "../qa/config.js";
import { resolveRunsDir } from "../qa/options.js";
import { writeCaseTracker } from "../qa/tracker.js";

export interface QaSummaryOptions {
  format?: string;
  envelope?: boolean;
  runsDir?: string;
}

function resolveFormat(opts: QaSummaryOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) {
    throw new Error(`Invalid output format: ${String(opts.format)}`);
  }
  if (opts.envelope && format !== "json") {
    throw new Error("--envelope requires --format json");
  }
  return format;
}

export async function qaSummaryAction(opts: QaSummaryOptions): Promise<void> {
  try {
    const format = resolveFormat(opts);
    const runs = resolveRunsDir(opts.runsDir);
    const { path, planned, run } = writeCaseTracker(runs);
    if (format === "json") {
      process.stdout.write(
        jsonPayload("qa summary", { command: "summary", ok: true, path, planned, run }, opts),
      );
      return;
    }
    process.stdout.write(`${path}\n${planned} case(s) planned, ${run} run.\n`);
  } catch (error) {
    if (error instanceof CommandExit) throw error;
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      terminate(1);
    }
    throw error;
  }
}
