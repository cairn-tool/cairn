import { CommandExit, terminate } from "../command-result.js";
import { BASE_FORMATS } from "../formats.js";
import { jsonPayload } from "../result.js";
import type { OutputFormat } from "../types.js";
import { catalog } from "../qa/cases.js";
import { UserError } from "../qa/config.js";
import { defaultModels } from "../qa/agents/index.js";
import { caseStatus, resolveRunsDir } from "../qa/options.js";
import { resolveDir } from "../qa/config.js";

export interface QaListOptions {
  format?: string;
  envelope?: boolean;
  runsDir?: string;
  repo?: string;
}

function resolveFormat(opts: QaListOptions): OutputFormat {
  const format = (opts.format ?? "llm") as OutputFormat;
  if (!BASE_FORMATS.includes(format)) {
    throw new Error(`Invalid output format: ${String(opts.format)}`);
  }
  if (opts.envelope && format !== "json") {
    throw new Error("--envelope requires --format json");
  }
  return format;
}

export async function qaListAction(opts: QaListOptions): Promise<void> {
  try {
    const format = resolveFormat(opts);
    // --repo first: a relative --runs-dir resolves against it, matching `qa run`.
    const repo = opts.repo ? resolveDir(opts.repo, process.cwd(), "--repo") : undefined;
    const runs = resolveRunsDir(opts.runsDir, "--runs-dir", repo);
    const loaded = catalog(runs, repo ?? runs, defaultModels());
    if (loaded.errors.length > 0) {
      throw new UserError(
        `${loaded.errors.length} case file(s) could not be loaded:\n  ${loaded.errors.join("\n  ")}`,
      );
    }
    const cases = loaded.cases.map((kase) => ({
      name: kase.name,
      title: kase.title,
      agent: kase.agentName,
      model: kase.model,
      constraint: kase.constraint,
      status: caseStatus(kase),
    }));
    if (format === "json") {
      process.stdout.write(
        jsonPayload(
          "qa list",
          {
            command: "list",
            ok: true,
            runsDir: runs,
            cases,
            summary: {
              planned: cases.length,
              pending: cases.filter((kase) => kase.status === "pending").length,
              done: cases.filter((kase) => kase.status === "done").length,
            },
          },
          opts,
        ),
      );
      return;
    }
    if (cases.length === 0) {
      process.stdout.write("no cases under _plans/\n");
      return;
    }
    for (const kase of cases) {
      process.stdout.write(
        `${kase.name}  ${kase.status}  ${kase.agent}  ${kase.model}  ${kase.constraint}  ${kase.title}\n`,
      );
    }
  } catch (error) {
    if (error instanceof CommandExit) throw error;
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      terminate(1);
    }
    throw error;
  }
}
