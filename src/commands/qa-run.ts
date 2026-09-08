import { CommandExit, terminate } from "../command-result.js";
import { BASE_FORMATS } from "../formats.js";
import { jsonPayload } from "../result.js";
import type { OutputFormat } from "../types.js";
import { UserError } from "../qa/config.js";
import { Harness } from "../qa/harness.js";
import { NO_CASES, buildRunOptions, printDryRun, type QaCliOptions } from "../qa/options.js";

export type { QaCliOptions as QaRunOptions };

function resolveFormat(opts: QaCliOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) {
    throw new Error(`Invalid output format: ${String(opts.format)}`);
  }
  if (opts.envelope && format !== "json") {
    throw new Error("--envelope requires --format json");
  }
  return format;
}

export async function qaRunAction(opts: QaCliOptions): Promise<void> {
  try {
    await qaRunBody(opts);
  } catch (error) {
    if (error instanceof CommandExit) throw error;
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      terminate(1);
    }
    throw error;
  }
}

async function qaRunBody(opts: QaCliOptions): Promise<void> {
  const format = resolveFormat(opts);
  const prepared = buildRunOptions(opts, format);

  if (prepared.options.dryRun) {
    const listing = printDryRun(prepared);
    if (format === "json") {
      process.stdout.write(
        jsonPayload(
          "qa run",
          {
            command: "run",
            ok: true,
            dryRun: true,
            repo: prepared.options.repo,
            runsDir: prepared.options.runsDir,
            cases: prepared.cases.map((kase) => ({
              name: kase.name,
              title: kase.title,
              agent: kase.agentName,
              model: kase.model,
              constraint: kase.constraint,
              pending: true,
            })),
          },
          opts,
        ),
      );
      return;
    }
    process.stdout.write(listing);
    return;
  }

  if (prepared.cases.length === 0) {
    if (format === "json") {
      process.stdout.write(
        jsonPayload(
          "qa run",
          {
            command: "run",
            ok: true,
            repo: prepared.options.repo,
            runsDir: prepared.options.runsDir,
            cases: [],
            message: NO_CASES,
          },
          opts,
        ),
      );
      return;
    }
    process.stdout.write(`${NO_CASES}\n`);
    return;
  }

  const harness = new Harness(prepared.options, prepared.cases, prepared.allCases);
  const harnessCode = await harness.main();
  const stats = harness.sessionStats();
  const failed = harnessCode !== 0;
  if (format === "json") {
    process.stdout.write(
      jsonPayload(
        "qa run",
        {
          command: "run",
          ok: !failed,
          repo: prepared.options.repo,
          runsDir: prepared.options.runsDir,
          runId: harness.sessionInfo.runId,
          cases: harness.sessionRecords.map((rec) => ({
            name: rec.name,
            model: rec.model,
            status: rec.status,
            exitCode: rec.exitCode,
            tools: rec.tools,
            usage: rec.usage,
            note: rec.note,
            sessionId: rec.sessionId,
            logDir: rec.logDir,
          })),
          summary: {
            ok: stats.ok,
            fail: stats.fail,
            skipped: stats.skipped,
            tools: stats.tools,
            usage: stats.usage,
          },
        },
        opts,
        { ok: !failed, exitCode: failed ? 2 : 0 },
      ),
    );
  }
  if (failed) terminate(2);
}
