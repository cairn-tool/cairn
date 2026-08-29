import type { SchemaEntry } from "../types.js";
import { schemaUri } from "../version.js";
import { DRAFT, stringArray } from "./shared.js";

/**
 * The consulted-file record, inlined into both documents rather than shared by
 * `$ref`: a schema retrieved with `cairn schema <id>` must compile alone.
 */
const CONSULTED = {
  type: "array",
  description: "Every configuration file the upward walk opened, nearest first.",
  items: {
    type: "object",
    required: ["file", "directory", "distance", "status", "names"],
    properties: {
      file: { type: "string" },
      directory: { type: "string" },
      distance: {
        type: "integer",
        minimum: 0,
        description: "Directory levels above the invocation directory; 0 is that directory.",
      },
      status: { enum: ["defines", "declares", "no-scripts", "invalid", "skipped"] },
      reason: { type: "string", description: "Set for 'invalid' and 'skipped'." },
      names: stringArray,
    },
  },
};

const BOUNDARY = {
  type: "object",
  description: "Where the upward walk stopped.",
  required: ["directory", "kind"],
  properties: {
    directory: { type: "string" },
    kind: { enum: ["explicit-root", "git-root", "nearest-config", "single-config", "disabled"] },
  },
};

const COMMAND = {
  type: "object",
  required: ["form"],
  properties: {
    form: { enum: ["run", "exec"] },
    run: { type: "string", description: "Shell body, present when form is 'run'." },
    exec: { ...stringArray, description: "Argv, present when form is 'exec'." },
    shell: { type: "string", description: "Shell override; absent means /bin/sh." },
  },
};

export const scriptRunSchema: SchemaEntry = {
  id: "script-run",
  uri: schemaUri("v1", "script-run"),
  title: "Script run result",
  commands: ["scripts run"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "script-run"),
    title: "Script run result",
    description:
      "Emitted by `scripts run --format json`, which captures the script's streams instead of passing them through. `exit.status` is the status the same run would have exited with in llm or human format.",
    type: "object",
    required: [
      "name",
      "registry",
      "workingDirectory",
      "invokedFrom",
      "command",
      "args",
      "exit",
      "stdout",
      "stderr",
      "truncated",
      "durationMs",
    ],
    properties: {
      name: { type: "string" },
      registry: { type: "string", description: "The .cairn.yml that defined the script." },
      workingDirectory: { type: "string", description: "Directory the script ran in." },
      invokedFrom: { type: "string", description: "Directory the command was invoked from." },
      command: COMMAND,
      args: { ...stringArray, description: "Arguments forwarded after `--`." },
      exit: {
        type: "object",
        required: ["code", "signal", "status"],
        properties: {
          code: { type: ["integer", "null"], description: "Null when a signal killed the child." },
          signal: { type: ["string", "null"] },
          status: {
            type: "integer",
            minimum: 0,
            description: "Pass-through status: the code, or 128 + the signal number.",
          },
        },
      },
      stdout: { type: "string" },
      stderr: { type: "string" },
      truncated: {
        type: "object",
        description: "Whether captured output hit the 8 MiB cap.",
        required: ["stdout", "stderr"],
        properties: { stdout: { type: "boolean" }, stderr: { type: "boolean" } },
      },
      durationMs: { type: "integer", minimum: 0 },
      startupError: {
        type: "string",
        description:
          "Present when the child never started, e.g. the program was not found. Distinct from a script that ran and failed.",
      },
    },
  },
};

export const scriptWhichSchema: SchemaEntry = {
  id: "script-which",
  uri: schemaUri("v1", "script-which"),
  title: "Script resolution",
  commands: ["scripts which"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "script-which"),
    title: "Script resolution",
    description:
      "Emitted by `scripts which --format json`. Reports which registry wins for the invocation directory, and which same-named definitions it shadows.",
    type: "object",
    required: ["name", "found", "boundary", "invokedFrom", "shadowed", "consulted"],
    properties: {
      name: { type: "string" },
      found: { type: "boolean" },
      boundary: BOUNDARY,
      invokedFrom: { type: "string" },
      registry: { type: "string", description: "Absent when the name did not resolve." },
      workingDirectory: { type: "string" },
      description: { type: "string" },
      command: COMMAND,
      shadowed: {
        type: "array",
        description: "Farther definitions of the same name, nearest first.",
        items: {
          type: "object",
          required: ["file"],
          properties: { file: { type: "string" }, description: { type: "string" } },
        },
      },
      consulted: CONSULTED,
    },
  },
};

export const scriptListSchema: SchemaEntry = {
  id: "script-list",
  uri: schemaUri("v1", "script-list"),
  title: "Script listing",
  commands: ["scripts list"],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "script-list"),
    title: "Script listing",
    description:
      "Emitted by `scripts list --format json`. One entry per visible name, after nearest-definition-wins has been applied.",
    type: "object",
    required: ["boundary", "invokedFrom", "scripts", "consulted", "invalid"],
    properties: {
      boundary: BOUNDARY,
      invokedFrom: { type: "string" },
      scripts: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "form", "file", "directory", "workingDirectory", "shadows"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            form: { enum: ["run", "exec"] },
            run: { type: "string" },
            exec: stringArray,
            shell: { type: "string" },
            file: { type: "string" },
            directory: { type: "string" },
            workingDirectory: { type: "string" },
            shadows: { ...stringArray, description: "Files whose same-named definition lost." },
          },
        },
      },
      consulted: CONSULTED,
      invalid: {
        type: "integer",
        minimum: 0,
        description: "Consulted files that could not be read. Any non-zero count exits 2.",
      },
    },
  },
};
