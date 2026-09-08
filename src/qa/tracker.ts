import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPORT, RESULTS } from "./config.js";
import { caseNameOf, loadCaseFiles } from "./casefile.js";

const PLAN = "plan";
const REPORT_SECTIONS = ["1", "2", "3", "4", "5", "6", "7"];
const RESULTS_SECTIONS = ["1", "2", "3", "4", "5"];

export interface CaseAudit {
  has: Record<string, boolean>;
  artifacts: number;
  notes: string[];
  verdict: string;
  passed: number;
  failed: number;
  total: number;
  ticked: number;
  unticked: number;
  fidelity: string;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const readText = (path: string): string => readFileSync(path, "utf8");

const tryReadText = (path: string): string => {
  try {
    return readText(path);
  } catch {
    return "";
  }
};

/** Python's repr() for a list of plain strings: ['1', '2'] */
function pyListRepr(items: readonly string[]): string {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}

/** Python: str.count(sub) — non-overlapping occurrences. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The verbatim body of the fenced block under a `## Script <name>` heading. */
export function sourceScript(scripts: string, name: string): string | null {
  let text: string;
  try {
    text = readText(scripts);
  } catch {
    return null;
  }
  const heading = new RegExp(`^## Script ${escapeRe(name)}\\b.*$`, "m").exec(text);
  if (!heading) return null;
  const rest = text.slice(heading.index + heading[0].length);
  const fence = /^```\n([\s\S]*?)^```/m.exec(rest);
  return fence ? pyStripAll(fence[1]!) : null;
}

/** Python's str.strip() with its wider whitespace set. */
function pyStripAll(text: string): string {
  /* eslint-disable no-control-regex */
  return text.replace(/^[\s\x1c-\x1f\x85]+/u, "").replace(/[\s\x1c-\x1f\x85]+$/u, "");
  /* eslint-enable no-control-regex */
}

/** The case's title and priority as the index states them. */
export function indexRow(tc: number, indexText: string): [string, string] {
  if (!indexText) return ["", ""];
  const re = /^- (?:⚠️ )?\*\*TC-(\d+)\*\* — (.+?) — \*\*([^*]+)\*\* — /gm;
  for (const match of indexText.matchAll(re)) {
    if (Number.parseInt(match[1]!, 10) === tc) {
      return [pyStripAll(match[2]!), pyStripAll(match[3]!)];
    }
  }
  return ["", ""];
}

/** The body of `## <number>. …` up to `## <following>.`, or "" when absent. */
export function section(text: string, number: string, following: string): string {
  const head = `## ${number}.`;
  if (!text.includes(head)) return "";
  const after = text.slice(text.indexOf(head) + head.length);
  const tail = `## ${following}.`;
  const cut = after.indexOf(tail);
  return cut === -1 ? after : after.slice(0, cut);
}

/** The Verdict column only. A tick elsewhere in the row is prose, not a result. */
export function rowVerdict(row: string): string {
  const trimmed = pyStripAll(row).replace(/^\|+/, "").replace(/\|+$/, "");
  const cells = trimmed.split("|").map(pyStripAll);
  return cells.length > 0 ? cells[cells.length - 1]! : "";
}

function findAll(re: RegExp, text: string, group = 1): string[] {
  return [...text.matchAll(re)].map((m) => m[group] ?? "");
}

/** Whether the executed script matches its documented source, and how it differs if not. */
export function scriptFidelity(
  folder: string,
  files: ReadonlySet<string>,
  scripts: string | null,
): [string, string] {
  if (scripts === null || !isFile(scripts)) return ["n/a", ""];
  for (const name of [...files].sort()) {
    const stem = /^input-script-(s\d+)\.txt$/.exec(name);
    if (!stem) continue;
    const expected = sourceScript(scripts, stem[1]!.toUpperCase());
    const actual = pyStripAll(readText(join(folder, name)));
    if (expected !== null && actual === expected) return ["identical", ""];
    const here = new Set(findAll(/^Scenario\[([^\]]+)\]/gm, actual));
    const there = new Set(findAll(/^Scenario\[([^\]]+)\]/gm, expected ?? ""));
    const added = [...there]
      .filter((n) => !here.has(n))
      .map((n) => n.split(" -")[0]!)
      .sort();
    const removed = [...here]
      .filter((n) => !there.has(n))
      .map((n) => n.split(" -")[0]!)
      .sort();
    const parts: string[] = [];
    if (added.length > 0) parts.push(`source has since added ${added.join(", ")}`);
    if (removed.length > 0) parts.push(`run had scenarios now absent: ${removed.join(", ")}`);
    return ["differs", parts.join("; ") || "same scenarios, body text changed"];
  }
  return ["n/a", ""];
}

/** Python: int(name.split("-")[1].removesuffix(".md")) */
export function caseNumber(name: string): number {
  const part = (name.split("-")[1] ?? "").replace(/\.md$/, "");
  const n = Number.parseInt(part, 10);
  if (!/^[+-]?\d+$/.test(part.trim())) {
    throw new Error(`invalid literal for int() with base 10: '${part}'`);
  }
  return n;
}

/** Everything the tracker knows about one case, whether or not it has been run. */
export function audit(
  tc: number,
  runs: string,
  scripts: string | null,
  planFile: string | null = null,
): CaseAudit {
  const folder = join(runs, `tc-${tc}`);
  const files = new Set<string>(
    isDir(folder) ? readdirSync(folder).filter((f) => !f.startsWith("_")) : [],
  );
  const has: Record<string, boolean> = {
    [PLAN]: planFile !== null,
    [REPORT]: isFile(join(folder, REPORT)),
    [RESULTS]: isFile(join(folder, RESULTS)),
  };

  const out: CaseAudit = {
    has,
    artifacts: files.size,
    notes: [],
    verdict: "— not run",
    passed: 0,
    failed: 0,
    total: 0,
    ticked: 0,
    unticked: 0,
    fidelity: "n/a",
  };

  const [fidelity, drift] = scriptFidelity(folder, files, scripts);
  out.fidelity = fidelity;
  if (fidelity === "differs") {
    out.notes.push(
      `executed a script that is not byte-identical to the current source (${drift}). Either the ` +
        "source was edited after the run, or the run did not execute the documented script — re-run " +
        "the case to resolve which",
    );
  }

  if (!has[PLAN]) {
    out.notes.push(
      `has a \`tc-${tc}/\` folder but no \`_plans/tc-${tc}.yaml\` — a run with no execution plan`,
    );
  }
  if (has[REPORT] !== has[RESULTS]) {
    const [present, absent] = has[REPORT] ? [REPORT, RESULTS] : [RESULTS, REPORT];
    out.notes.push(`has \`${present}\` but no \`${absent}\` — an incomplete run record`);
  }

  if (has[REPORT]) {
    const report = readText(join(folder, REPORT));
    const found = findAll(/^## (\d+)\. /gm, report).slice(0, 7);
    if (found.join("\u0000") !== REPORT_SECTIONS.join("\u0000")) {
      out.notes.push(`\`${REPORT}\` does not carry its seven sections: ${pyListRepr(found)}`);
    }
  }

  if (!has[RESULTS]) return out;

  const results = readText(join(folder, RESULTS));

  const found = findAll(/^## (\d+)\. /gm, results).slice(0, 5);
  if (found.join("\u0000") !== RESULTS_SECTIONS.join("\u0000")) {
    out.notes.push(`\`${RESULTS}\` does not carry its five sections: ${pyListRepr(found)}`);
  }
  if (!results.includes("## Outcome")) {
    out.notes.push(`\`${RESULTS}\` carries no \`## Outcome\` block — the verdict is buried`);
  }

  const verdictBody = section(results, "4", "5");
  out.verdict =
    (["PASS", "FAIL", "UNVERIFIED"] as const).find((v) =>
      new RegExp(String.raw`^\*\*${v}\*\*`, "m").test(verdictBody),
    ) ?? "??";
  if (out.verdict === "??") {
    out.notes.push(`\`${RESULTS}\` §4 states no verdict this script can read`);
  }

  const expectedBody = section(results, "1", "2");
  const rows = expectedBody.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  out.passed = rows.filter((r) => rowVerdict(r).includes("✅")).length;
  out.failed = rows.filter((r) => rowVerdict(r).includes("❌")).length;
  out.total = rows.length;
  if (out.total === 0) {
    out.notes.push(`\`${RESULTS}\` §1 carries no expected-result rows`);
  }

  out.ticked = countOccurrences(results, "- [x]");
  out.unticked = countOccurrences(results, "- [ ]");
  if (out.unticked) {
    out.notes.push(`leaves ${out.unticked} attestation(s) unticked — see its §5`);
  }

  // Python's \w is Unicode-aware for str; JS \w is ASCII-only, hence the explicit classes.
  const citedRaw = new Set(
    findAll(/`([0-9]{2}-[\p{L}\p{N}_./-]+|input-[\p{L}\p{N}_.-]+)`/gu, expectedBody),
  );
  const cited = new Set(
    [...citedRaw].filter((c) => !c.endsWith(".md")).map((c) => c.replace(/\/+$/, "")),
  );
  const missing = [...cited].filter((c) => !files.has(c)).sort();
  if (missing.length > 0) {
    out.notes.push(`cites artifacts that are not on disk: ${missing.join(", ")}`);
  }

  let outcome = "";
  if (results.includes("## Outcome")) {
    const after = results.slice(results.indexOf("## Outcome") + "## Outcome".length);
    const cut = after.indexOf("## 1.");
    outcome = cut === -1 ? after : after.slice(0, cut);
  }
  const lead = /\|\s*\*\*Verdict\*\*\s*\|\s*([A-Z]+)/.exec(outcome);
  if (lead && lead[1] !== out.verdict) {
    out.notes.push(`\`## Outcome\` claims **${lead[1]}** but §4 states **${out.verdict}**`);
  }
  const tally = /\|\s*\*\*Expected results\*\*\s*\|\s*(\d+)\s+of\s+(\d+)/.exec(outcome);
  if (tally) {
    const claimed = Number.parseInt(tally[1]!, 10);
    const claimedTotal = Number.parseInt(tally[2]!, 10);
    if (claimed !== out.passed || claimedTotal !== out.total) {
      out.notes.push(
        `\`## Outcome\` claims ${tally[1]} of ${tally[2]} confirmed but §1 shows ` +
          `${out.passed} of ${out.total}`,
      );
    }
  }
  if (out.failed && /\|\s*\*\*Failures\*\*\s*\|\s*None\s*\|/i.test(outcome)) {
    out.notes.push(`\`## Outcome\` says no failures but §1 carries ${out.failed} ❌ row(s)`);
  }

  return out;
}

/** Python: date.today().isoformat() — LOCAL date. toISOString() would be UTC and can be a day off. */
export function todayIso(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface TrackerResult {
  path: string;
  planned: number;
  run: number;
  tally: Record<string, number>;
}

/** Write `<runs_dir>/summary.md`, re-deriving every column from the files on disk. */
export function writeCaseTracker(runsDir: string): TrackerResult {
  const runs = runsDir;
  const plans = join(runs, "_plans");
  const root = dirname(runs);
  const scriptsPath = join(root, "qa-test-steps", "01-scenario-scripts.md");
  const scripts = isFile(scriptsPath) ? scriptsPath : null;
  const indexPath = join(root, "qa-testing.md");
  const indexText = isFile(indexPath) ? tryReadText(indexPath) : "";

  // Case files are `_plans/tc-<N>.yaml`. Scan the directory rather than the loader's output so a
  // case with a broken YAML still earns a row and a flag instead of vanishing from the tracker.
  const planned = new Set<number>();
  const planFiles = new Map<number, string>();
  if (isDir(plans)) {
    for (const entry of readdirSync(plans).sort()) {
      const name = caseNameOf(entry);
      if (name === null || !isFile(join(plans, entry))) continue;
      const n = caseNumber(name);
      planned.add(n);
      if (!planFiles.has(n)) planFiles.set(n, entry);
    }
  }
  // Titles come from the case files themselves when they parse; ../qa-testing.md is the fallback.
  const loaded = loadCaseFiles(plans);
  const titles = new Map<number, string>(loaded.cases.map((c) => [c.number, c.title]));
  const orphaned = new Set<number>();
  for (const entry of readdirSync(runs)) {
    if (/^tc-\d+$/.test(entry) && isDir(join(runs, entry))) {
      const n = caseNumber(entry);
      if (!planned.has(n)) orphaned.add(n);
    }
  }
  const cases = [...new Set([...planned, ...orphaned])].sort((a, b) => a - b);

  const audits = new Map<number, CaseAudit>(
    cases.map((tc) => [tc, audit(tc, runs, scripts, planFiles.get(tc) ?? null)]),
  );
  const run = cases.filter((tc) => audits.get(tc)!.has[RESULTS]);

  const lines: string[] = [
    "# Test case tracker",
    "",
    "Every test case with an execution plan under `_plans/`, one row per case —",
    "planned, in progress and complete alike.",
    "",
    "> **Generated — do not edit by hand.** Every column is re-derived from the case's own files by",
    "> `cairn qa`; a row cannot claim a verdict its `_results.md` does not carry. Regenerate it",
    "> with `cairn qa summary` after authoring plans, and after any batch of runs.",
    "",
    `Generated ${todayIso()} — **${cases.length} case(s) planned, ${run.length} run.**`,
    "",
    "| Case | Title | Priority | Verdict | Rows | Script | Attestations | Artifacts | 📋 | 📄 | 📊 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  const tally: Record<string, number> = {};
  // A case file the loader rejected is still a planned case; flag it rather than dropping it.
  const notes: string[] = loaded.errors.map((e) => `- ${e}`);
  const MARKS: Record<string, string> = {
    PASS: "✅ PASS",
    FAIL: "❌ FAIL",
    UNVERIFIED: "⚠️ UNVERIFIED",
  };

  for (const tc of cases) {
    const [indexTitle, priority] = indexRow(tc, indexText);
    const title = titles.get(tc) ?? indexTitle;
    const a = audits.get(tc)!;
    tally[a.verdict] = (tally[a.verdict] ?? 0) + 1;

    const mark = MARKS[a.verdict] ?? a.verdict;
    let rows: string;
    let attest: string;
    let artifacts: string;
    if (a.has[RESULTS]) {
      rows = `${a.passed}/${a.total}` + (a.failed ? ` (${a.failed} failed)` : "");
      attest = `${a.ticked}/${a.ticked + a.unticked}` + (a.unticked ? " ⚠️" : "");
      artifacts = String(a.artifacts);
    } else {
      rows = "—";
      attest = "—";
      artifacts = "—";
    }

    const link = (name: string, icon: string): string => {
      if (!a.has[name]) return "—";
      const target =
        name === PLAN ? `./_plans/${planFiles.get(tc) ?? `tc-${tc}.yaml`}` : `./tc-${tc}/${name}`;
      return `[${icon}](${target})`;
    };

    lines.push(
      `| **TC-${tc}** | ${title} | ${priority} | ${mark} | ${rows} | ${a.fidelity} | ` +
        `${attest} | ${artifacts} | ${link(PLAN, "📋")} | ${link(REPORT, "📄")} | ` +
        `${link(RESULTS, "📊")} |`,
    );

    for (const note of a.notes) notes.push(`- **TC-${tc}** ${note}`);
  }

  lines.push(
    "",
    "📋 `_plans/tc-<N>.yaml` — the case file  ·  " +
      "📄 `_report.md` — procedure and evidence  ·  " +
      "📊 `_results.md` — verdict and outcomes",
    "",
    "## Tally",
    "",
  );
  for (const verdict of ["PASS", "FAIL", "UNVERIFIED", "??", "— not run"]) {
    if (verdict in tally) {
      const label = verdict === "— not run" ? "Not yet run" : verdict;
      lines.push(`- **${label}:** ${tally[verdict]}`);
    }
  }

  lines.push("", "## Flags", "");
  if (notes.length > 0) {
    lines.push(...notes);
  } else {
    lines.push(
      "- None. Every case carries a plan; every run record carries its sections, cites " +
        "only artifacts that exist, agrees with its own `## Outcome` block, ticks every " +
        "attestation, and ran a script identical to its source.",
    );
  }
  lines.push("");

  const path = join(runs, "summary.md");
  writeFileSync(path, lines.join("\n"), "utf8");
  return { path, planned: cases.length, run: run.length, tally };
}
