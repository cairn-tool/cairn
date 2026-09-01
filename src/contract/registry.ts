import { BASE_FORMATS, agentFormatsFor, formatsFor } from "../formats.js";
import { SARIF_SCHEMA_URI } from "./version.js";
import type { CommandContract, ExitCodeMeaning } from "./types.js";

const STRICT_NOTE =
  "A scan over thousands of transcripts routinely meets a file removed mid-walk or a truncated final line in a session still being appended to. Those are counted under `scan` and reported, never fatal, because failing by default would make the command useless in the automated context it is most wanted in. `--strict` is how a caller opts into exit 2.";

const OK = (meaning: string): ExitCodeMeaning => ({ code: 0, meaning });
const USAGE: ExitCodeMeaning = { code: 1, meaning: "Invocation, I/O, or configuration error" };
const FINDINGS = (meaning: string): ExitCodeMeaning => ({ code: 2, meaning });

/** A read-only `md` command whose payload always goes to stdout. */
function inspection(name: string, extra: Partial<CommandContract> = {}): CommandContract {
  return {
    id: `md ${name}`,
    formats: formatsFor(name),
    defaultFormat: "llm",
    formatConfigurable: true,
    outputSchema: null,
    exitCodes: [OK("Output written to stdout"), USAGE],
    stream: { success: "stdout" },
    writes: false,
    stability: "stable",
    ...extra,
  };
}

/** A `md` command that reports findings on stderr and exits 2. */
function diagnostic(
  name: string,
  findings: string,
  extra: Partial<CommandContract> = {},
): CommandContract {
  return {
    id: `md ${name}`,
    formats: formatsFor(name),
    defaultFormat: "llm",
    formatConfigurable: true,
    outputSchema: null,
    exitCodes: [OK("No findings"), USAGE, FINDINGS(findings)],
    stream: { success: "stdout", findings: "stderr" },
    writes: false,
    stability: "stable",
    ...extra,
  };
}

function agentCommand(name: string, extra: Partial<CommandContract> = {}): CommandContract {
  return {
    id: `agent ${name}`,
    formats: agentFormatsFor(name),
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "agent-result",
    exitCodes: [OK("No blocking findings"), USAGE, FINDINGS("Blocking findings")],
    stream: { success: "stdout", findings: "stdout" },
    writes: false,
    stability: "stable",
    notes: "All output goes to stdout, including the failure result for an invocation error.",
    ...extra,
  };
}

const AUTOMATION = { jsonlSchema: "diagnostic-record", sarifSchema: SARIF_SCHEMA_URI };

/**
 * A `usage` subcommand.
 *
 * Every one of them is read-only over logs outside the workspace, so `writes`
 * is false even for `usage index`, whose only effect is on its own private scan
 * cache. Exit `2` exists solely for `--strict`: see the note on the individual
 * entries.
 */
function usageCommand(name: string, extra: Partial<CommandContract> = {}): CommandContract {
  return {
    id: `usage ${name}`,
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "usage-rollup",
    exitCodes: [
      OK("Report written"),
      USAGE,
      FINDINGS("--strict was given and a transcript could not be fully read"),
    ],
    stream: { success: "stdout", findings: "stderr" },
    writes: false,
    stability: "experimental",
    ...extra,
  };
}

/**
 * A `jira adf` subcommand.
 *
 * The stream split is what makes these different from every `agent` subcommand:
 * the converted document owns stdout so it can be redirected, and findings go to
 * stderr. Declared per row in `notes` as well, because a consumer that guesses
 * wrong splices diagnostics into a document.
 */
function jiraAdfCommand(name: string, extra: Partial<CommandContract> = {}): CommandContract {
  return {
    id: `jira adf ${name}`,
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "adf-result",
    exitCodes: [OK("No blocking findings"), USAGE, FINDINGS("Blocking findings")],
    stream: { success: "stdout", findings: "stderr" },
    writes: false,
    stability: "experimental",
    ...extra,
  };
}

const CONTRACTS: CommandContract[] = [
  // Top level
  {
    id: "check-update",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "check-update",
    exitCodes: [
      OK("Already on the latest version"),
      { code: 1, meaning: "Could not reach the registry" },
      FINDINGS("A newer version is available"),
    ],
    stream: { success: "stdout", findings: "stderr" },
    writes: false,
    stability: "stable",
    notes:
      "Queries the registry directly rather than using the cache. An unreachable registry writes the error form to stderr; an available update writes the success form to stdout and exits 2.",
  },
  {
    id: "describe",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "describe",
    exitCodes: [
      OK("Description written to stdout"),
      { code: 1, meaning: "Unknown command path or invalid format" },
    ],
    stream: { success: "stdout" },
    writes: false,
    stability: "stable",
    notes: "Reports the static contract; project configuration is not applied.",
  },
  {
    id: "schema",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "schema-list",
    exitCodes: [
      OK("Schema or index written to stdout"),
      { code: 1, meaning: "Unknown schema id or invalid format" },
    ],
    stream: { success: "stdout" },
    writes: false,
    stability: "stable",
    notes:
      "With an id, the schema document is written regardless of --format; --format only affects the index listing.",
  },

  {
    id: "completion",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: null,
    exitCodes: [
      OK("Script written to stdout"),
      { code: 1, meaning: "Unknown shell or invalid format" },
    ],
    stream: { success: "stdout" },
    writes: false,
    stability: "stable",
    notes:
      "The shell script is written verbatim regardless of --format; the script is the payload, so there is no JSON form. It is generated from the same command walk describe uses, so it cannot drift from the real command tree, and it embeds that tree rather than calling back into the CLI, so completing costs no process spawn. Never writes to a shell profile. The update notice is suppressed, because the eval install idiom runs from an interactive rc file where stderr is a TTY.",
  },

  {
    id: "serve",
    // A protocol server has no output format: stdout is the JSON-RPC channel,
    // not a payload stream, so there is nothing for --format to select.
    formats: null,
    defaultFormat: null,
    formatConfigurable: false,
    outputSchema: null,
    exitCodes: [
      OK("The client closed the connection"),
      { code: 1, meaning: "Unknown protocol, unreadable root, or invalid configuration" },
    ],
    stream: { success: "stdout" },
    writes: false,
    stability: "experimental",
    notes:
      "Speaks the Model Context Protocol over stdio. stdout carries JSON-RPC frames rather than a payload, so --format is not accepted and no output schema applies; every diagnostic goes to stderr, which MCP treats as the server log. Tool arguments and results are described by each tool's own JSON Schema, retrieved through tools/list rather than through `schema`. Every tool is read-only and every path argument is confined to --root, resolved through symlinks; refactor tools are deliberately absent rather than gated. Configuration is discovered from --root, so a tool answers the same as the equivalent md command in that workspace. Unlike md index this never writes the workspace cache: the server keeps a bounded in-memory cache and leaves the on-disk index alone.",
  },

  // Jira
  jiraAdfCommand("to-markdown", {
    writes: true,
    notes:
      "The converted document owns stdout and diagnostics go to stderr, so the output can be redirected to a file without findings being spliced into it. This differs from every agent subcommand, which puts findings on stdout. Under --format json the payload carries both and goes to stdout instead, which means -fj is not the same output in JSON. Approximation is the expected outcome on almost every real document, so an approximate or unsupported finding blocks only under --strict; an error always blocks. ok:true therefore does not mean the conversion was lossless -- read diagnostics for that. Converts a bare ADF document only: it has no knowledge of the Jira REST response shape, and a whole issue response reports AD002 naming the field to extract. Emits no frontmatter, ever, and this is not an option: an ADF document carries no title, key, status, or author, so there is nothing to put there. --output writes one file atomically and suppresses the document on stdout.",
  }),
  jiraAdfCommand("from-markdown", {
    writes: true,
    notes:
      "The converted document owns stdout and diagnostics go to stderr, so the output can be redirected to a file without findings being spliced into it. This differs from every agent subcommand, which puts findings on stdout. Under --format json the payload carries both and goes to stdout instead, which means -fj is not the same output in JSON. Approximation is the expected outcome on almost every real document, so an approximate or unsupported finding blocks only under --strict; an error always blocks. ok:true therefore does not mean the conversion was lossless -- read diagnostics for that. Converts a bare ADF document only: it has no knowledge of the Jira REST response shape, and a whole issue response reports AD002 naming the field to extract. The default llm format already emits pure ADF JSON, so --format json wraps that document in the result envelope rather than changing its encoding; a consumer wanting the bare document uses the default. Frontmatter is metadata and is dropped with a finding rather than becoming body content. ADF validates per-node content and Markdown permits nestings it forbids, so an illegal nesting is flattened in place -- never lifted, which would move content past its neighbours -- and legal Markdown is never an error. --output writes one file atomically and suppresses the document on stdout.",
  }),
  jiraAdfCommand("validate", {
    notes:
      "Checks an ADF document against this tool's own content model: node nesting, required content, and the attribute constraints for headings, panels, task and decision lists, media, and text. It is not a wrapper around Atlassian's schema, which is a devDependency used only by the unit test that proves the two agree; a node type the model does not know reports AD100 rather than being judged. That is the same line agent test --native draws. An invalid document exits 2; an unknown node type does so only under --strict.",
  }),
  jiraAdfCommand("inspect", {
    notes:
      "Counts every node and mark type and rates each against the fidelity tables, so the cost of a conversion can be read before paying it. Reports no findings of its own and exits 0 unless the input could not be read or is not an ADF document. A type the content model does not know is listed as unsupported rather than omitted.",
  }),
  // Scripts
  {
    id: "scripts run",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "script-run",
    exitCodes: [
      OK("--format json: the script exited 0"),
      { code: 1, meaning: "Unresolvable name, refused boundary, or the script never started" },
      FINDINGS("--format json: the script exited non-zero or was killed by a signal"),
    ],
    exitCodePassthrough: {
      min: 0,
      max: 255,
      description:
        "In llm and human formats the script's own exit status is this process's exit status, verbatim; a script killed by a signal reports 128 + the signal number.",
    },
    stream: { success: "stdout", findings: "stdout" },
    writes: false,
    stability: "experimental",
    notes:
      "The only command that executes anything. In llm and human formats the child inherits all three streams and its exit status passes through unchanged, so a hook reads the real code and this command writes nothing of its own to stdout; `exitCodes` describes --format json, which captures the streams into the payload instead. A script that never started exits 1 rather than 2, so a typo in exec[0] stays distinguishable from a script that ran and failed. The payload goes to stdout in every outcome, including a failed script, so a consumer never has to switch streams. Resolution walks every .cairn.yml from the working directory to the repository root and the nearest definition of the name wins; files under node_modules are skipped, and running outside a Git repository is refused unless --root sets the boundary. Configuration cannot change what executes: scripts commands accept no `commands:` defaults. The update notice is suppressed, because the child owns the real stderr.",
  },
  {
    id: "scripts which",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "script-which",
    exitCodes: [OK("The name resolved"), USAGE, FINDINGS("No script by that name")],
    stream: { success: "stdout", findings: "stderr" },
    writes: false,
    stability: "experimental",
    notes:
      "Resolves without executing. Reports the winning registry, the working directory the script would run in, the same-named definitions it shadows, and every file the walk opened. An unreadable file nearer than the winner is an error rather than a skip, because it might have defined the name.",
  },
  {
    id: "scripts list",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "script-list",
    exitCodes: [
      OK("Listing written to stdout"),
      USAGE,
      FINDINGS("A consulted configuration file could not be read"),
    ],
    stream: { success: "stdout", findings: "stderr" },
    writes: false,
    stability: "experimental",
    notes:
      "One entry per visible name after nearest-definition-wins is applied; a shadowed definition is recorded on the winner rather than listed separately. Unlike `scripts which`, an unreadable file is reported and the listing still prints, because a listing that silently omitted a file would read as complete.",
  },

  // Usage
  {
    ...usageCommand("summary"),
    outputSchema: "usage-summary",
    notes:
      "Headline totals over the selection. Each provider is normalized onto one token model, which means undoing a different distortion in each: Claude Code writes one API response as several lines each carrying an identical copy of its usage; Codex reports a running total per thread rather than a per-request figure; Antigravity reports a per-request context size that is not a running total at all; Gemini CLI does all three at once, writing one turn several times under a single id while reporting a per-request context size that counts its cached prefix inside the input figure; Cursor is the one source needing no correction at all, and the one whose counters stop, having written real per-request figures only until December 2025 and zeroes since. `--provider all` merges every source that has logs on this machine. " +
      STRICT_NOTE,
  },
  usageCommand("tokens", {
    notes:
      "Rows are keyed by `--by`; time dimensions are ordered chronologically and everything else by token total. Cache writes report an authoritative total alongside a best-effort TTL split, which the oldest records do not carry. " +
      STRICT_NOTE,
  }),
  usageCommand("tools", {
    notes:
      "Counts tool-use blocks, including MCP. An MCP tool named `mcp__<server>__<tool>` is split into its server and tool halves rather than given a subcommand of its own; `--by server` and `--kind mcp` are how that surface is queried. " +
      STRICT_NOTE,
  }),
  usageCommand("sessions", {
    notes:
      "One row per session, with its subagent transcripts folded in. `--last n` selects the n most recently active sessions rather than the n most recent files, so a session's subagent spend is never silently dropped. " +
      STRICT_NOTE,
  }),
  usageCommand("projects", {
    notes:
      "Project identity is the working directory recorded inside the transcripts, not the log directory name, whose separator substitution is not reliably invertible. " +
      STRICT_NOTE,
  }),
  usageCommand("skills", {
    notes:
      "Skill invocations are counted from every surface that records one: the `Skill` tool, the invoked-skill attachments, and the slash-command form. " +
      STRICT_NOTE,
  }),
  usageCommand("agents", {
    notes:
      "Spawn counts come from the parent's subagent tool calls; token counts come from the subagent transcripts themselves. The parent's own tool result records only the subagent's final message and understates its real spend several-fold, so it is deliberately not used. `--by role` groups by the reusable agent type and `--by path` by the task-specific identifier, which only some providers record; under `--by path` the transcript count is the spawn count, because no per-path spawn record exists. " +
      STRICT_NOTE,
  }),
  usageCommand("hooks", {
    notes:
      "Keyed by `<Event>:<Tool>`. Stop hooks report through a session summary record rather than a per-execution one, and are counted there under `Stop`, so neither surface double-counts the other. " +
      STRICT_NOTE,
  }),
  usageCommand("commands", {
    notes:
      "Slash commands are not a field in the source logs; they are a marker block inside the user's message text, and are extracted from it. " +
      STRICT_NOTE,
  }),
  usageCommand("providers", {
    outputSchema: "usage-providers",
    exitCodes: [OK("Listing written"), USAGE],
    stream: { success: "stdout" },
    notes:
      "Lists every registered log source and what it can answer. A report a provider cannot serve is decided by reading these capabilities, never by branching on the provider name, which is what keeps adding a second LLM to one new module plus one registry line. A command whose capability no scanned provider has reports that and exits 0, because a provider that does not record something has not told you the count is zero.",
  }),
  usageCommand("index", {
    outputSchema: "usage-index",
    exitCodes: [OK("Status written, or the store was rebuilt or cleared"), USAGE],
    stream: { success: "stdout" },
    notes:
      "The store keys on each transcript's path, size, and modification time; transcripts are append-only, so an unchanged file cannot hold a record the stored aggregate is missing. One SQLite store under `XDG_DATA_HOME` holds every provider, which changes three things a consumer may have relied on and which are recorded here rather than quietly fixed: `shards` is always `0`, because the per-project JSON shard files it counted no longer exist; `removed` counts transcripts dropped by `--clear` rather than shard files deleted; and `bytes` is the whole store's size, reported identically on every `caches` entry rather than partitioned between them, so it is not summed into `cache`. `writes` stays false because nothing outside the store is touched.",
  }),
  usageCommand("import", {
    outputSchema: "usage-import",
    notes:
      "Populates the store that every other `usage` command reads. Reports import on first use, so this is never required; it exists to do that work deliberately, and to expose the counters without a report around them. Two grains are written: the day buckets every report reads, and per-occurrence event rows that no report reads but that answer what a day bucket cannot. " +
      STRICT_NOTE,
  }),
  usageCommand("migrate", {
    outputSchema: "usage-import",
    formats: BASE_FORMATS,
    exitCodes: [
      OK("Store is current, or was migrated"),
      { code: 1, meaning: "Invocation error, or the store is newer than this build understands" },
    ],
    stream: { success: "stdout" },
    notes:
      "The store's schema version is a fifth hand-owned version, and the first in this project that is migrated rather than discarded: after `archive run --include transcripts` has run and the source logs are pruned, the store may be the only record of that usage left, so a version bump has to carry the data forward. Every command that opens the store migrates it, so this is needed only to migrate deliberately or, with `--check`, to see what is pending first. A store written by a newer `cairn` is refused rather than opened, because writing to it could drop columns this build knows nothing about.",
  }),

  // Archive
  {
    id: "archive run",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "archive-result",
    exitCodes: [OK("Run completed"), USAGE],
    stream: { success: "stdout" },
    // The only writer in the toolset, and unlike `usage index` the directory it
    // writes to is durable storage the user chose, so claiming otherwise would
    // be misleading.
    writes: true,
    stability: "experimental",
    notes:
      "Archives what each provider declares in `src/archive/sets.ts` — an allowlist of directories, never a sweep of a home directory, so plugin payloads and build scratch cannot be picked up by accident. `plans` and `artifacts` are taken by default; `transcripts` and `logs` are opt-in through `--include` because they are three orders of magnitude larger. Incremental twice over: a file whose size and modification time match the index is never opened, and content already stored is never written again, so a file that merely changed path costs one row. A file whose content changes gets a new row against a new blob, so every version ever seen is kept. Unreadable files are counted under `run.failures` and never fatal, because over thousands of artifacts a file removed mid-walk is routine. Progress is reported on stderr and never on the payload stream: the transient line is drawn only when stderr is a TTY, the format is not `json`, and `CI` is unset, and `--verbose` writes one durable line per artifact. Neither affects the payload, so a consumer parsing stdout sees the same bytes either way.",
  },
  {
    id: "archive status",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "archive-listing",
    exitCodes: [OK("Status written"), USAGE],
    stream: { success: "stdout" },
    writes: false,
    stability: "experimental",
    notes:
      "Reports on an archive without opening a segment. `blobs` is distinct stored contents and `artifacts` counts every version of every path, so the two differ wherever files duplicate or change. `byClass[].bytes` sums each artifact row's content and therefore double-counts a blob shared between paths; the top-level `bytes` is the deduplicated figure.",
  },
  {
    id: "archive list",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "archive-listing",
    exitCodes: [OK("Listing written"), USAGE],
    stream: { success: "stdout" },
    writes: false,
    stability: "experimental",
    notes:
      "One row per archived path, newest first, with `versions` counting the contents held for it rather than listing them. `--top 0` returns everything. An absent archive lists nothing and exits 0, because having archived nothing yet is not an error.",
  },
  {
    id: "archive extract",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "archive-result",
    exitCodes: [OK("File written"), USAGE],
    stream: { success: "stdout" },
    writes: true,
    stability: "experimental",
    notes:
      "Takes an original path or a sha256 prefix. A path resolves to its newest version; a hash reaches any version. The content is re-hashed on the way out, so an archive whose index and bytes disagree reports that rather than handing back the wrong file. A prefix matching more than one blob is refused rather than resolved arbitrarily. `writes` is true: unlike the rest of the toolset this writes outside the archive, into `--out`.",
  },
  {
    id: "archive verify",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "archive-result",
    exitCodes: [
      OK("Archive matches its index"),
      USAGE,
      FINDINGS("The archive and its index disagree"),
    ],
    stream: { success: "stdout", findings: "stderr" },
    writes: false,
    stability: "experimental",
    notes:
      "Unlike every other `archive` and `usage` command, this exits 2 without `--strict`: corruption is the actionable finding it exists to report, not an incidental one. The default pass hashes each segment file; `--deep` also decompresses each and re-hashes every member, which additionally catches an index whose offsets no longer point where it claims. A segment whose own hash already fails is not opened further, since it can say nothing reliable about its members.",
  },
  {
    id: "archive migrate",
    formats: BASE_FORMATS,
    defaultFormat: "llm",
    formatConfigurable: false,
    outputSchema: "archive-result",
    exitCodes: [
      OK("Index is current, or was migrated"),
      { code: 1, meaning: "Invocation error, or the index is newer than this build understands" },
    ],
    stream: { success: "stdout" },
    writes: true,
    stability: "experimental",
    notes:
      "The archive index carries its own hand-owned schema version, separate from the usage store's, and is likewise migrated rather than discarded: it is the only map from an original path to the segment holding that file's bytes, and the segments themselves are append-only and never rewritten. Every command that opens the index migrates it, so this is needed only to migrate deliberately or, with `--check`, to see what is pending. An index written by a newer `cairn` is refused rather than opened.",
  },

  // Agent
  agentCommand("convert", {
    writes: true,
    exitCodes: [
      OK("Successful and lossless"),
      USAGE,
      FINDINGS("Validation, compatibility, strict, or stale-output finding"),
    ],
    notes:
      "All output goes to stdout, including failures. A non-strict conversion may write usable artifacts and still exit 2. --report writes the same document as conversion-report.json, provenance included, to an arbitrary path; it differs only in carrying the real dryRun and check values and in including `stale`, which the in-tree artifact is serialized too early to hold. It is written in every mode, including --dry-run, --check, and a strict failure, because an explicitly named path is a request for diagnostic output rather than a build artifact. It is never listed in `artifacts` and never compared by --check, and it is refused inside the source tree or the output directory, where it would read as drift.",
  }),
  agentCommand("validate"),
  agentCommand("inspect", {
    exitCodes: [OK("Bundle inspected"), USAGE, FINDINGS("Bundle findings")],
    notes:
      "All output goes to stdout, including the failure result for an invocation error. Without --target the payload is unchanged and `targets` stays empty. --target keeps a component that reaches any selected target, using the renderer's own selection predicate so inspect and convert cannot disagree, and reports the excluded names under `bundle.filter`. --profile drops sections no selected target emits into a selected profile, read from the target profiles rather than branched on the target name, and requires --target because profile support is a property of a target. The graph is pruned to the surviving components rather than left with dangling references.",
  }),
  agentCommand("compat"),
  agentCommand("doctor", {
    exitCodes: [
      OK("No blocking conformance findings"),
      USAGE,
      FINDINGS("Profile, drift, host, or strict finding"),
    ],
    notes:
      "All output goes to stdout. An approximate mapping alone does not fail doctor, unlike convert and validate.",
  }),
  agentCommand("init", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Bundle scaffolded, or dry run completed"),
      USAGE,
      FINDINGS("--check found a missing or differing scaffold"),
    ],
    notes:
      "Never prompts. Placeholder marketplace metadata is valid here; publish readiness is checked by agent package.",
  }),
  agentCommand("add", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Component added, or dry run completed"),
      USAGE,
      FINDINGS("--check found a missing or differing component"),
    ],
    notes:
      "agent-bundle.yaml is edited through a comment-preserving YAML document and is left byte-untouched when no manifest change is needed.",
  }),
  agentCommand("import", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Imported, or dry run completed"),
      USAGE,
      FINDINGS("Blocking finding, or --check found drift"),
    ],
    notes:
      "Approximate mappings alone do not fail import, unlike convert and validate, because approximation is the expected outcome of returning from a native format. A nonempty destination is refused unless --merge names a strategy.",
  }),
  agentCommand("upgrade", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Migrated, already current, or dry run completed"),
      USAGE,
      FINDINGS("--check found a bundle below the target schema, or a blocking finding"),
    ],
    notes:
      "Rewrites only agent-bundle.yaml. --to-schema is required rather than defaulting to the newest, so a CI result does not depend on the installed CLI version. Human-judgment notices (AB221) do not fail the command.",
  }),
  agentCommand("package", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Package written, or checks passed"),
      USAGE,
      FINDINGS("Publish-readiness, integrity, or stale finding"),
    ],
    notes:
      "Renders the bundle itself rather than trusting an existing tree; --from-dist only verifies one. Never contacts the network and never publishes. The package root is not an agent convert output root, so agent doctor --output must not be pointed at it.",
  }),
  agentCommand("marketplace", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Collection written, or checks passed"),
      USAGE,
      FINDINGS("Spec, publish-readiness, or stale finding"),
    ],
    notes:
      "Builds one aggregated catalog per target covering every bundle a collection spec names, rather than one catalog per bundle as agent package does. Renders every bundle itself, so a catalog can never certify a stale tree. Never contacts the network and never publishes. The collection root is not an agent convert output root, so agent doctor --output must not be pointed at it.",
  }),
  agentCommand("audit", {
    stability: "experimental",
    sarifSchema: SARIF_SCHEMA_URI,
    exitCodes: [OK("No blocking review findings"), USAGE, FINDINGS("Review findings")],
    notes:
      "All output goes to stdout, including the SARIF form and the failure result for an invocation error — unlike the md diagnostic commands, which route findings to stderr. The pass/fail rule is split by origin: a warning audit itself found is blocking, because almost every review finding is a warning by design, while a forwarded parse or render warning is not unless --strict says so. Exit 2 means findings to review, not proof that a bundle is malicious. --format sarif has no agent-result payload, so an invocation error under it prints plainly and exits 1.",
  }),
  agentCommand("test", {
    stability: "experimental",
    exitCodes: [
      OK("Every selected case passed"),
      USAGE,
      FINDINGS("A failing case, an invalid test file, or a warning under --strict"),
    ],
    notes:
      "Experimental because the test-file format may still change; it carries its own hand-owned schemaVersion, reported back as `test.schemaVersion`. Model-free by construction: expectations are evaluated against the same in-memory render agent convert would write, so no model is called, no host tooling is executed, and no file is written. `test.native` is reserved for evidence from a host's own validator and is always empty; agent specs publishes the validator commands to run yourself. An unmet expectation is an error, so unlike agent audit no per-code split is needed; a forwarded parse or render warning blocks only under --strict, and so does AB701, which reports that a bundle carried no test cases at all. An unknown --case name is a usage error rather than a run that selects nothing, so a typo in CI cannot read as a pass. --target and --profile intersect each case's own selection rather than widening it.",
  }),
  agentCommand("verify", {
    stability: "experimental",
    exitCodes: [
      OK("Every declared entry matches, and every pin is satisfied"),
      USAGE,
      FINDINGS("Drift, an orphaned file, or a violated pin"),
    ],
    notes:
      "Reads what to verify from the `agent.verify` block of a cairn configuration document rather than from flags, so CI runs it bare. Renders each declared bundle in memory through the same install planner agent install uses, so a verification is always derived from the bundle and never from a possibly-drifted tree. Pins are asserted against the running CLI \u2014 its version, PROFILE_SCHEMA_VERSION, and each target's documentationRevision \u2014 which together with byte equality prove the tree was produced by a cairn matching the pin, without requiring a provenance document to exist. Provenance found at a destination is reported as corroboration and never decides the verdict. The unmanaged walk is bounded to the directory prefixes the target profile declares and that the render actually populated; a wholly-literal declared path such as AGENTS.md or .mcp.json is compared by bytes and never walked, so pointing an entry at a repository root cannot enumerate the repository. Approximate render diagnostics do not fail verify, unlike convert and validate.",
  }),
  agentCommand("install", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Installed, or checks passed"),
      USAGE,
      FINDINGS("Install finding, or --check found drift"),
    ],
    notes:
      "Renders and packages in memory rather than trusting a dist tree, so an install is always derived from the bundle. Destinations come from the target profiles. --register is the only flag that edits host config, and only the marketplace layout needs it. Approximate render diagnostics do not fail install, unlike convert and validate. --target is repeatable and one destination may hold several installs, told apart by bundle, target, profile and scope in the manifest; occupancy is asked per path, so a destination is not occupied merely because a different bundle is recorded there. A run is planned in full before anything is written and a blocked plan writes nothing at all. --config installs the agent.install block a repository declares, and --target narrows that block rather than adding to it. Because a run may write to several destinations, artifacts[].path is not unique across the payload: two plans legitimately write the same relative path to different roots, and the artifact row shape is shared by every agent command rather than carrying a destination for this one caller.",
  }),
  agentCommand("uninstall", {
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Removed, already absent under --check, or dry run completed"),
      USAGE,
      FINDINGS("Manifest missing or malformed, or --check found the install still present"),
    ],
    notes:
      "Removes exactly the inventory recorded in .cairn-install.json and nothing else. --scope is optional: both scopes are searched, and two matches is an error rather than a guess. A destination may record several installs; removal is matched on the bundle name and the target, leaves a sibling record and any path it also owns in place, and rewrites the manifest with the survivors rather than deleting it.",
  }),
  agentCommand("installed", {
    stability: "experimental",
    exitCodes: [OK("Listing written to stdout"), USAGE],
    stream: { success: "stdout" },
    notes:
      "Scans the install roots declared on the target profiles. All output goes to stdout. Prints observed state, so it never reports findings.",
  }),
  agentCommand("specs", {
    exitCodes: [OK("Profiles written to stdout"), USAGE],
    stream: { success: "stdout" },
    notes: "All output goes to stdout. Prints static data, so it never reports findings.",
  }),

  // Markdown: validation
  diagnostic("lint", "One or more issues found", {
    outputSchema: "issue-list",
    ...AUTOMATION,
  }),
  diagnostic("lint-dir", "One or more issues found in any file", {
    outputSchema: "issue-list",
    ...AUTOMATION,
    notes:
      "--summary --format json emits the lint-dir-summary shape instead of a finding list. 'No markdown files found' is reported on stdout with exit 0.",
  }),
  diagnostic("validate-frontmatter", "Validation findings", {
    outputSchema: "issue-list",
    ...AUTOMATION,
    exitCodes: [OK("Frontmatter is valid"), USAGE, FINDINGS("Validation findings")],
  }),
  diagnostic("audit", "Actionable findings", {
    outputSchema: "md-audit",
    ...AUTOMATION,
    // Only --write-baseline writes, and only to the named baseline file.
    writes: true,
    exitCodes: [
      OK("No findings, or a baseline was written"),
      USAGE,
      FINDINGS("Actionable findings"),
    ],
    notes:
      "The jsonl and sarif forms carry only the findings; the totals and graph summary have no representation in them. --baseline suppresses findings a baseline already records and reports what it suppressed, so exit 2 means regressions only; entries are keyed on checker, workspace-relative path, and message, deliberately not line number. A stale entry means something was fixed and never changes the exit code, and a document this tool did not write is reported as a `baseline` finding rather than silently ignored. --write-baseline records the current findings and exits 0; it is the only audit mode that writes, and it is deliberately not settable from project configuration.",
  }),
  diagnostic("check-urls", "One or more URLs are broken", {
    outputSchema: "md-check-urls",
    ...AUTOMATION,
    notes: "The `file` key is present only when exactly one input file was checked.",
  }),
  diagnostic("check-snippets", "Snippet drift, or a link that could not be resolved", {
    outputSchema: "md-check-snippets",
    // Only --write writes, and only to the linked blocks it can rewrite.
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("Every linked snippet matches its source, or --write refreshed them"),
      USAGE,
      FINDINGS(
        "--check or --dry-run found drift, or any mode found an unresolvable link, a malformed link, an unwritable fence, or an edit-plan conflict",
      ),
    ],
    notes:
      "Experimental because the fence authoring syntax may still change. A snippet is never executed; the source file is only read. Only fences whose info string carries cairn:snippet= are considered, and unlinked fences never appear in the payload. Unlike md fix, a finding with no available fix — a deleted source file, a deleted region, a fence the refreshed body cannot fit into — fails every mode including --write, because this command's job is checking rather than fixing; drift alone fails only --check and --dry-run. Comparison ignores line endings, trailing horizontal whitespace, and trailing blank lines, and nothing else. Source reads are confined to the workspace root and refuse non-regular files, files over 2 MiB, and files containing NUL; writes are confined to the md fix containment root. The mode is deliberately not settable from project configuration.",
  }),

  // Markdown: references and graph
  diagnostic("refs", "One or more targets missing"),
  inspection("refs-to"),
  diagnostic("links", "One or more broken links found", {
    outputSchema: "issue-list",
    notes:
      "--format json writes to stdout and returns before the broken-link check, so it exits 0 even when broken links exist. Changing this would be a breaking change.",
  }),
  diagnostic("orphans", "One or more orphans found", { outputSchema: "md-orphans" }),
  diagnostic("graph", "Broken or unreachable documents found", {
    outputSchema: "md-graph",
    notes:
      "--output mermaid|dot writes the diagram to stdout regardless of exit status and ignores --format. --focus narrows every output to the documents within --depth undirected hops, and the exit code follows the narrowing. The graph is built from the full selected set first, so inbound, outbound, and deadEnd stay whole-workspace values and a component or cycle is reported whole when any member is in focus — a link leaving the neighborhood is never reported as broken.",
  }),

  // Markdown: document inspection
  inspection("headers"),
  inspection("outline"),
  inspection("stats"),
  inspection("structure"),
  inspection("code-blocks"),
  inspection("tasks"),
  inspection("tables"),
  inspection("section", {
    exitCodes: [
      OK("Section found and extracted"),
      { code: 1, meaning: "File or heading not found" },
    ],
    notes: "--raw writes markdown to stdout regardless of --format.",
  }),
  inspection("frontmatter", {
    exitCodes: [
      OK("Frontmatter found, or none present"),
      { code: 1, meaning: "File not found or key not found" },
    ],
    notes: "--key --format json emits the raw extracted value, which may be a scalar or null.",
  }),
  inspection("toc", {
    writes: true,
    exitCodes: [
      OK("Table of contents current, or written"),
      USAGE,
      FINDINGS("--check found a stale table of contents"),
    ],
    stream: { success: "stdout", findings: "stderr" },
    notes:
      "Emits a different shape per mode: --write, --dry-run, --check, and the default listing. Only --write modifies files.",
  }),

  // Markdown: workspace data
  inspection("query", {
    outputSchema: "md-query",
    notes:
      "Two modes share one kind argument. Without --where, --select, or --group-by the shortcut kinds emit their historical shapes unchanged. With any of them the kind names an entity (documents, headings, links, tasks, code-blocks, frontmatter) and the payload carries projected rows plus a `fields` column order; --group-by replaces `results` with group objects. So code-blocks emits language groups without composable options and flat rows with them. links-to, duplicates, unused-assets, missing-h1, and frontmatter-keys reject composable options rather than changing shape, and the predicate options are deliberately not configurable. frontmatter-keys is an aggregate — one row per top-level key with a document count and coverage — which the projection model cannot express, so it is a shortcut kind rather than a seventh entity.",
  }),
  inspection("diff", {
    outputSchema: "md-diff",
    notes:
      "Describes two states rather than judging them, so differences never change the exit code. Heading renames matched by position carry heuristic: true and are a guess, not a fact; a heading whose text changed and which also moved is reported as a removal plus an addition instead.",
  }),
  inspection("context", {
    outputSchema: "md-context",
    notes:
      "Broken dependencies and budget omissions are reported inside the payload and never change the exit code; use md links or md audit to fail on them. budget.tokenEstimate is usedBytes/4, not a model tokenizer.",
  }),
  inspection("index", {
    outputSchema: "md-index",
    writes: true,
    notes: "Writes only the workspace cache, never workspace files.",
  }),

  // Markdown: refactoring
  diagnostic("fix", "Pending fixes, or a conflict that blocks writing", {
    outputSchema: "md-fix",
    writes: true,
    stability: "experimental",
    exitCodes: [
      OK("No pending fixes, or --write and --dry-run completed"),
      USAGE,
      FINDINGS("--check found pending fixes, or any mode found a conflict"),
    ],
    notes:
      "Defaults to --check; only --write modifies files, and the mode cannot be set from project configuration. --write applies every file's edits as one transaction and refuses to write at all if any input changed after planning, any two edits overlap, or any target resolves outside the workspace root. Per-file commits are atomic; a multi-file rollback rewrites bytes best-effort and is not crash-safe. Unfixable findings are reported but never change the exit code.",
  }),
  inspection("rename-heading", {
    writes: true,
    exitCodes: [
      OK("Heading renamed, or dry run completed"),
      { code: 1, meaning: "File or heading not found, or the new slug already exists" },
    ],
  }),
  inspection("rename-file", {
    writes: true,
    exitCodes: [
      OK("File renamed, or dry run completed"),
      { code: 1, meaning: "Source not found, or the destination already exists" },
    ],
  }),
];

export const COMMAND_CONTRACTS: Readonly<Record<string, CommandContract>> = Object.fromEntries(
  CONTRACTS.map((contract) => [contract.id, contract]),
);
