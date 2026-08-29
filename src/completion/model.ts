import type { Command } from "commander";
import { walkCommands, type DescribedCommand, type DescribedOption } from "../contract/describe.js";
import { COMMAND_CONTRACTS } from "../contract/registry.js";
import { TARGETS } from "../agent/types.js";
import { TOOL_KINDS } from "../usage/events.js";
import {
  AGENT_DIMENSIONS,
  SESSION_SORTS,
  TOKEN_DIMENSIONS,
  TOOL_DIMENSIONS,
} from "../usage/aggregate.js";
import { ARTIFACT_CLASSES } from "../archive/sets.js";
import { ALL_PROVIDERS, providerNames } from "../usage/providers/index.js";

/** The shells a script can be generated for. */
export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

/** What a shell should offer after an option that takes a value. */
export type ValueKind = "none" | "choice" | "file" | "directory" | "free";

export interface CompletionOption {
  /** Long form including the leading dashes, e.g. `--format`. */
  long: string;
  short: string | null;
  description: string;
  takesValue: boolean;
  /** Stays offered after use; a non-repeatable flag is filtered out once given. */
  repeatable: boolean;
  value: ValueKind;
  choices: string[];
}

export interface CompletionCommand {
  /** Space-joined path, e.g. `md graph`. The root is the empty string. */
  id: string;
  path: string[];
  description: string;
  subcommands: string[];
  options: CompletionOption[];
  /** What the first positional argument accepts. */
  argument: { kind: ValueKind; choices: string[] };
}

export interface CompletionModel {
  binary: string;
  version: string;
  commands: CompletionCommand[];
}

/**
 * Option values a shell can offer, keyed `<command id>|<long flag>` with a bare
 * `<long flag>` fallback.
 *
 * Keyed by command because a flag name is not globally unique: `--output` is a
 * render mode on `md graph` and a directory on `agent convert`. Values are read
 * from the real exported vocabularies wherever one exists, so this table cannot
 * drift from what the CLI accepts; `tests/unit/completion.test.ts` asserts every
 * key still resolves to a real command and option.
 */
const CHOICES: Record<string, string[]> = {
  "|--paths": ["absolute", "relative"],
  "|--profile": ["plugin", "project", "both"],
  "|--target": [...TARGETS, "all"],
  "md graph|--output": ["report", "mermaid", "dot"],
  "md query|--field": ["title", "slug", "heading-slug"],
  "md query|--status": ["all", "done", "pending"],
  "md tasks|--status": ["all", "done", "pending"],
  "md refs|--type": ["all", "link", "image"],
  "md links|--type": ["all", "link", "image"],
  "agent import|--from": [
    "auto",
    "claude-code-plugin",
    "claude-code-project",
    "codex",
    "cursor",
    "antigravity",
  ],
  "agent package|--marketplace": ["none", "local", "repo"],
  "agent install|--scope": ["user", "project"],
  "agent uninstall|--scope": ["user", "project"],
  "agent installed|--scope": ["user", "project"],
  "|--provider": [...providerNames(), ALL_PROVIDERS],
  "usage tokens|--by": [...TOKEN_DIMENSIONS],
  "usage tools|--by": [...TOOL_DIMENSIONS],
  "usage tools|--kind": [...TOOL_KINDS],
  "usage sessions|--sort": [...SESSION_SORTS],
  "usage agents|--by": [...AGENT_DIMENSIONS],
  "archive list|--class": [...ARTIFACT_CLASSES],
};

/** Positional arguments whose values are a fixed vocabulary. */
const ARGUMENT_CHOICES: Record<string, string[]> = {
  completion: [...SHELLS],
  "md query": [
    "links-to",
    "duplicates",
    "unused-assets",
    "code-blocks",
    "tasks",
    "missing-h1",
    "frontmatter-keys",
    "documents",
    "headings",
    "links",
    "frontmatter",
  ],
  "md index": ["status", "build", "clear"],
  "agent add": ["skill", "agent", "hook", "rule", "policy", "mcp"],
};

/** Value names that mean "a path", so the shell's own file completion is right. */
const FILE_NAMES = new Set(["file", "files", "path", "paths", "schema", "baseline", "config"]);
const DIRECTORY_NAMES = new Set(["dir", "directory", "output", "source", "root", "into"]);

function valueKind(commandId: string, long: string, valueName: string | null): ValueKind {
  if (!valueName) return "none";
  // `--format` draws its values from the contract rather than from CHOICES,
  // so it needs recognizing here too.
  if (long === "--format") return "choice";
  if (CHOICES[`${commandId}|${long}`] || CHOICES[`|${long}`]) return "choice";
  if (FILE_NAMES.has(valueName)) return "file";
  if (DIRECTORY_NAMES.has(valueName)) return "directory";
  return "free";
}

function choicesFor(commandId: string, long: string): string[] {
  // `--format` is per-command truth: `md audit` accepts jsonl and sarif, most
  // commands do not. Reading the contract keeps the two in step for free.
  if (long === "--format") return [...(COMMAND_CONTRACTS[commandId]?.formats ?? [])];
  return CHOICES[`${commandId}|${long}`] ?? CHOICES[`|${long}`] ?? [];
}

function describeToCompletion(option: DescribedOption, commandId: string): CompletionOption | null {
  if (!option.long) return null;
  const kind = valueKind(commandId, option.long, option.valueName);
  return {
    long: option.long,
    short: option.short ?? null,
    description: option.description,
    takesValue: option.valueName !== null,
    // A negated form (`--no-style`) never accumulates, and commander gives it
    // the same coercion as its positive twin, so trust the flag shape too.
    repeatable: option.repeatable && !option.negated,
    value: kind,
    choices: kind === "choice" ? choicesFor(commandId, option.long) : [],
  };
}

function argumentFor(command: DescribedCommand): { kind: ValueKind; choices: string[] } {
  const choices = ARGUMENT_CHOICES[command.id];
  if (choices) return { kind: "choice", choices };
  const first = command.arguments[0];
  if (!first) return { kind: "none", choices: [] };
  const name = first.name.toLowerCase();
  if (DIRECTORY_NAMES.has(name)) return { kind: "directory", choices: [] };
  if (FILE_NAMES.has(name)) return { kind: "file", choices: [] };
  // `schema [id]` completes to the published ids; anything else is free text.
  return { kind: "free", choices: [] };
}

/**
 * Builds the completion model from the same command walk `describe` uses.
 *
 * Sharing the walk is the point: a new subcommand or option becomes completable
 * without anyone remembering to update a script, and a hidden command
 * (`__refresh-update-cache`) stays excluded because `visibleCommands` already
 * drops it.
 */
export function buildModel(
  program: Command,
  tool: { name: string; version: string },
): CompletionModel {
  const described = walkCommands(program);
  const root: CompletionCommand = {
    id: "",
    path: [],
    description: program.description(),
    subcommands: described
      .filter((command) => command.path.length === 1)
      .map((command) => command.id),
    options: [
      {
        long: "--version",
        short: "-V",
        description: "Show the version",
        takesValue: false,
        repeatable: false,
        value: "none",
        choices: [],
      },
      helpOption(),
    ],
    argument: { kind: "none", choices: [] },
  };
  return {
    binary: program.name(),
    version: tool.version,
    commands: [
      root,
      ...described.map((command) => ({
        id: command.id,
        path: command.path,
        description: command.description,
        subcommands: command.subcommands,
        options: [
          ...command.options
            .map((option) => describeToCompletion(option, command.id))
            .filter((option): option is CompletionOption => option !== null),
          // Commander's implicit help option is not in `command.options`.
          helpOption(),
        ],
        argument: argumentFor(command),
      })),
    ],
  };
}

function helpOption(): CompletionOption {
  return {
    long: "--help",
    short: "-h",
    description: "Show help",
    takesValue: false,
    repeatable: false,
    value: "none",
    choices: [],
  };
}

/** Every command id, root first, in a stable order. */
export function commandIds(model: CompletionModel): string[] {
  return model.commands.map((command) => command.id);
}
