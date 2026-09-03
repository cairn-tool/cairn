import fs from "node:fs";
import path from "node:path";
import type {
  AgentBundle,
  AgentDiagnostic,
  AgentProfile,
  AgentTarget,
  Artifact,
  MarkdownComponent,
  SourceFile,
} from "../types.js";
import { diagnostic, TARGETS } from "../types.js";
import { allFiles } from "../parser.js";
import { policyEntries } from "../render.js";
import { COMPONENT_KEYS } from "../manifest.js";
import { TARGET_PROFILES } from "../targets/index.js";
import type { AuditBaseline } from "./baseline.js";
import { binaryKind } from "../../binary-kind.js";

/** A single file larger than this is worth a reviewer's attention. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** A bundle larger than this is worth a reviewer's attention. */
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/**
 * Directories excluded from the source inventory.
 *
 * These are version-control and dependency infrastructure, not bundle content:
 * the renderer never emits them, so counting them would drown the size and
 * binary checks in noise that can never reach a generated plugin.
 */
export const INVENTORY_EXCLUDED = [".git", "node_modules"];

/**
 * Root variables the targets declare, read from the profiles rather than
 * hardcoded, so a new target's spelling is understood without editing audit.
 */
const RENDERED_PLACEHOLDERS = new Set(
  TARGETS.flatMap((target) => TARGET_PROFILES[target].placeholders.rootVariables),
);

/** Source spellings `rewritePlaceholders` consumes. No profile declares these. */
const SOURCE_PLACEHOLDERS = new Set(["${BUNDLE_ROOT}", "${SKILL_DIR}", "${ARGUMENTS}"]);

const INTERPRETERS = [
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "pwsh",
  "powershell",
];

/** Interpreters and escalators that make a policy prefix meaningless. */
const ESCALATORS = [...INTERPRETERS, "env", "eval", "exec", "xargs", "sudo", "doas"];

/** Commands that fetch and run a package chosen at invocation time. */
const PACKAGE_RUNNERS = ["npx", "pnpx", "bunx", "uvx", "pipx", "dlx"];

const SECRET_KEY =
  /(?:^|[_-])(?:token|secret|password|passwd|apikey|api_key|access_key|credential|private_key|auth)(?:$|[_-])/i;

/** Provider-issued credential prefixes. Prefix-anchored, never entropy alone. */
const SECRET_VALUE =
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/;

/** Keys whose values are structurally long and never credentials. */
const NOT_SECRET_KEYS = new Set([
  "command",
  "args",
  "cwd",
  "url",
  "description",
  "version",
  "sha256",
  "integrity",
]);

/** Extensions whose contents are expected to be binary. */
const BINARY_EXTENSIONS =
  /\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|tgz|tar|wasm|so|dylib)$/i;

export interface AuditCounts {
  error: number;
  warning: number;
  notice: number;
}

export interface AuditSurface {
  /** Hook handlers with a command, across the base events and every override. */
  hooks: number;
  mcpServers: number;
  policies: number;
  /** Files in the bundle-root-relative source inventory. */
  files: number;
  executables: number;
  symlinks: number;
  binaries: number;
  bytes: number;
}

/** One command line this bundle can cause a host to run. */
export interface AuditCommand {
  origin: "hook" | "mcp";
  /** Hook event, or MCP server name. */
  name: string;
  command: string;
  args?: string[];
  /** Set when the command came from a `targets.<target>` override. */
  target?: AgentTarget;
  /** Source file the command was read from. */
  path?: string;
}

export interface AuditReport {
  /**
   * Diagnostic codes this run evaluated. Without it a consumer cannot tell
   * "clean" from "not checked": the rendered checks need `--target` and the
   * drift checks need `--baseline`.
   */
  checks: string[];
  counts: AuditCounts;
  surface: AuditSurface;
  /** Executable and script inventory, using `sbom.json`'s `type` vocabulary. */
  executables: Array<{ path: string; mode: string; sha256: string; kind: string }>;
  commands: AuditCommand[];
  baseline?: AuditBaseline;
  /**
   * What this command does not do. Carried as data rather than as a permanent
   * notice, which would pollute every consumer's diagnostics and every
   * `--strict` run.
   */
  limitations: string[];
}

export const AUDIT_LIMITATIONS = [
  "Static analysis only: no file is executed and no network request is made.",
  "Findings are prompts for human review, not proof that a bundle is malicious.",
  "Heuristics are conservative and readable; an obfuscated command can evade them.",
];

/** Every code the source-only checks can emit. */
export const SOURCE_CHECKS = [
  "AB504",
  "AB505",
  "AB506",
  "AB600",
  "AB601",
  "AB602",
  "AB603",
  "AB604",
  "AB605",
  "AB606",
  "AB607",
  "AB610",
  "AB611",
  "AB612",
  "AB613",
  "AB614",
  "AB620",
  "AB621",
  "AB622",
  "AB623",
  "AB630",
  "AB631",
  "AB632",
  "AB633",
  "AB634",
  "AB640",
  "AB641",
];

/** Codes that additionally require `--target`, because they read rendered output. */
export const RENDERED_CHECKS = ["AB624", "AB642"];

/** Codes that additionally require `--baseline`. */
export const BASELINE_CHECKS = ["AB650", "AB651", "AB652", "AB653", "AB654"];

/**
 * Every code audit itself produces, as opposed to the parse and render
 * diagnostics it forwards. This distinction is what lets a warning about the
 * bundle's review surface fail the command while an approximate mapping — which
 * every codex bundle carries and which says nothing about trust — does not.
 */
export const AUDIT_CODES: ReadonlySet<string> = new Set([
  ...SOURCE_CHECKS,
  ...RENDERED_CHECKS,
  ...BASELINE_CHECKS,
]);

function warn(
  code: string,
  message: string,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  return diagnostic(code, message, "approximate", extra);
}

function note(
  code: string,
  message: string,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  return diagnostic(code, message, "exact", extra);
}

function fail(
  code: string,
  message: string,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  return { ...diagnostic(code, message, "unsupported", extra), severity: "error" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function posix(value: string): string {
  return value.split(path.sep).join("/");
}

/** Splits a command line into tokens, honoring single and double quotes. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

/**
 * Re-exported so `agent audit`'s consumers keep one import site. The
 * implementation moved to `src/binary-kind.ts` when `pdf attachments` needed
 * the same magic-number test; see that module for why it is shared rather than
 * imported across toolsets.
 */
export { binaryKind };

/** Shannon entropy per character, used only to grade a candidate secret. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    total -= probability * Math.log2(probability);
  }
  return total;
}

/**
 * Every file in the bundle, with bundle-root-relative POSIX paths.
 *
 * The normalization is not cosmetic: `bundle.hookFiles` paths are relative to
 * the hook directory, so passing them to the packager's `checkExecutables`
 * would miss the `hooks/` prefix its regex looks for and flag every scaffolded
 * hook script.
 */
export function buildSourceInventory(bundle: AgentBundle): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of fs.readdirSync(bundle.root, { withFileTypes: true })) {
    if (INVENTORY_EXCLUDED.includes(entry.name)) continue;
    const full = path.join(bundle.root, entry.name);
    if (entry.isDirectory())
      files.push(
        ...allFiles(full).map((file) => ({ ...file, path: `${entry.name}/${posix(file.path)}` })),
      );
    else if (entry.isFile() || entry.isSymbolicLink())
      files.push({
        path: entry.name,
        content: fs.readFileSync(full),
        mode: fs.statSync(full).mode & 0o777,
      });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The `targets.<target>` override blocks of a structured component value. */
function overrides(value: Record<string, unknown>): Array<[AgentTarget, Record<string, unknown>]> {
  const targets = record(value.targets);
  if (!targets) return [];
  return TARGETS.flatMap((target) => {
    const override = record(targets[target]);
    return override ? ([[target, override]] as Array<[AgentTarget, Record<string, unknown>]>) : [];
  });
}

/** The event map of a hooks document, in any of the spellings the renderer accepts. */
function hookEvents(value: Record<string, unknown>): Record<string, unknown> {
  return (
    record(value.hooks) ??
    record(value.events) ??
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== "targets"))
  );
}

/** Collects the `command` strings out of a handler, flat or Claude-nested. */
function handlerCommands(handler: unknown): string[] {
  const entry = record(handler);
  if (!entry) return [];
  const found: string[] = [];
  for (const key of ["command", "windowsCommand"])
    if (typeof entry[key] === "string") found.push(entry[key]);
  if (Array.isArray(entry.hooks))
    for (const inner of entry.hooks) found.push(...handlerCommands(inner));
  return found;
}

/** The MCP server map of an mcp document. */
function mcpServers(value: Record<string, unknown>): Record<string, unknown> {
  return record(value.mcpServers) ?? {};
}

/**
 * Every command a hook or MCP server would run, from the base document and from
 * each `targets.<target>` override.
 *
 * Deliberately read from the source rather than from rendered artifacts: the
 * renderer substitutes placeholders but does not change a command's structure,
 * so auditing both would report the same command up to six times.
 */
export function collectCommands(bundle: AgentBundle): AuditCommand[] {
  const commands: AuditCommand[] = [];
  if (bundle.hooks) {
    const push = (source: Record<string, unknown>, target?: AgentTarget): void => {
      for (const [event, handlers] of Object.entries(hookEvents(source)))
        for (const handler of Array.isArray(handlers) ? handlers : [handlers])
          for (const command of handlerCommands(handler))
            commands.push({
              origin: "hook",
              name: event,
              command,
              ...(target ? { target } : {}),
              path: bundle.hooks?.path,
            });
    };
    push(bundle.hooks.value);
    for (const [target, override] of overrides(bundle.hooks.value)) push(override, target);
  }
  if (bundle.mcp) {
    const push = (source: Record<string, unknown>, target?: AgentTarget): void => {
      for (const [name, value] of Object.entries(mcpServers(source))) {
        const server = record(value);
        if (!server || typeof server.command !== "string") continue;
        commands.push({
          origin: "mcp",
          name,
          command: server.command,
          ...(Array.isArray(server.args) ? { args: server.args.map(String) } : {}),
          ...(target ? { target } : {}),
          path: bundle.mcp?.path,
        });
      }
    };
    push(bundle.mcp.value);
    for (const [target, override] of overrides(bundle.mcp.value)) push(override, target);
  }
  return commands;
}

/** Every MCP server declaration, from the base document and each override. */
function collectServers(
  bundle: AgentBundle,
): Array<{ name: string; server: Record<string, unknown>; target?: AgentTarget }> {
  if (!bundle.mcp) return [];
  const found: Array<{ name: string; server: Record<string, unknown>; target?: AgentTarget }> = [];
  const push = (source: Record<string, unknown>, target?: AgentTarget): void => {
    for (const [name, value] of Object.entries(mcpServers(source))) {
      const server = record(value);
      if (server) found.push({ name, server, ...(target ? { target } : {}) });
    }
  };
  push(bundle.mcp.value);
  for (const [target, override] of overrides(bundle.mcp.value)) push(override, target);
  return found;
}

/**
 * Resolves a `${BUNDLE_ROOT}`-anchored path to a bundle-relative one.
 *
 * Only the portable spelling is resolved. `${CLAUDE_PLUGIN_ROOT}` and the other
 * native root variables name the *rendered* tree, whose layout need not mirror
 * the source, so resolving them against the bundle would report files that are
 * present under a different name.
 */
function bundleReference(token: string): string | null {
  const match = token.match(/^(?:\$\{BUNDLE_ROOT\}|\{\{bundleRoot\}\})\/(.+)$/);
  return match ? match[1] : null;
}

/** AB600–AB606: what the commands a host would run actually do. */
export function checkCommands(commands: AuditCommand[], bundle: AgentBundle): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  for (const entry of commands) {
    const where = { component: `${entry.origin}:${entry.name}`, path: entry.path };
    const tokens = [...tokenize(entry.command), ...(entry.args ?? [])];
    const line = [entry.command, ...(entry.args ?? [])].join(" ");
    const first = tokens[0] ?? "";
    const basename = path.posix.basename(first.replace(/\\/g, "/"));

    if (INTERPRETERS.includes(basename)) {
      const flag = tokens.findIndex((token) => ["-c", "-e", "-Command"].includes(token));
      if (flag >= 0 && (tokens[flag + 1] ?? "").length > 0)
        diagnostics.push(
          warn("AB600", `Runs an inline script through ${basename}: ${entry.name}`, {
            ...where,
            remediation: "Move the script into a file this bundle owns, and invoke that.",
          }),
        );
    }

    if (/\$\([^)]*\)|`[^`]*`|(?:^|[^&|])[;|&]|[<>]/.test(line))
      diagnostics.push(
        warn("AB601", `Command uses shell interpolation or chaining: ${entry.name}`, {
          ...where,
          remediation: "Review what the substituted or chained portion can expand to.",
        }),
      );

    for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const spelling = `\${${match[1]}}`;
      if (RENDERED_PLACEHOLDERS.has(spelling) || SOURCE_PLACEHOLDERS.has(spelling)) continue;
      diagnostics.push(
        note("AB602", `Command reads '${spelling}' from the host environment: ${entry.name}`, {
          ...where,
          remediation: "Confirm the host is expected to provide it.",
        }),
      );
    }

    for (const token of tokens)
      if (/^\/(?!\/)/.test(token) || /^[A-Za-z]:[\\/]/.test(token)) {
        diagnostics.push(
          warn("AB603", `Command uses the absolute path '${token}': ${entry.name}`, {
            ...where,
            remediation: "Use ${BUNDLE_ROOT}/… for bundle files, or a bare name resolved on PATH.",
          }),
        );
        break;
      }

    if (
      /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?)\b/.test(line) ||
      /(?:Invoke-Expression|iex)\s*\(/i.test(line)
    )
      diagnostics.push(
        warn("AB606", `Command downloads and executes code: ${entry.name}`, {
          ...where,
          remediation: "Vendor the script into the bundle, or pin and verify what is fetched.",
        }),
      );

    for (const token of tokens) {
      const reference = bundleReference(token);
      if (reference === null) continue;
      const resolved = path.join(bundle.root, reference);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        diagnostics.push(
          fail("AB604", `Command references a missing bundle file: ${reference}`, {
            ...where,
            remediation: "Add the file, or correct the path.",
          }),
        );
        continue;
      }
      const content = fs.readFileSync(resolved);
      const mode = fs.statSync(resolved).mode & 0o777;
      if (content.subarray(0, 2).toString("utf8") === "#!" && (mode & 0o111) === 0)
        diagnostics.push(
          note("AB605", `Script '${reference}' has a shebang but is not executable`, {
            ...where,
            path: resolved,
            remediation: "chmod +x it, or invoke it through its interpreter.",
          }),
        );
    }
  }
  return diagnostics;
}

/** AB610–AB614: what an MCP server connects to and what it is handed. */
export function checkMcp(bundle: AgentBundle): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  for (const { name, server, target } of collectServers(bundle)) {
    const where = {
      component: `mcp:${name}`,
      path: bundle.mcp?.path,
      ...(target ? { target } : {}),
    };
    const transport = server.type ?? server.transport;
    if (
      typeof server.url === "string" ||
      (transport !== undefined && String(transport) !== "stdio")
    )
      diagnostics.push(
        note(
          "AB610",
          `MCP server '${name}' is not a local stdio server` +
            (typeof server.url === "string" ? `: ${server.url}` : ` (${String(transport)})`),
          { ...where, remediation: "Confirm the endpoint and who operates it." },
        ),
      );

    for (const [key, value] of Object.entries(record(server.env) ?? {})) {
      if (typeof value !== "string" || value === "") continue;
      const isReference = /^\$\{[^}]+\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^\{\{[^}]+\}\}$/.test(value);
      if (SECRET_KEY.test(key) && !isReference)
        diagnostics.push(
          warn("AB611", `MCP server '${name}' embeds a literal value in env.${key}`, {
            ...where,
            remediation: "Reference an environment variable instead of inlining the value.",
          }),
        );
      else if (SECRET_VALUE.test(value))
        diagnostics.push(
          warn("AB611", `MCP server '${name}' env.${key} looks like an issued credential`, {
            ...where,
            remediation: "Rotate it and reference an environment variable instead.",
          }),
        );
      else if (
        !NOT_SECRET_KEYS.has(key) &&
        value.length >= 32 &&
        /^[A-Za-z0-9+/=_-]+$/.test(value) &&
        entropy(value) >= 3.5
      )
        diagnostics.push(
          note("AB612", `MCP server '${name}' env.${key} is a high-entropy literal`, {
            ...where,
            remediation: "Confirm it is not a credential.",
          }),
        );
    }

    const inherits =
      server.inheritEnv === true ||
      server.env === true ||
      server.env === "inherit" ||
      server.env === "*" ||
      (Array.isArray(server.passEnv) && server.passEnv.map(String).includes("*")) ||
      server.envFile !== undefined;
    if (inherits)
      diagnostics.push(
        warn("AB613", `MCP server '${name}' inherits broad environment state`, {
          ...where,
          remediation: "List the variables the server actually needs.",
        }),
      );

    if (
      typeof server.command === "string" &&
      PACKAGE_RUNNERS.includes(path.posix.basename(server.command.replace(/\\/g, "/")))
    )
      diagnostics.push(
        note("AB614", `MCP server '${name}' runs a package fetched at launch`, {
          ...where,
          remediation: "Confirm the package and publisher; pin a version.",
        }),
      );
  }
  return diagnostics;
}

/** AB620–AB622: how broad a command policy's grants are. */
export function checkPolicies(bundle: AgentBundle): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  for (const entry of policyEntries(bundle)) {
    const action = String(entry.action ?? entry.decision ?? "prompt");
    if (action !== "allow") continue;
    const rawPattern = entry.pattern ?? entry.prefix ?? entry.command ?? "";
    const pattern = Array.isArray(rawPattern)
      ? rawPattern.flat().map(String).join(" ")
      : String(rawPattern);
    const where = { component: `policy:${pattern || "(empty)"}` };
    const negative = entry.negativeExamples ?? entry.nonMatches;

    if (!Array.isArray(negative) || negative.length === 0)
      diagnostics.push(
        warn("AB620", `Allow rule '${pattern}' has no negative examples`, {
          ...where,
          remediation: "Add the nearest invocation the rule must not permit.",
        }),
      );

    const tokens = pattern.trim().split(/\s+/).filter(Boolean);
    const first = tokens[0] ?? "";
    const basename = path.posix.basename(first.replace(/\\/g, "/"));
    if (first === "" || first === "*" || ESCALATORS.includes(basename))
      diagnostics.push(
        warn("AB621", `Allow rule '${pattern || "(empty)"}' grants an interpreter or wildcard`, {
          ...where,
          remediation: "An interpreter prefix permits any program; narrow it, or use prompt.",
        }),
      );
    else if (tokens.length === 1 && !first.includes("/"))
      diagnostics.push(
        warn("AB622", `Allow rule '${pattern}' permits every subcommand of ${pattern}`, {
          ...where,
          remediation: "Add the subcommand and arguments the rule is meant to permit.",
        }),
      );
  }
  return diagnostics;
}

function componentsOf(bundle: AgentBundle): MarkdownComponent[] {
  return [...bundle.skills, ...bundle.agents, ...bundle.rules];
}

/** AB607, AB623, AB641: the capabilities components declare for themselves. */
export function checkCapabilities(bundle: AgentBundle): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const capabilities = new Set(["read", "write", "shell", "web"]);
  const native = new Set(
    TARGETS.flatMap((target) =>
      Object.values(TARGET_PROFILES[target].tools.capabilities ?? {}).flat(),
    ),
  );
  for (const component of componentsOf(bundle)) {
    const tools = Array.isArray(component.metadata.tools)
      ? component.metadata.tools.map(String)
      : [];
    if (!tools.length) continue;
    const where = { component: component.name, path: component.path };
    if (tools.includes("web") || tools.some((tool) => tool === "WebFetch" || tool === "WebSearch"))
      diagnostics.push(
        note("AB607", `Component '${component.name}' is granted network tools`, where),
      );
    if (tools.includes("shell") || tools.includes("Bash"))
      diagnostics.push(
        note("AB623", `Component '${component.name}' is granted shell access`, where),
      );

    // `mapTools` returns early when an explicit per-target list exists, so a
    // vocabulary complaint would be about a value no target ever reads.
    const targets = record(component.metadata.targets) ?? {};
    if (TARGETS.some((target) => record(targets[target])?.tools !== undefined)) continue;
    const unknown = tools.filter((tool) => !capabilities.has(tool) && !native.has(tool));
    if (unknown.length)
      diagnostics.push(
        warn(
          "AB641",
          `Component '${component.name}' declares unrecognized tools: ${unknown.join(", ")}`,
          {
            ...where,
            remediation:
              "Use a capability (read, write, shell, web), or a targets.<target>.tools override.",
          },
        ),
      );
  }
  return diagnostics;
}

/** AB630–AB634: the shape of the files the bundle carries. */
export function checkInventory(bundle: AgentBundle, files: SourceFile[]): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const declaredAssets = new Set(
    [bundle.marketplace?.icon, ...(bundle.marketplace?.screenshots ?? [])].filter(
      (value): value is string => typeof value === "string",
    ),
  );
  let total = 0;
  for (const file of files) {
    total += file.content.length;
    // Everything reaching here points inside the bundle: the parser throws on a
    // symlink that resolves outside a component directory.
    if (fs.lstatSync(path.join(bundle.root, file.path)).isSymbolicLink())
      diagnostics.push(
        note("AB630", `Symlink in the bundle: ${file.path}`, {
          path: file.path,
          remediation: "Packaging follows it and stores a copy, not a link.",
        }),
      );

    const kind = binaryKind(file.content);
    if (kind)
      diagnostics.push(
        warn("AB631", `Bundled ${kind} executable: ${file.path}`, {
          path: file.path,
          remediation: "Build it from source at install time, or document its provenance.",
        }),
      );
    else if (
      file.content.includes(0) &&
      !BINARY_EXTENSIONS.test(file.path) &&
      // The default assets root; a custom one falls through to this notice,
      // which is the right severity for "look at this file".
      !file.path.startsWith("assets/")
    )
      diagnostics.push(
        note("AB632", `Unexpected binary content: ${file.path}`, { path: file.path }),
      );

    if (file.content.length > MAX_FILE_BYTES && !declaredAssets.has(path.posix.basename(file.path)))
      diagnostics.push(
        note(
          "AB633",
          `File exceeds ${MAX_FILE_BYTES} bytes: ${file.path} (${file.content.length})`,
          { path: file.path },
        ),
      );
  }
  if (total > MAX_TOTAL_BYTES)
    diagnostics.push(
      note("AB634", `Bundle exceeds ${MAX_TOTAL_BYTES} bytes (${total})`, {
        remediation: "Consider fetching large resources at install time instead.",
      }),
    );
  return diagnostics;
}

/** AB640: manifest component roots that name nothing. */
export function checkManifestClaims(bundle: AgentBundle): AgentDiagnostic[] {
  if (bundle.legacy) return [];
  const declared = record(bundle.manifest.components) ?? {};
  const populated: Record<string, boolean> = {
    skills: bundle.skills.length > 0,
    agents: bundle.agents.length > 0,
    rules: bundle.rules.length > 0,
    hooks: bundle.hooks !== undefined,
    policies: bundle.policies.length > 0,
    mcp: bundle.mcp !== undefined,
    assets: bundle.assets.length > 0,
  };
  return COMPONENT_KEYS.filter(
    (key) => (declared[key] !== undefined || bundle.manifest[key] !== undefined) && !populated[key],
  ).map((key) =>
    note("AB640", `The manifest declares a component root '${key}' that holds nothing`, {
      remediation: "Add the component, or drop the declaration.",
    }),
  );
}

/** AB624, AB642: what the rendered output grants and claims. */
export function checkRendered(
  bundle: AgentBundle,
  artifacts: Artifact[],
  targets: AgentTarget[],
  profiles: AgentProfile[],
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const unbounded = /^Bash\(\s*[*:]/;

  for (const artifact of artifacts) {
    if (!/(^|\/)\.claude\/settings\.json$/.test(artifact.path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifact.content.toString("utf8"));
    } catch {
      continue;
    }
    const allow = record(record(parsed)?.permissions)?.allow;
    for (const grant of Array.isArray(allow) ? allow.map(String) : [])
      if (unbounded.test(grant))
        diagnostics.push(
          warn("AB624", `Rendered permission grants unrestricted shell: ${grant}`, {
            path: artifact.path,
            remediation: "Give the policy rule a command prefix.",
          }),
        );
  }

  // Frontmatter passes through `metadataFor` untouched, so a hand-written
  // allowed-tools entry reaches the emitted component verbatim.
  for (const component of componentsOf(bundle)) {
    const raw = component.metadata["allowed-tools"] ?? component.metadata.permissions;
    const values = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
    for (const value of values)
      if (/Bash\(\s*[*:]?\s*\*?\s*\)/.test(value) || unbounded.test(value))
        diagnostics.push(
          warn("AB624", `Component '${component.name}' grants unrestricted shell: ${value}`, {
            component: component.name,
            path: component.path,
            remediation: "Name the commands the component needs.",
          }),
        );
  }

  // Skipped for a bundle with no components at all: the manifest still names
  // the default roots, and reporting them would fail a bare `agent init`.
  if (!componentsOf(bundle).length && !bundle.hooks && !bundle.mcp) return diagnostics;
  for (const target of targets)
    for (const profile of profiles) {
      const prefix = `${target}/${profile}/`;
      const paths = artifacts
        .filter((artifact) => artifact.path.startsWith(prefix))
        .map((artifact) => artifact.path.slice(prefix.length));
      // The manifest location is profile data, never a guess at a filename.
      const spec = TARGET_PROFILES[target].manifest;
      if (spec.directory === null) continue;
      const manifestArtifact = artifacts.find(
        (artifact) => artifact.path === `${prefix}${spec.directory}/${spec.file}`,
      );
      if (!manifestArtifact) continue;
      let manifest: Record<string, unknown> | undefined;
      try {
        manifest = record(JSON.parse(manifestArtifact.content.toString("utf8")));
      } catch {
        continue;
      }
      for (const key of ["skills", "agents", "hooks", "mcpServers"]) {
        const claim = manifest?.[key];
        if (typeof claim !== "string") continue;
        const normalized = claim.replace(/^\.\//, "").replace(/\/$/, "");
        if (!normalized) continue;
        if (
          !paths.some(
            (candidate) => candidate === normalized || candidate.startsWith(`${normalized}/`),
          )
        )
          diagnostics.push(
            note("AB642", `The rendered manifest claims '${key}: ${claim}', which has no files`, {
              target,
              profile,
              path: manifestArtifact.path,
            }),
          );
      }
    }
  return diagnostics;
}
