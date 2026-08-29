#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { lintAction } from "./commands/lint.js";
import { lintDirAction } from "./commands/lint-dir.js";
import { refsAction } from "./commands/refs.js";
import { refsToAction } from "./commands/refs-to.js";
import { headersAction } from "./commands/headers.js";
import { outlineAction } from "./commands/outline.js";
import { tocAction } from "./commands/toc.js";
import { statsAction } from "./commands/stats.js";
import { codeBlocksAction } from "./commands/code-blocks.js";
import { structureAction } from "./commands/structure.js";
import { linksAction } from "./commands/links.js";
import { sectionAction } from "./commands/section.js";
import { frontmatterAction } from "./commands/frontmatter.js";
import { tasksAction } from "./commands/tasks.js";
import { tablesAction } from "./commands/tables.js";
import { checkUrlsAction } from "./commands/check-urls.js";
import { orphansAction } from "./commands/orphans.js";
import { renameHeadingAction } from "./commands/rename-heading.js";
import { renameFileAction } from "./commands/rename-file.js";
import { graphAction } from "./commands/graph.js";
import { validateFrontmatterAction } from "./commands/validate-frontmatter.js";
import { auditAction } from "./commands/audit.js";
import { queryAction } from "./commands/query.js";
import { contextAction } from "./commands/context.js";
import { diffAction } from "./commands/diff.js";
import { fixAction } from "./commands/fix.js";
import { checkSnippetsAction } from "./commands/check-snippets.js";
import { indexAction } from "./commands/index.js";
import { checkUpdateAction, refreshUpdateCacheAction } from "./commands/update-check.js";
import { installUpdateNotifier, CHECK_COMMAND, REFRESH_COMMAND } from "./update-notifier.js";
import { loadConfig, selectConfig, selectRoot, defaultLintConcurrency } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { commandOptions, initializeRuntime, runtime } from "./runtime.js";
import { CommandExit } from "./command-result.js";
import { collect } from "./option-utils.js";
import { formatsFor } from "./formats.js";
import { packageName, packageVersion as version } from "./version.js";
import {
  agentCompatAction,
  agentConvertAction,
  agentInspectAction,
  agentValidateAction,
  agentActionBoundary,
} from "./commands/agent.js";
import { agentSpecsAction } from "./commands/agent-specs.js";
import type { AgentAddOptions } from "./commands/agent-scaffold.js";
import { agentAddAction, agentInitAction } from "./commands/agent-scaffold.js";
import { agentUpgradeAction } from "./commands/agent-upgrade.js";
import { agentImportAction } from "./commands/agent-import.js";
import { agentPackageAction } from "./commands/agent-package.js";
import { agentAuditAction } from "./commands/agent-audit.js";
import { agentTestAction } from "./commands/agent-test.js";
import { agentDoctorAction } from "./commands/agent-doctor.js";
import { agentInstallAction } from "./commands/agent-install.js";
import { agentUninstallAction } from "./commands/agent-uninstall.js";
import { agentInstalledAction } from "./commands/agent-installed.js";
import { describeAction } from "./commands/describe.js";
import { schemaAction } from "./commands/schema.js";
import { completionAction } from "./commands/completion.js";
import { serveAction, type ServeOptions } from "./commands/serve.js";
import {
  scriptsListAction,
  scriptsRunAction,
  scriptsWhichAction,
  type ScriptsOptions,
} from "./commands/scripts.js";
import {
  usageAgentsAction,
  usageCommandsAction,
  usageHooksAction,
  usageIndexAction,
  usageProjectsAction,
  usageProvidersAction,
  usageSessionsAction,
  usageSkillsAction,
  usageSummaryAction,
  usageTokensAction,
  usageToolsAction,
  type UsageOptions,
} from "./commands/usage.js";

// Pre-process argv to expand -fh/-fj shorthands into --format values
// before Commander sees them (Commander doesn't support multi-char short flags).
// Bounded to the tokens before the first `--`: everything after it is forwarded
// verbatim to a child process by `scripts run`, and rewriting a token there would
// hand the child `--format=json` in place of the `-fj` the user typed.
const forwardedFrom = process.argv.indexOf("--");
const argv = process.argv.map((arg, index) => {
  if (forwardedFrom !== -1 && index >= forwardedFrom) return arg;
  if (arg === "-fh") return "--format=human";
  if (arg === "-fj") return "--format=json";
  return arg;
});

// `serve` loads configuration for the same reason `md` does: it answers with the
// workspace's own checks and exclusions, so a tool call and the equivalent `md`
// command agree. Discovery starts at --root rather than the cwd, because the host
// spawns the server from an arbitrary directory.
const servesWorkspace = argv[2] === "md" || argv[2] === "serve";
let projectConfig: ResolvedConfig;
try {
  projectConfig = servesWorkspace
    ? loadConfig(
        selectConfig(argv.slice(2)),
        argv[2] === "serve" ? selectRoot(argv.slice(2)) : process.cwd(),
      )
    : loadConfig({ disabled: true });
  initializeRuntime(projectConfig);
} catch (error) {
  process.stderr.write(`Error: ${(error as Error).message}\n`);
  process.exit(1);
}

const explicitFormat = argv.some(
  (arg, index) =>
    arg.startsWith("--format=") ||
    arg === "-fh" ||
    arg === "-fj" ||
    (arg === "--format" && argv[index + 1]),
);
const mdIndex = argv.indexOf("md");
let configuredCommand: string | undefined;
for (let index = mdIndex + 1; mdIndex !== -1 && index < argv.length; index++) {
  if (argv[index] === "--config") {
    index++;
    continue;
  }
  if (argv[index].startsWith("--config=") || argv[index] === "--no-config") continue;
  if (!argv[index].startsWith("-")) {
    configuredCommand = argv[index];
    break;
  }
}
const configuredFormat =
  (configuredCommand ? projectConfig.commands[configuredCommand]?.format : undefined) ??
  projectConfig.output.format;
const notifierArgv =
  ["json", "jsonl", "sarif"].includes(String(configuredFormat)) && !explicitFormat
    ? [...argv, `--format=${String(configuredFormat)}`]
    : argv;

// A downstream reader closing the pipe early is normal shell usage, not an error:
// `describe -fj | head` and `... | jq '.commands[0]'` both do it. Payloads under the
// pipe buffer are written synchronously and never notice, but larger ones (describe
// is ~150KB) would otherwise surface an unhandled EPIPE and crash.
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });

// Reads the cached result and may schedule a detached refresh. Never blocks and
// never writes to a machine-readable stream — see src/update-notifier.ts.
installUpdateNotifier({
  currentVersion: version,
  packageName,
  argv: notifierArgv,
  entryPoint: fileURLToPath(import.meta.url),
});

const program = new Command()
  .name("cairn")
  .description("An agent-agnostic CLI toolkit for working with markdown files and related assets")
  .version(version);

const agent = program
  .command("agent")
  .description("Convert and inspect portable agent bundles")
  .addHelpText(
    "after",
    "\nTargets: claude-code, codex, cursor, or all\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  );

agent
  .command("convert")
  .description("Convert an agent bundle into target-native artifacts")
  .argument("<source>", "Bundle root containing agent-bundle.yaml or a legacy Claude plugin")
  .requiredOption("--target <target>", "Target (repeatable, or all)", collect)
  .requiredOption("--output <dir>", "Output root")
  .option("--profile <profile>", "Output profile: plugin, project, both", "both")
  .option("--strict", "Treat approximations as blocking findings")
  .option("--force", "Replace nonempty selected destinations")
  .option("--dry-run", "Render fully without writing")
  .option("--check", "Compare generated bytes and modes without writing")
  .option("--report <file>", "Also write the conversion report to this path")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\n--report writes the same document as conversion-report.json, provenance included, to\nan arbitrary path, so CI can keep the report without keeping the rendered tree. It is\nwritten in every mode, including --dry-run, --check, and a strict failure, and is never\nlisted in the artifacts. It must not be inside the source tree or the output directory.\n\nExit codes:\n  0  Successful and lossless\n  1  Invocation or I/O error\n  2  Validation, compatibility, strict, or stale-output finding",
  )
  .action((source: string, opts: Parameters<typeof agentConvertAction>[1]) =>
    agentActionBoundary("convert", opts, () => agentConvertAction(source, opts)),
  );

agent
  .command("validate")
  .description("Validate an agent bundle without generating output")
  .argument("<source>", "Bundle root")
  .option("--target <target>", "Also validate target mappings (repeatable, or all)", collect)
  .option("--strict", "Treat approximations as blocking findings")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .action((source: string, opts: Parameters<typeof agentValidateAction>[1]) =>
    agentActionBoundary("validate", opts, () => agentValidateAction(source, opts)),
  );

agent
  .command("inspect")
  .description("Show the normalized bundle, references, overrides, and graph")
  .argument("<source>", "Bundle root")
  .option("--target <target>", "Narrow to a target (repeatable, or all)", collect)
  .option("--profile <profile>", "Output profile: plugin, project, both")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\n--target narrows a large bundle to the components that reach the selected targets,\nusing the same predicate the renderer uses, and reports what it excluded under\n`filter`. --profile drops the sections a profile never emits, such as hooks and MCP\noutside the plugin profile, and requires --target. Without either flag the output is\nunchanged.\n\nExit codes:\n  0  Bundle inspected\n  1  Invocation or I/O error\n  2  Bundle findings",
  )
  .action((source: string, opts: Parameters<typeof agentInspectAction>[1]) =>
    agentActionBoundary("inspect", opts, () => agentInspectAction(source, opts)),
  );

agent
  .command("compat")
  .description("Show platform compatibility or analyze a bundle")
  .argument("[source]", "Optional bundle root")
  .option("--target <target>", "Target (repeatable, or all)", collect)
  .option("--strict", "Treat approximations as blocking findings")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .action((source: string | undefined, opts: Parameters<typeof agentCompatAction>[1]) =>
    agentActionBoundary("compat", opts, () => agentCompatAction(source, opts)),
  );

agent
  .command("doctor")
  .description("Check a bundle and generated output against the target conformance profiles")
  .argument("[source]", "Optional bundle root")
  .option("--target <target>", "Target (repeatable, or all)", collect)
  .option("--profile <profile>", "Output profile: plugin, project, both", "both")
  .option("--output <dir>", "Also check an existing generated output root")
  .option("--host-version <spec>", "Installed host version: <target>@<version>", collect)
  .option("--strict", "Treat warnings as blocking findings")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nRuns without a bundle: profile self-checks and host version reporting still apply.\nNever executes a host's own tooling, so results do not depend on what is installed.\n\nExit codes:\n  0  No blocking conformance findings\n  1  Invocation or I/O error\n  2  Profile, drift, host, or strict finding",
  )
  .action((source: string | undefined, opts: Parameters<typeof agentDoctorAction>[1]) =>
    agentActionBoundary("doctor", opts, () => agentDoctorAction(source, opts)),
  );

agent
  .command("init")
  .description("Scaffold a new portable agent bundle")
  .argument("<name>", "Bundle name in lowercase kebab-case")
  .option("--output <dir>", "Destination root (default: ./<name>)")
  .option("--description <text>", "Bundle description")
  .option("--bundle-version <semver>", "Initial bundle version", "0.1.0")
  .option("--license <spdx>", "License recorded in marketplace metadata", "MIT")
  .option("--component <kind>", "Component to scaffold (repeatable, or none)", collect)
  .option("--target <target>", "Target (repeatable, or all)", collect)
  .option("--profile <profile>", "Output profile: plugin, project, both", "both")
  .option("--overlays", "Create a native/<target>/ overlay root per target")
  .option("--force", "Scaffold into a nonempty destination")
  .option("--dry-run", "Report the plan without writing")
  .option("--check", "Report whether the scaffold is already present and current")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nNever prompts. Placeholder marketplace metadata is valid here; publish\nreadiness is checked by agent package.\n\nExit codes:\n  0  Bundle scaffolded, or dry run completed\n  1  Invocation or I/O error\n  2  --check found a missing or differing scaffold",
  )
  .action((name: string, opts: Parameters<typeof agentInitAction>[1]) =>
    agentActionBoundary("init", opts, () => agentInitAction(name, opts)),
  );

agent
  .command("add")
  .description("Add one component to an existing bundle")
  .argument("<kind>", "skill, agent, rule, hook, policy, mcp, or overlay")
  .argument("<name>", "Component name, or the portable event name for a hook")
  .argument("[bundle]", "Bundle root (default: .)")
  .option("--description <text>", "Component description")
  .option("--path <dir>", "Component root override; records it in the manifest")
  .option("--activation <mode>", "Rule activation: always, files, model, manual", "always")
  .option("--glob <glob>", "Rule glob (repeatable)", collect)
  .option("--command <cmd>", "Command for a hook, policy prefix, or MCP server")
  .option("--target <target>", "Overlay target, required for kind 'overlay'", collect)
  .option("--profile <profile>", "Overlay output profile: plugin or project", "plugin")
  .option("--force", "Replace an existing component")
  .option("--dry-run", "Report the plan without writing")
  .option("--check", "Report whether the component is already present and current")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nagent-bundle.yaml is edited through a comment-preserving YAML document and is\nleft byte-untouched when no manifest change is needed.\n\nExit codes:\n  0  Component added, or dry run completed\n  1  Invocation or I/O error\n  2  --check found a missing or differing component",
  )
  .action((kind: string, name: string, bundle: string | undefined, opts: AgentAddOptions) =>
    agentActionBoundary("add", opts, () => agentAddAction(kind, name, bundle, opts)),
  );

agent
  .command("import")
  .description("Import an existing native plugin or project into a portable bundle")
  .argument("<source>", "Native plugin or project root")
  .requiredOption("--output <dir>", "Bundle root to create")
  .option("--from <spec>", "Source layout: auto, <target>, or <target>-<profile>", "auto")
  .option("--scope <scope>", "Source scope: auto, plugin, project", "auto")
  .option("--merge <strategy>", "refuse, skip-existing, overwrite, native-only", "refuse")
  .option("--bundle-name <name>", "Bundle name; defaults to the source directory name")
  .option("--native-only", "Skip normalization and preserve everything as an overlay")
  .option("--strict", "Treat approximations as blocking findings")
  .option("--dry-run", "Report the import without writing")
  .option("--check", "Compare against an existing bundle without writing")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nDetection is driven by the target conformance profiles, so it cannot drift\nfrom what agent convert emits. Untranslatable pieces are preserved under\nnative/<target>/ rather than dropped.\n\nExit codes:\n  0  Imported, or dry run completed\n  1  Invocation or I/O error\n  2  Blocking finding, or --check found drift",
  )
  .action((source: string, opts: Parameters<typeof agentImportAction>[1]) =>
    agentActionBoundary("import", opts, () => agentImportAction(source, opts)),
  );

agent
  .command("upgrade")
  .description("Migrate a bundle between neutral schema versions")
  .argument("<source>", "Bundle root")
  .requiredOption("--to-schema <version>", "Target bundle schema version")
  .option("--dry-run", "Report the migration without writing")
  .option("--check", "Exit 2 when the bundle is not already at the target schema")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nOnly agent-bundle.yaml is rewritten; no component file is touched. The\nmigration is verified in memory to produce byte-identical generated output\nbefore it writes.\n\nExit codes:\n  0  Migrated, already current, or dry run completed\n  1  Invocation or I/O error\n  2  --check found a bundle below the target schema, or a blocking finding",
  )
  .action((source: string, opts: Parameters<typeof agentUpgradeAction>[1]) =>
    agentActionBoundary("upgrade", opts, () => agentUpgradeAction(source, opts)),
  );

agent
  .command("package")
  .description("Build a distributable package with catalogs, checksums, and archives")
  .argument("<source>", "Bundle root")
  .requiredOption("--target <target>", "Target (repeatable, or all)", collect)
  .requiredOption("--output <dir>", "Package root")
  .option("--profile <profile>", "Output profile: plugin, project, both", "both")
  .option("--marketplace <mode>", "Catalog mode: repo, local, none", "repo")
  .option("--archive", "Also emit a deterministic .tar.gz per target and profile")
  .option("--from-dist <dir>", "Verify an existing agent convert tree matches this bundle")
  .option("--strict", "Treat warnings as blocking findings")
  .option("--force", "Replace nonempty selected destinations")
  .option("--dry-run", "Build in memory without writing")
  .option("--check", "Compare against an existing package without writing")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nRenders the bundle itself, so a package can never certify a stale tree.\nNever contacts the network and never publishes.\n\nExit codes:\n  0  Package written, or checks passed\n  1  Invocation or I/O error\n  2  Publish-readiness, integrity, or stale finding",
  )
  .action((source: string, opts: Parameters<typeof agentPackageAction>[1]) =>
    agentActionBoundary("package", opts, () => agentPackageAction(source, opts)),
  );

agent
  .command("audit")
  .description("Review a bundle's executable surface, permissions, and supply chain")
  .argument("<source>", "Bundle root")
  .option("--target <target>", "Target (repeatable, or all); enables the rendered checks", collect)
  .option("--profile <profile>", "Output profile: plugin, project, both", "both")
  .option("--baseline <file>", "Compare executables against a previous package sbom.json")
  .option("--strict", "Treat warnings as blocking findings")
  .option("--format <fmt>", "Output format: llm, human, json, sarif", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nExplainable static analysis: nothing is executed and no network request is\nmade. Exit 2 means findings to review, not proof that a bundle is malicious.\n\nExit codes:\n  0  No blocking review findings\n  1  Invocation or I/O error\n  2  Review findings",
  )
  .action((source: string, opts: Parameters<typeof agentAuditAction>[1]) =>
    agentActionBoundary("audit", opts, () => agentAuditAction(source, opts)),
  );

agent
  .command("test")
  .description("Run the model-free contract tests stored with a bundle")
  .argument("<source>", "Bundle root")
  .option("--tests <path>", "Test file or directory (default: tests/ in the bundle)")
  .option("--target <target>", "Target (repeatable, or all)", collect)
  .option("--profile <profile>", "Output profile: plugin, project, both", "both")
  .option("--case <name>", "Run only this case (repeatable)", collect)
  .option("--strict", "Treat warnings as blocking findings")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nEvery expectation is evaluated against the same in-memory render agent convert\nwould write. Nothing is executed, no model is called, and no file is written; a\nchanged golden digest is reported with both the expected and the actual value.\n--target and --profile narrow each case's own selection rather than widening it.\n\nExit codes:\n  0  Every selected case passed\n  1  Invocation or I/O error\n  2  A failing case, an invalid test file, or a warning under --strict",
  )
  .action((source: string, opts: Parameters<typeof agentTestAction>[1]) =>
    agentActionBoundary("test", opts, () => agentTestAction(source, opts)),
  );

agent
  .command("install")
  .description("Install a bundle into a host plugin or project directory")
  .argument("<source>", "Bundle root")
  .requiredOption("--target <target>", "Target: claude-code, codex, or cursor", collect)
  .option("--scope <scope>", "Install scope: user or project", "user")
  .option("--into <dir>", "Override the install root declared by the target profile")
  .option("--profile <profile>", "Must match the location's profile when given")
  .option("--link", "Symlink the rendered tree instead of copying")
  .option("--register", "Edit host config to activate a marketplace install")
  .option("--strict", "Treat warnings as blocking findings")
  .option("--force", "Replace a destination that is not a prior install of this bundle")
  .option("--dry-run", "Plan the install without writing")
  .option("--check", "Compare against an existing install without writing")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nRenders and packages in memory, so an install is always derived from the\nbundle rather than from a possibly-drifted dist tree. Destinations come from\nthe target profiles. --register is the only flag that edits host config.\n\nExit codes:\n  0  Installed, or checks passed\n  1  Invocation or I/O error\n  2  Install finding, or --check found drift",
  )
  .action((source: string, opts: Parameters<typeof agentInstallAction>[1]) =>
    agentActionBoundary("install", opts, () => agentInstallAction(source, opts)),
  );

agent
  .command("uninstall")
  .description("Remove a previously installed bundle")
  .argument("<name>", "Installed bundle name")
  .requiredOption("--target <target>", "Target: claude-code, codex, or cursor", collect)
  .option("--scope <scope>", "Install scope: user or project")
  .option("--into <dir>", "Override the install root declared by the target profile")
  .option("--dry-run", "Report the removal without writing")
  .option("--check", "Exit 2 when the named install is still present")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nRemoves exactly the inventory recorded in .cairn-install.json and\nnothing else. --scope is optional: both scopes are searched, and two matches\nis an error rather than a guess.\n\nExit codes:\n  0  Removed, already absent under --check, or dry run completed\n  1  Invocation or I/O error\n  2  Manifest missing or malformed, or --check found the install still present",
  )
  .action((name: string, opts: Parameters<typeof agentUninstallAction>[1]) =>
    agentActionBoundary("uninstall", opts, () => agentUninstallAction(name, opts)),
  );

agent
  .command("installed")
  .description("List bundles installed by this CLI")
  .option("--target <target>", "Target (repeatable, or all)", collect)
  .option("--scope <scope>", "Install scope: user or project")
  .option("--into <dir>", "Override the install root declared by the target profile")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nScans the install roots declared on the target profiles and lists every\n.cairn-install.json it finds.\n\nExit codes:\n  0  Listing written to stdout\n  1  Invocation error",
  )
  .action((opts: Parameters<typeof agentInstalledAction>[0]) =>
    agentActionBoundary("installed", opts, () => agentInstalledAction(opts)),
  );

agent
  .command("specs")
  .description("Print the versioned target conformance profiles")
  .option("--target <target>", "Target (repeatable, or all)", collect)
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nThe profiles are the source of truth for target behavior; --format json is the\nform to depend on.\n\nExit codes:\n  0  Profiles written to stdout\n  1  Invocation error",
  )
  .action((opts: Parameters<typeof agentSpecsAction>[0]) =>
    agentActionBoundary("specs", opts, () => agentSpecsAction(opts)),
  );

program
  .command(CHECK_COMMAND)
  .description("Check whether a newer version of this CLI has been published")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nQueries the registry directly rather than using the 24h cache.\n\nExit codes:\n  0  Already on the latest version\n  1  Could not reach the registry\n  2  A newer version is available",
  )
  .action((opts: { format: string }) => checkUpdateAction(packageName, version, opts));

program
  .command("describe")
  .description("Describe the CLI contract: commands, options, exit codes, and output schemas")
  .argument("[command...]", "Optional command path, for example: md graph")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .addHelpText(
    "after",
    "\nExamples:\n  cairn describe --format json\n  cairn describe md graph --format json\n\nReports the static contract; project configuration is not applied.\n\nExit codes:\n  0  Description written to stdout\n  1  Unknown command path or invalid format",
  )
  .action((commandPath: string[], opts: { format: string }) =>
    describeAction(program, commandPath, {
      ...opts,
      toolName: packageName,
      toolVersion: version,
    }),
  );

program
  .command("schema")
  .description("Print a published output schema, or list the available schemas")
  .argument("[id]", "Schema id, for example: agent-result")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .addHelpText(
    "after",
    "\nWith an id, the schema document is written regardless of --format.\nSchema ids are identifiers, not fetchable URLs.\n\nExit codes:\n  0  Schema or index written to stdout\n  1  Unknown schema id or invalid format",
  )
  .action((id: string | undefined, opts: { format: string }) => schemaAction(id, opts));

program
  .command("completion")
  .description("Print a shell completion script for bash, zsh, fish, or powershell")
  .argument("<shell>", "Shell: bash, zsh, fish, or powershell")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .addHelpText(
    "after",
    "\nThe script is written to stdout regardless of --format, and is generated from the\nsame command tree `describe` walks, so it cannot drift from the real options.\n\nInstall:\n  cairn completion bash       >> ~/.bashrc          (or a bash-completion.d file)\n  cairn completion zsh        > ~/.zfunc/_cairn (a directory on $fpath)\n  cairn completion fish       > ~/.config/fish/completions/cairn.fish\n  cairn completion powershell >> $PROFILE\n\nRegenerate after upgrading; the script embeds the command tree rather than calling\nback into the CLI, so a shell never pays a process spawn per keystroke.\n\nExit codes:\n  0  Script written to stdout\n  1  Unknown shell or invalid format",
  )
  .action((shell: string | undefined, opts: { format: string }) =>
    completionAction(program, shell, {
      ...opts,
      toolName: packageName,
      toolVersion: version,
    }),
  );

program
  .command("serve")
  .description("Serve the workspace engine over a machine protocol")
  .argument("<protocol>", "Protocol: mcp")
  .option("--root <dir>", "Directory to serve; every path is confined to it", ".")
  .option("--config <file>", "Path to a configuration file")
  .option("--no-config", "Ignore any configuration file")
  .option("--max-documents <n>", "Parsed documents held in memory before eviction")
  .option("--concurrency <n>", "Parallel lints during audit_markdown")
  .addHelpText(
    "after",
    "\nSpeaks the Model Context Protocol over stdio, exposing the Markdown workspace\nengine as read-only tools. stdout carries JSON-RPC frames rather than a payload,\nso --format does not apply; diagnostics go to stderr.\n\nEvery tool is read-only and every path argument is confined to --root, resolved\nthrough symlinks. Configuration is discovered from --root, so a tool answers the\nsame as the equivalent md command in that workspace.\n\nRegister with a host:\n  claude mcp add markdown -- cairn serve mcp --root docs\n\nExit codes:\n  0  The client closed the connection\n  1  Unknown protocol, unreadable root, or invalid configuration",
  )
  .action((protocol: string, opts: Record<string, unknown>) =>
    serveAction(protocol, opts as unknown as ServeOptions),
  );

const scripts = program
  .command("scripts")
  .description("Resolve and run named scripts declared in .cairn.yml")
  .addHelpText(
    "after",
    "\nA script name resolves the same from any directory: every .cairn.yml from the\nworking directory up to the repository root is consulted, and the nearest file that\ndefines the name wins. The script runs with its working directory pinned to the\nregistry that declared it, which is what makes a hook survive a change of directory.\n\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  );

const scriptsCommon = (command: Command): Command =>
  command
    .option("--format <fmt>", "Output format: llm, human, json", "llm")
    .option("--envelope", "Wrap --format json output in the versioned result envelope")
    .option("--root <dir>", "Stop the upward walk at this directory")
    .option("--config <file>", "Use a specific .cairn.yml configuration file")
    .option("--no-config", "Disable project configuration discovery");

scriptsCommon(scripts.command("run"))
  .description("Run a named script from anywhere in the tree")
  .argument("<name>", "Script name declared under scripts: in a .cairn.yml")
  .argument("[args...]", "Arguments forwarded to the script, after --")
  .addHelpText(
    "after",
    "\nExamples:\n  cairn scripts run gather-context\n  cairn scripts run lint-changed -- --since main\n\nIn llm and human formats the script's streams pass through untouched and its exit\nstatus becomes this process's exit status, so a hook reads the real code. With\n--format json the streams are captured into the payload instead.\n\nRefuses to run outside a Git repository unless --root sets the boundary explicitly.\n\nExit codes:\n  *  llm and human: the script's own exit status, verbatim\n  0  --format json: the script exited 0\n  1  Unresolvable name, or the script could not be started\n  2  --format json: the script exited non-zero or was killed by a signal",
  )
  .action((name: string, args: string[], opts: Record<string, unknown>) =>
    scriptsRunAction(name, args, opts as ScriptsOptions),
  );

scriptsCommon(scripts.command("which"))
  .description("Show which registry defines a script, without running it")
  .argument("<name>", "Script name")
  .addHelpText(
    "after",
    "\nReports the winning .cairn.yml, the working directory the script would run in,\nand any same-named definitions it shadows.\n\nExit codes:\n  0  The name resolved\n  1  Invocation error\n  2  No script by that name",
  )
  .action((name: string, opts: Record<string, unknown>) =>
    scriptsWhichAction(name, opts as ScriptsOptions),
  );

scriptsCommon(scripts.command("list"))
  .description("List every script visible from the working directory")
  .addHelpText(
    "after",
    "\nNearest definition wins, so a name declared in a nested registry hides the one above\nit. Files that could not be parsed are reported rather than skipped silently.\n\nExit codes:\n  0  Listing written to stdout\n  1  Invocation error\n  2  A consulted configuration file could not be read",
  )
  .action((opts: Record<string, unknown>) => scriptsListAction(opts as ScriptsOptions));

const usage = program
  .command("usage")
  .description("Report on Claude Code usage from its own session logs")
  .addHelpText(
    "after",
    "\nReads the session transcripts an assistant leaves on disk and reports on them:\ntokens by model and day, tool and MCP calls, skills, subagents, hooks, and slash\ncommands. Nothing is sent anywhere and nothing outside the scan cache is written.\n\nEvery transcript is reduced once and cached under XDG_CACHE_HOME, keyed on each\nfile's size and modification time, so the first scan is slow and later ones are not.\n\nProviders:\n  --provider selects the log source; `usage providers` lists what is registered.\n\nWindows:\n  --since and --until take a relative span (7d, 2w, 3m, 1y) or an ISO date, and are\n  inclusive day bounds.\n\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  );

/**
 * Options every `usage` subcommand shares.
 *
 * `--project` uses the unwrapped `collect` because `src/contract/describe.ts`
 * detects a repeatable option by comparing its coercion against that function by
 * identity.
 */
const usageCommon = (command: Command): Command =>
  command
    .option("--format <fmt>", "Output format: llm, human, json", "llm")
    .option("--envelope", "Wrap --format json output in the versioned result envelope")
    .option("--provider <name>", "Log source to report on, or all", "claude-code")
    .option("--project <path>", "Limit to a project path, slug, or name (repeatable)", collect)
    .option("--since <spec>", "Earliest day: a span such as 7d, 2w, 3m, 1y, or an ISO date")
    .option("--until <spec>", "Latest day, same forms as --since")
    .option("--last <n>", "Keep only the n most recently active sessions")
    .option("--top <n>", "Rows to show; 0 for all", "20")
    .option("--logs <dir>", "Read logs from this directory instead of the discovered one")
    .option("--no-subagents", "Exclude subagent transcripts")
    .option("--no-index", "Bypass the scan cache; neither read it nor write it")
    .option("--strict", "Exit 2 when a transcript could not be fully read");

const usageExitCodes =
  "\n\nExit codes:\n  0  Report written to stdout\n  1  Invocation error, or no logs found\n  2  --strict was given and a transcript could not be fully read";

usageCommon(usage.command("summary"))
  .description("Headline totals: sessions, tokens, tools, and features")
  .addHelpText(
    "after",
    "\nToken counts deduplicate the per-response fan-out in the source transcripts, where\none API response is written as several lines each carrying an identical copy of its\nusage. Subagent transcripts are included; --no-subagents excludes them." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageSummaryAction(opts as UsageOptions));

usageCommon(usage.command("tokens"))
  .description("Token usage rolled up by model, time, project, or session")
  .option("--by <dimension>", "model, day, week, month, project, session, provider", "model")
  .addHelpText(
    "after",
    "\nCache writes report an authoritative total alongside a best-effort split by TTL,\nwhich the oldest records do not carry." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageTokensAction(opts as UsageOptions));

usageCommon(usage.command("tools"))
  .description("Tool calls rolled up by name, kind, server, day, or session")
  .option("--by <dimension>", "name, kind, server, day, session, provider", "name")
  .option("--kind <kind>", "Limit to builtin, mcp, agent, or skill calls")
  .addHelpText(
    "after",
    "\nAn MCP tool named mcp__<server>__<tool> is split into its server and tool halves,\nso --by server and --kind mcp are how that surface is queried." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageToolsAction(opts as UsageOptions));

usageCommon(usage.command("sessions"))
  .description("One row per session, with its subagent transcripts folded in")
  .option("--sort <order>", "recent, tokens, tools, duration", "recent")
  .addHelpText(
    "after",
    "\n--last n selects the n most recently active sessions rather than the n most recent\nfiles, so a session's subagent spend is never dropped from its own row." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageSessionsAction(opts as UsageOptions));

usageCommon(usage.command("projects"))
  .description("Usage rolled up by the directory each session ran in")
  .addHelpText(
    "after",
    "\nProject identity is the working directory recorded inside the transcripts, not the\nlog directory name, whose separator substitution is not reliably invertible." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageProjectsAction(opts as UsageOptions));

usageCommon(usage.command("skills"))
  .description("Skill invocations by name")
  .addHelpText(
    "after",
    "\nCounted from every surface that records one: the Skill tool, the invoked-skill\nattachments, and the slash-command form." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageSkillsAction(opts as UsageOptions));

usageCommon(usage.command("agents"))
  .description("Subagent activity by agent type, with real token cost")
  .option("--by <dimension>", "role, path", "role")
  .addHelpText(
    "after",
    "\nSpawn counts come from the parent's tool calls; tokens come from the subagent\ntranscripts themselves. The parent's own tool result records only the subagent's\nfinal message and understates its spend several-fold, so it is not used.\n\n--by role groups by the reusable agent type; --by path groups by the task-specific\nidentifier, which only some providers record." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageAgentsAction(opts as UsageOptions));

usageCommon(usage.command("hooks"))
  .description("Hook executions by event and tool, with failures and latency")
  .addHelpText(
    "after",
    "\nKeyed by <Event>:<Tool>. Stop hooks report through a session summary record rather\nthan a per-execution one and are counted under Stop." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageHooksAction(opts as UsageOptions));

usageCommon(usage.command("commands"))
  .description("Slash command usage by name")
  .addHelpText(
    "after",
    "\nSlash commands are not a field in the logs; they are a marker block inside the\nuser's message text, and are extracted from it." +
      usageExitCodes,
  )
  .action((opts: Record<string, unknown>) => usageCommandsAction(opts as UsageOptions));

usage
  .command("providers")
  .description("List the log sources usage can report on")
  .option("--format <fmt>", "Output format: llm, human, json", "llm")
  .option("--envelope", "Wrap --format json output in the versioned result envelope")
  .option("--logs <dir>", "Test discovery against this directory")
  .addHelpText(
    "after",
    "\nReports whether each provider has left anything on this machine and what its logs\ncan answer. Reports read those capabilities rather than branching on a provider\nname, so registering a second assistant is one module and one registry line.\n\nExit codes:\n  0  Listing written to stdout\n  1  Invocation error",
  )
  .action((opts: Record<string, unknown>) => usageProvidersAction(opts as UsageOptions));

usageCommon(usage.command("index"))
  .description("Show, rebuild, or clear the scan cache")
  .option("--rebuild", "Re-parse every transcript and rewrite the cache")
  .option("--clear", "Delete the cache")
  .addHelpText(
    "after",
    "\nThe cache keys on each transcript's path, size, and modification time. Transcripts\nare append-only, so an unchanged file cannot hold a record the stored aggregate is\nmissing, and only files that grew are reopened.\n\nThe cache is private and self-invalidating: nothing outside the cache directory is\nwritten, and its internal format can change without a contract bump.\n\nExit codes:\n  0  Status written, or the cache was rebuilt or cleared\n  1  Invocation error",
  )
  .action((opts: Record<string, unknown>) => usageIndexAction(opts as UsageOptions));

// Internal: refreshes the cached latest version. Spawned detached by the notifier.
program
  .command(REFRESH_COMMAND, { hidden: true })
  .description("Internal: refresh the cached latest-version check")
  .action(() => refreshUpdateCacheAction(packageName));

const md = program
  .command("md")
  .description("Agent-agnostic Markdown validation and analysis commands")
  .option("--config <file>", "Use a specific .cairn.yml configuration file")
  .option("--no-config", "Disable project configuration discovery")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  );

function common(command: Command): Command {
  const formats = formatsFor(command.name()).join(", ");
  return command
    .option("--format <fmt>", `Output format: ${formats}`)
    .option("--envelope", "Wrap --format json output in the versioned result envelope")
    .option("--paths <style>", "Path display: absolute, relative")
    .option("--stdin-name <path>", "Logical workspace path for stdin input");
}

common(md.command("lint"))
  .description("Run all checks on a single markdown file or multiple Markdown inputs")
  .argument("<files...>", "Markdown files or globs to validate")
  .option("-s, --style", "Include markdown style checks (markdownlint)")
  .option("--no-style", "Disable markdown style checks (markdownlint)")
  .option("--mermaid", "Enable Mermaid checks")
  .option("--no-mermaid", "Disable Mermaid checks")
  .option("--katex", "Enable KaTeX checks")
  .option("--no-katex", "Disable KaTeX checks")
  .option("--references", "Enable reference checks")
  .option("--no-references", "Disable reference checks")
  .option("--changed-since <revision>", "Only files changed since a Git revision")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  All checks pass\n  2  One or more issues found",
  )
  .action((files: string[], opts: Record<string, unknown>) =>
    lintAction(
      files,
      commandOptions(
        "lint",
        {
          style: projectConfig.checks.markdownlint,
          mermaid: projectConfig.checks.mermaid,
          katex: projectConfig.checks.katex,
          references: projectConfig.checks.references,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("lint-dir"))
  .description("Run all checks on all markdown files in a directory")
  .argument("[directory]", "Path to the directory to scan (default: workspace root)")
  .option("-s, --style", "Include markdown style checks (markdownlint)")
  .option("--no-style", "Disable markdown style checks (markdownlint)")
  .option("--mermaid", "Enable Mermaid checks")
  .option("--no-mermaid", "Disable Mermaid checks")
  .option("--katex", "Enable KaTeX checks")
  .option("--no-katex", "Disable KaTeX checks")
  .option("--references", "Enable reference checks")
  .option("--no-references", "Disable reference checks")
  .option("--summary", "Show one line per file with pass/fail and issue count")
  .option("--no-summary", "Disable summary output")
  .option("--concurrency <n>", "Maximum files checked concurrently")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .option("--changed-since <revision>", "Only files changed since a Git revision")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  All files pass all checks\n  2  One or more issues found in any file",
  )
  .action((directory: string | undefined, opts: Record<string, unknown>) =>
    lintDirAction(
      directory ?? projectConfig.root,
      commandOptions(
        "lint-dir",
        {
          style: projectConfig.checks.markdownlint,
          summary: false,
          concurrency: String(defaultLintConcurrency()),
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
          mermaid: projectConfig.checks.mermaid,
          katex: projectConfig.checks.katex,
          references: projectConfig.checks.references,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("refs"))
  .description("List all references from a markdown file and check if targets exist")
  .argument("<file>", "Path to the markdown file to inspect")
  .option("-e, --external", "Include external URLs")
  .option("--no-external", "Exclude external URLs")
  .option("-a, --anchors", "Include anchor-only references")
  .option("--no-anchors", "Exclude anchor-only references")
  .option("-i, --images", "Include image references")
  .option("--no-images", "Exclude image references")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  All referenced targets exist\n  2  One or more targets missing",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    refsAction(
      file,
      commandOptions("refs", { external: false, anchors: false, images: false }, opts) as never,
    ),
  );

common(md.command("refs-to"))
  .description("Find all markdown files that reference a given file")
  .argument("<file>", "Path to the file to find references to")
  .argument("[directory]", "Directory to search (default: current directory)")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, directory: string | undefined, opts: Record<string, unknown>) =>
    refsToAction(
      file,
      directory ?? projectConfig.root,
      commandOptions(
        "refs-to",
        { include: projectConfig.files.include, exclude: projectConfig.files.exclude },
        opts,
      ) as never,
    ),
  );

common(md.command("headers"))
  .description("Extract headings from a markdown file with line numbers")
  .argument("<file>", "Path to the markdown file")
  .option("--max-depth <n>", "Maximum heading depth to include (1-6)")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    headersAction(file, commandOptions("headers", { maxDepth: "6" }, opts) as never),
  );

common(md.command("outline"))
  .description("Show headings in an indented outline format")
  .argument("<file>", "Path to the markdown file")
  .option("--max-depth <n>", "Maximum heading depth to include (1-6)")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    outlineAction(file, commandOptions("outline", { maxDepth: "6" }, opts) as never),
  );

common(md.command("toc"))
  .description("Generate a markdown table of contents from headings")
  .argument("<file>", "Path to the markdown file")
  .option("--max-depth <n>", "Maximum heading depth to include (1-6)")
  .option("--min-depth <n>", "Minimum heading depth to include (1-6)")
  .option("--ordered", "Use numbered lists instead of bullets")
  .option("--no-ordered", "Use bullet lists")
  .option("--check", "Check marker-based TOC synchronization")
  .option("--write", "Update the content between TOC markers")
  .option("--dry-run", "Print the proposed marker block without writing")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    tocAction(
      file,
      commandOptions(
        "toc",
        { maxDepth: "6", minDepth: "1", ordered: false, check: false, write: false, dryRun: false },
        opts,
      ) as never,
    ),
  );

common(md.command("graph"))
  .description("Analyze the workspace Markdown document graph")
  .argument("[directory]", "Directory to scan (default: workspace root)")
  .option("--output <mode>", "Graph output: report, mermaid, dot")
  .option("--entry <file>", "Entry point for reachability (repeatable)", collect)
  .option("--focus <file>", "Restrict to the neighborhood of a document (repeatable)", collect)
  .option("--depth <n>", "Undirected hops around --focus")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\n--focus narrows the report and the mermaid/dot diagrams to the documents within\n--depth undirected hops, so backlinks are included. The graph is analyzed in full\nfirst, so inbound/outbound counts, components, and cycles remain whole-workspace\nfacts rather than artifacts of the narrowing.\n\nExit codes:\n  0  No broken or unreachable documents\n  2  Broken or unreachable documents found",
  )
  .action((directory: string | undefined, opts: Record<string, unknown>) =>
    graphAction(
      directory ?? projectConfig.root,
      commandOptions(
        "graph",
        {
          output: "report",
          depth: "1",
          focus: [],
          entry: projectConfig.files.entryPoints,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("validate-frontmatter"))
  .description("Validate Markdown frontmatter with schema and workspace rules")
  .argument("<paths...>", "Markdown files, directories, or globs")
  .option("--schema <file>", "JSON or YAML Schema file")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .option("--changed-since <revision>", "Only files changed since a Git revision")
  .addHelpText(
    "after",
    "\nExit codes:\n  0  Frontmatter is valid\n  1  Configuration or schema error\n  2  Validation findings",
  )
  .action((target: string[], opts: Record<string, unknown>) =>
    validateFrontmatterAction(
      target,
      commandOptions(
        "validate-frontmatter",
        {
          schema: projectConfig.frontmatter.schema,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("audit"))
  .description("Run composable checks across a Markdown workspace")
  .argument("[directory]", "Directory to scan (default: workspace root)")
  .option("--summary", "Show per-check and per-file counts")
  .option("--no-summary", "Show detailed findings")
  .option("--external", "Check external URLs")
  .option("--no-external", "Do not check external URLs")
  .option("--frontmatter", "Enable configured frontmatter checks")
  .option("--no-frontmatter", "Disable frontmatter checks")
  .option("--graph", "Enable graph checks")
  .option("--no-graph", "Disable graph checks")
  .option("--toc", "Enable configured TOC checks")
  .option("--no-toc", "Disable TOC checks")
  .option("--snippets", "Enable source-linked snippet checks")
  .option("--no-snippets", "Disable source-linked snippet checks")
  .option("-s, --style", "Include markdown style checks")
  .option("--no-style", "Disable markdown style checks")
  .option("--mermaid", "Enable Mermaid checks")
  .option("--no-mermaid", "Disable Mermaid checks")
  .option("--katex", "Enable KaTeX checks")
  .option("--no-katex", "Disable KaTeX checks")
  .option("--references", "Enable reference checks")
  .option("--no-references", "Disable reference checks")
  .option("--concurrency <n>", "Maximum concurrent checks")
  .option("--timeout <ms>", "External URL timeout")
  .option("--retry <n>", "External URL retry count")
  .option("--changed-since <revision>", "Only files changed since a Git revision")
  .option("--entry <file>", "Graph entry point (repeatable)", collect)
  .option("--baseline <file>", "Suppress findings already recorded in a baseline")
  .option("--write-baseline <file>", "Record the current findings as a baseline and exit 0")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nA baseline suppresses findings it already records, so only regressions fail. Entries\nare keyed on checker, workspace-relative path, and message — not line number — so\nediting prose above a known finding does not resurface it. Recording is explicit:\n--write-baseline writes the file and exits 0, and the two flags cannot be combined.\n\nExit codes:\n  0  Audit passed, or a baseline was written\n  1  Operational error\n  2  Actionable findings",
  )
  .action((directory: string | undefined, opts: Record<string, unknown>) =>
    auditAction(
      directory ?? projectConfig.root,
      commandOptions(
        "audit",
        {
          summary: false,
          external: projectConfig.checks.external,
          frontmatter: projectConfig.checks.frontmatter,
          graph: projectConfig.checks.graph,
          toc: projectConfig.checks.toc,
          snippets: projectConfig.checks.snippets,
          style: projectConfig.checks.markdownlint,
          mermaid: projectConfig.checks.mermaid,
          katex: projectConfig.checks.katex,
          references: projectConfig.checks.references,
          concurrency: String(defaultLintConcurrency()),
          timeout: "5000",
          retry: "1",
          entry: projectConfig.files.entryPoints,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
          maxDepth: String(projectConfig.commands.toc?.maxDepth ?? "6"),
          minDepth: String(projectConfig.commands.toc?.minDepth ?? "1"),
          ordered: Boolean(projectConfig.commands.toc?.ordered ?? false),
        },
        opts,
      ) as never,
    ),
  );

common(md.command("stats"))
  .description("Show document statistics (words, headings, links, code blocks)")
  .argument("<file>", "Path to the markdown file")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    statsAction(file, commandOptions("stats", {}, opts) as never),
  );

common(md.command("code-blocks"))
  .description("List fenced code blocks with language and line ranges")
  .argument("<file>", "Path to the markdown file")
  .option("--lang <language>", "Filter by code block language")
  .option("--content", "Include code block content in output")
  .option("--no-content", "Exclude code block content from output")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    codeBlocksAction(file, commandOptions("code-blocks", { content: false }, opts) as never),
  );

common(md.command("structure"))
  .description("Show document structure skeleton (headings, code blocks, lists, math)")
  .argument("<file>", "Path to the markdown file")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    structureAction(file, commandOptions("structure", {}, opts) as never),
  );

common(md.command("links"))
  .description("List all links with context, grouped by type")
  .argument("<file>", "Path to the markdown file")
  .option("--broken-only", "Only show broken links")
  .option("--no-broken-only", "Include valid links")
  .option("--type <type>", "Filter by type: internal, external, image, anchor")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  All link targets exist (or not checked)\n  2  One or more broken links found",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    linksAction(file, commandOptions("links", { brokenOnly: false }, opts) as never),
  );

common(md.command("section"))
  .description("Extract content of a section by heading text or slug")
  .argument("<file>", "Path to the markdown file")
  .argument("<heading>", "Heading text or anchor slug (case-insensitive)")
  .option("--include-heading", "Include the heading line in output")
  .option("--no-include-heading", "Exclude the heading line from output")
  .option("--children", "Include nested subsections")
  .option("--no-children", "Exclude nested subsections")
  .option("--raw", "Output raw markdown only (no metadata)")
  .option("--no-raw", "Include section metadata")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  Section found and extracted\n  1  File not found or heading not found",
  )
  .action((file: string, heading: string, opts: Record<string, unknown>) =>
    sectionAction(
      file,
      heading,
      commandOptions(
        "section",
        { includeHeading: true, children: true, raw: false },
        opts,
      ) as never,
    ),
  );

common(md.command("context"))
  .description("Assemble a reproducible context pack from the workspace graph")
  .argument("[seeds...]", "Markdown files, directories, or globs to start from")
  .option("--depth <n>", "Graph hops to follow from the seeds (0-6)")
  .option("--section <heading>", "Restrict seeds to this heading (repeatable)", collect)
  .option("--target <path>", "Seed with documents referencing this path[#fragment]")
  .option("--budget <bytes>", "Maximum UTF-8 bytes of unit content, or 0 for unlimited")
  .option("--backlinks", "Also follow references backwards")
  .option("--no-backlinks", "Follow references forwards only")
  .option("--children", "Expand --section through its subsections")
  .option("--no-children", "Limit --section to the named section")
  .option("--frontmatter", "Emit each document's frontmatter as a unit")
  .option("--no-frontmatter", "Omit frontmatter")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Workspace exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nUnits are ordered by graph distance, then discovery order, then document order.\n" +
      "The pack is a prefix of that order: the first unit that would exceed --budget stops\n" +
      "inclusion, and the rest are reported under `omitted`.\n\n" +
      "The token estimate is bytes/4, not a model tokenizer, and never affects inclusion.\n\n" +
      "Exit codes:\n" +
      "  0  Pack written to stdout, whether or not it was truncated\n" +
      "  1  No seeds given, or a --section heading matched nothing",
  )
  .action((seeds: string[], opts: Record<string, unknown>) =>
    contextAction(
      seeds,
      commandOptions(
        "context",
        {
          depth: "1",
          section: [] as string[],
          budget: "0",
          backlinks: false,
          children: true,
          frontmatter: false,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("diff"))
  .description("Summarize Markdown changes by structure rather than by text")
  .argument("[a]", "First file, or the directory to scan with --since")
  .argument("[b]", "Second file; omit when using --since")
  .option("--since <revision>", "Compare the worktree against a Git revision")
  .option("--summary", "Show per-file totals without individual changes")
  .option("--no-summary", "Show individual changes")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Workspace exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nModes:\n" +
      "  md diff <a> <b>              Compare two files.\n" +
      "  md diff --since <rev> [dir]  Compare a revision against the worktree.\n" +
      "Giving two paths and --since together is an error, as is giving neither.\n\n" +
      "--since names the base of the comparison. It is not --changed-since, which\n" +
      "only filters an input set.\n\n" +
      "Renames are matched conservatively and a positional match is reported as a\n" +
      "heuristic, not a fact.\n\n" +
      "Exit codes:\n" +
      "  0  Report written to stdout, whether or not anything changed\n" +
      "  1  Bad invocation, a missing file, or an unreadable revision",
  )
  .action((a: string | undefined, b: string | undefined, opts: Record<string, unknown>) =>
    diffAction(
      a,
      b,
      commandOptions(
        "diff",
        {
          summary: false,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("frontmatter"))
  .description("Parse and display YAML frontmatter from a markdown file")
  .argument("<file>", "Path to the markdown file")
  .option("--key <key>", "Extract a specific key (dot notation for nested keys)")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  Frontmatter found (or no frontmatter)\n  1  File not found or key not found",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    frontmatterAction(file, commandOptions("frontmatter", {}, opts) as never),
  );

common(md.command("tasks"))
  .description("Extract GFM task list items with completion status")
  .argument("<file>", "Path to the markdown file")
  .option("--status <status>", "Filter by status: done, pending")
  .option("--summary", "Show only summary counts")
  .option("--no-summary", "Show individual tasks")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    tasksAction(file, commandOptions("tasks", { summary: false }, opts) as never),
  );

common(md.command("tables"))
  .description("List or extract GFM tables with location and dimensions")
  .argument("<file>", "Path to the markdown file")
  .option("--content", "Include table content in output")
  .option("--no-content", "Exclude table content from output")
  .option("--index <n>", "Extract only the nth table (1-based)")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json",
  )
  .action((file: string, opts: Record<string, unknown>) =>
    tablesAction(file, commandOptions("tables", { content: false }, opts) as never),
  );

common(md.command("check-urls"))
  .description("Validate external URLs across Markdown inputs")
  .argument("<inputs...>", "Markdown files, directories, globs, or -")
  .option("--timeout <ms>", "Request timeout per URL in milliseconds")
  .option("--concurrency <n>", "Maximum concurrent requests")
  .option("--retry <n>", "Number of retries on failure")
  .option("--include-ok", "Include successful URLs in output")
  .option("--no-include-ok", "Exclude successful URLs from output")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .option("--changed-since <revision>", "Only files changed since a Git revision")
  .option("--ignore <glob>", "Ignore matching URL (repeatable)", collect)
  .option("--ignore-domain <domain>", "Ignore domain and subdomains (repeatable)", collect)
  .option("--allowed-status <code>", "Treat HTTP status as allowed (repeatable)", collect)
  .option("--cache", "Use the URL result cache")
  .option("--no-cache", "Disable the URL result cache")
  .option("--cache-ttl <ms>", "URL cache lifetime in milliseconds")
  .option("--head-fallback-status <code>", "HEAD status that triggers GET (repeatable)", collect)
  .option("--report-redirects", "Report redirects and final destinations")
  .option("--no-report-redirects", "Do not report redirects")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  All URLs reachable (or no external URLs)\n  2  One or more URLs are broken",
  )
  .action((file: string[], opts: Record<string, unknown>) =>
    checkUrlsAction(
      file,
      commandOptions(
        "check-urls",
        {
          timeout: "5000",
          concurrency: "5",
          retry: "1",
          includeOk: false,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
          ignore: projectConfig.urls.ignore,
          ignoreDomain: projectConfig.urls.ignoreDomains,
          allowedStatus: projectConfig.urls.allowedStatuses,
          cache: projectConfig.urls.cache,
          cacheTtl: String(projectConfig.urls.cacheTtl),
          headFallbackStatus: projectConfig.urls.headFallbackStatuses,
          reportRedirects: projectConfig.urls.reportRedirects,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("orphans"))
  .description("Find markdown files not referenced by any other markdown file")
  .argument("[directory]", "Directory to scan (default: workspace root)")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .option("--ignore <glob>", "Glob pattern to exclude (repeatable)", collect, [])
  .option("--entry <file>", "Entry-point file not considered orphan (repeatable)", collect, [])
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  No orphans found\n  2  One or more orphans found",
  )
  .action((directory: string | undefined, opts: Record<string, unknown>) =>
    orphansAction(
      directory ?? projectConfig.root,
      commandOptions(
        "orphans",
        {
          ignore: [],
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
          entry: projectConfig.files.entryPoints,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("query"))
  .description("Run a focused query across the Markdown workspace")
  .argument(
    "<kind>",
    "Query kind: links-to, duplicates, unused-assets, code-blocks, tasks, missing-h1, frontmatter-keys",
  )
  .argument("[directory]", "Directory to query (default: workspace root)")
  .option("--target <path>", "Target path and optional heading fragment for links-to")
  .option("--field <field>", "Duplicate field: title, slug, heading-slug, frontmatter:<key>")
  .option("--lang <language>", "Code-block language filter")
  .option("--content", "Include code-block content")
  .option("--no-content", "Exclude code-block content")
  .option("--status <status>", "Task status: all, done, pending")
  .option("--summary", "Show task totals without individual tasks")
  .option("--no-summary", "Include individual tasks")
  .option("--asset-extension <ext>", "Asset extension override (repeatable)", collect)
  .option("--where <predicate>", "Filter predicate (repeatable, AND-ed)", collect)
  .option("--select <fields>", "Comma-separated fields to emit (repeatable)", collect)
  .option("--group-by <field>", "Group rows by one field")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Workspace exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nQuery matches are informational and exit 0.\n\n" +
      "Two modes share the kind argument. Without --where, --select, or --group-by the\n" +
      "shortcut kinds emit their historical shapes unchanged. With any of them the\n" +
      "kind names an entity: documents, headings, links, tasks, code-blocks, frontmatter.\n\n" +
      "Predicates are <field><op><value> with one of = != ~ > >= < <=, or has:<field> /\n" +
      "links-to:<path>, optionally negated with a leading '!'. Repeating --where ANDs\n" +
      "them. `frontmatter.<key>` is a field on every entity.\n\n" +
      "Examples:\n" +
      "  md query documents --where has:h1 --select file,title\n" +
      "  md query links --where links-to:docs/api.md --select file,line\n" +
      "  md query tasks --where status=pending --group-by frontmatter.owner\n\n" +
      "An unknown field, predicate, or operator exits 1 rather than matching nothing.",
  )
  .action((kind: string, directory: string | undefined, opts: Record<string, unknown>) =>
    queryAction(
      kind,
      directory ?? projectConfig.root,
      commandOptions(
        "query",
        {
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
          field: "title",
          content: false,
          status: "all",
          summary: false,
          assetExtension: projectConfig.assets.extensions,
          // Predicates are per-question by nature, so they are deliberately not
          // configurable: a checked-in `commands.query.where` would silently
          // filter every query anyone ran in the workspace.
          where: [] as string[],
          select: [] as string[],
        },
        opts,
      ) as never,
    ),
  );

common(md.command("index"))
  .description("Inspect or manage the persistent workspace index")
  .argument("<action>", "Index action: status, build, clear")
  .argument("[directory]", "Directory to inspect or build (default: workspace root)")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nActions:\n  status  Inspect cache coverage\n  build   Force a rebuild\n  clear   Clear this workspace cache",
  )
  .action((action: string, directory: string | undefined, opts: Record<string, unknown>) =>
    indexAction(
      action,
      directory ?? projectConfig.root,
      commandOptions(
        "index",
        { include: projectConfig.files.include, exclude: projectConfig.files.exclude },
        opts,
      ) as never,
    ),
  );

common(md.command("fix"))
  .description("Plan and apply deterministic Markdown fixes")
  .argument("<inputs...>", "Markdown files, directories, or globs")
  .option("--rule <name>", "Fixer to run (repeatable); default: every fixer", collect)
  .option("--check", "Report pending fixes without writing (default)")
  .option("--dry-run", "Print the full plan without writing")
  .option("--write", "Apply the plan as one transaction")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Workspace exclude glob (repeatable)", collect)
  .option("--changed-since <revision>", "Only files changed since a Git revision")
  .addHelpText(
    "after",
    "\nThe mode defaults to --check, and --check, --dry-run, and --write are mutually\n" +
      "exclusive. The mode cannot be set from project configuration, so a checked-in\n" +
      "config file can never turn md fix into a writer.\n\n" +
      "--write applies every file's edits as one transaction, and refuses to write at\n" +
      "all if any input changed after planning, any two edits overlap, or any target\n" +
      "resolves outside the workspace root.\n\n" +
      "Exit codes:\n" +
      "  0  No pending fixes, or --write/--dry-run completed\n" +
      "  2  --check found pending fixes, or any mode found a conflict",
  )
  .action((inputs: string[], opts: Record<string, unknown>) =>
    fixAction(
      inputs,
      commandOptions(
        "fix",
        {
          rule: [] as string[],
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
          // Config may supply these as numbers; the fixer parses strings, so
          // coerce here exactly as `md audit` does.
          maxDepth: String(projectConfig.commands.toc?.maxDepth ?? "6"),
          minDepth: String(projectConfig.commands.toc?.minDepth ?? "1"),
          ordered: Boolean(projectConfig.commands.toc?.ordered ?? false),
        },
        opts,
      ) as never,
    ),
  );

common(md.command("check-snippets"))
  .description("Compare fenced code blocks against the source regions they declare")
  .argument("[inputs...]", "Markdown files, directories, or globs (default: workspace root)")
  .option("--check", "Report drift without writing (default)")
  .option("--dry-run", "Print the full plan without writing")
  .option("--write", "Refresh linked blocks as one transaction")
  .option("--include-ok", "Include up-to-date snippets in output")
  .option("--no-include-ok", "Exclude up-to-date snippets from output")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Workspace exclude glob (repeatable)", collect)
  .addHelpText(
    "after",
    "\nOnly fences whose info string carries cairn:snippet=<path>[#<region>] are\n" +
      "considered. A snippet is never executed; the source file is only read.\n\n" +
      "The mode defaults to --check, and --check, --dry-run, and --write are mutually\n" +
      "exclusive. The mode cannot be set from project configuration, so a checked-in\n" +
      "config file can never turn this checker into a writer.\n\n" +
      "Source reads are confined to the workspace root; writes are confined to the\n" +
      "directory containing the selected documents.\n\n" +
      "Format shorthands:\n" +
      "  -fh             Shorthand for --format=human\n" +
      "  -fj             Shorthand for --format=json\n\n" +
      "Exit codes:\n" +
      "  0  Every linked snippet matches, or --write refreshed them\n" +
      "  2  --check or --dry-run found drift, or any mode found a link it\n" +
      "     could not resolve, a malformed link, a fence it cannot rewrite,\n" +
      "     or an edit-plan conflict",
  )
  .action((inputs: string[], opts: Record<string, unknown>) =>
    checkSnippetsAction(
      inputs.length ? inputs : [projectConfig.root],
      commandOptions(
        "check-snippets",
        {
          includeOk: false,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("rename-heading"))
  .description("Rename a heading and update all internal anchor references")
  .argument("<file>", "Path to the markdown file containing the heading")
  .argument("<old-heading>", "Current heading text (case-insensitive)")
  .argument("<new-heading>", "New heading text")
  .option("--directory <dir>", "Also update references in other files within this directory")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .option("--dry-run", "Show what would change without modifying files")
  .option("--no-dry-run", "Apply changes")
  .addHelpText(
    "after",
    "\nFormat shorthands:\n  -fh             Shorthand for --format=human\n  -fj             Shorthand for --format=json\n\nExit codes:\n  0  Heading renamed successfully (or dry-run completed)\n  1  File/heading not found or new heading slug already exists",
  )
  .action((file: string, oldHeading: string, newHeading: string, opts: Record<string, unknown>) =>
    renameHeadingAction(
      file,
      oldHeading,
      newHeading,
      commandOptions(
        "rename-heading",
        {
          dryRun: false,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

common(md.command("rename-file"))
  .description("Move a workspace file and update Markdown references")
  .argument("<source>", "Existing Markdown document or referenced asset")
  .argument("<destination>", "New path (parent directory must exist)")
  .option("--include <glob>", "Markdown include glob (repeatable)", collect)
  .option("--exclude <glob>", "Markdown exclude glob (repeatable)", collect)
  .option("--dry-run", "Show changes without modifying files")
  .option("--no-dry-run", "Apply changes")
  .action((source: string, destination: string, opts: Record<string, unknown>) =>
    renameFileAction(
      source,
      destination,
      commandOptions(
        "rename-file",
        {
          dryRun: false,
          include: projectConfig.files.include,
          exclude: projectConfig.files.exclude,
        },
        opts,
      ) as never,
    ),
  );

try {
  await program.parseAsync(argv);
} catch (error) {
  if (error instanceof CommandExit) {
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
runtime().workspace.flush();
