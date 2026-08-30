import { schemaUri } from "../version.js";
import type { SchemaEntry } from "../types.js";
import { DRAFT, stringArray } from "./shared.js";

const TARGETS = ["claude-code", "codex", "cursor", "antigravity", "opencode"];
const PROFILES = ["plugin", "project"];

export const agentResultSchema: SchemaEntry = {
  id: "agent-result",
  uri: schemaUri("v1", "agent-result"),
  title: "Agent command result",
  commands: [
    "agent convert",
    "agent validate",
    "agent inspect",
    "agent compat",
    "agent doctor",
    "agent specs",
    "agent init",
    "agent add",
    "agent upgrade",
    "agent import",
    "agent package",
    "agent audit",
    "agent test",
    "agent install",
    "agent uninstall",
    "agent installed",
    "agent marketplace",
    "agent verify",
  ],
  schema: {
    $schema: DRAFT,
    $id: schemaUri("v1", "agent-result"),
    title: "Agent command result",
    description:
      "Shared by every agent subcommand, including the failure form: an invocation error emits ok=false with a single AB000 diagnostic and exits 1. All agent output goes to stdout, including failures.",
    type: "object",
    required: ["command", "ok", "targets", "artifacts", "diagnostics"],
    properties: {
      command: {
        enum: [
          "convert",
          "validate",
          "inspect",
          "compat",
          "doctor",
          "specs",
          "init",
          "add",
          "upgrade",
          "import",
          "package",
          "audit",
          "test",
          "install",
          "uninstall",
          "installed",
          "marketplace",
          "verify",
        ],
      },
      ok: { type: "boolean" },
      source: { type: "string", description: "Resolved bundle root, when one was given." },
      targets: { type: "array", items: { enum: TARGETS } },
      profiles: { type: "array", items: { enum: PROFILES } },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "bytes", "mode"],
          properties: {
            path: { type: "string" },
            bytes: { type: "integer", minimum: 0 },
            mode: { type: "string", description: "Octal file mode, e.g. '0644'." },
            origin: {
              enum: ["portable", "native"],
              description:
                "Emitted only for artifacts contributed by a native overlay. Absent means portable.",
            },
          },
        },
      },
      diagnostics: { type: "array", items: { $ref: "#/$defs/diagnostic" } },
      bundle: { description: "The normalized bundle, emitted by `agent inspect`." },
      compatibility: {
        description: "Per-component summary keyed by target, emitted by `agent compat`.",
        type: "object",
        additionalProperties: { type: "object", additionalProperties: { type: "string" } },
      },
      specs: { description: "The target conformance profiles, emitted by `agent specs`." },
      doctor: { $ref: "#/$defs/doctor" },
      upgrade: {
        description: "Migration result, emitted by `agent upgrade`.",
        type: "object",
        required: ["from", "to", "changes", "notes"],
        properties: {
          from: {
            type: "string",
            description: "Source schema version, as the manifest spells it.",
          },
          to: { type: "string" },
          changes: {
            type: "array",
            items: {
              type: "object",
              required: ["field"],
              properties: {
                field: { type: "string" },
                from: { description: "Absent when the field is being added." },
                to: { description: "Absent when the field is being removed." },
              },
            },
          },
          notes: {
            description: "Items needing human judgment, mirrored as AB221 notices.",
            type: "array",
            items: { type: "string" },
          },
        },
      },
      package: {
        description: "Packaging result, emitted by `agent package`.",
        type: "object",
        required: ["catalogs", "archives", "checksums", "sbom", "checks"],
        properties: {
          catalogs: {
            type: "array",
            items: {
              type: "object",
              required: ["target", "profile", "path"],
              properties: {
                target: { enum: TARGETS },
                profile: { enum: PROFILES },
                path: { type: "string" },
              },
            },
          },
          archives: {
            type: "array",
            items: {
              type: "object",
              required: ["target", "profile", "path", "sha256", "bytes"],
              properties: {
                target: { enum: TARGETS },
                profile: { enum: PROFILES },
                path: { type: "string" },
                sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                bytes: { type: "integer", minimum: 0 },
              },
            },
          },
          checksums: { type: "string", description: "Path to the sha256sum-compatible file." },
          sbom: { type: "string", description: "Path to the file inventory." },
          checks: {
            type: "object",
            required: ["passed", "failed"],
            properties: {
              passed: { type: "integer", minimum: 0 },
              failed: { type: "integer", minimum: 0 },
            },
          },
        },
      },
      marketplace: {
        description: "Collection build result, emitted by `agent marketplace`.",
        type: "object",
        required: ["name", "version", "targets", "archives", "checksums", "sbom", "checks"],
        properties: {
          name: { type: "string", description: "Catalog name; also the host marketplace key." },
          version: { type: "string", description: "The collection's own version." },
          targets: {
            type: "array",
            items: {
              type: "object",
              required: ["target", "catalog", "plugins"],
              properties: {
                target: { enum: TARGETS },
                catalog: {
                  type: ["string", "null"],
                  description: "Aggregated catalog path, or null when the target declares none.",
                },
                plugins: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "version", "source"],
                    properties: {
                      name: { type: "string" },
                      version: { type: "string" },
                      source: { type: "string", description: "Spec-relative bundle path." },
                    },
                  },
                },
              },
            },
          },
          archives: {
            type: "array",
            items: {
              type: "object",
              required: ["target", "profile", "path", "sha256", "bytes"],
              properties: {
                target: { enum: TARGETS },
                profile: { enum: PROFILES },
                path: { type: "string" },
                sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                bytes: { type: "integer", minimum: 0 },
              },
            },
          },
          checksums: { type: "string", description: "Path to the sha256sum-compatible file." },
          sbom: { type: "string", description: "Path to the file inventory." },
          checks: {
            type: "object",
            required: ["passed", "failed"],
            properties: {
              passed: { type: "integer", minimum: 0 },
              failed: { type: "integer", minimum: 0 },
            },
          },
        },
      },
      audit: {
        description: "Review surface and findings summary, emitted by `agent audit`.",
        type: "object",
        required: ["checks", "counts", "surface", "executables", "commands", "limitations"],
        properties: {
          checks: {
            description:
              "Diagnostic codes this run evaluated. The rendered checks require --target and the drift checks require --baseline, so this is what distinguishes 'clean' from 'not checked'.",
            ...stringArray,
          },
          counts: {
            type: "object",
            required: ["error", "warning", "notice"],
            properties: {
              error: { type: "integer", minimum: 0 },
              warning: { type: "integer", minimum: 0 },
              notice: { type: "integer", minimum: 0 },
            },
          },
          surface: {
            description: "What the bundle carries, whether or not anything was found.",
            type: "object",
            required: [
              "hooks",
              "mcpServers",
              "policies",
              "files",
              "executables",
              "symlinks",
              "binaries",
              "bytes",
            ],
            properties: {
              hooks: { type: "integer", minimum: 0 },
              mcpServers: { type: "integer", minimum: 0 },
              policies: { type: "integer", minimum: 0 },
              files: { type: "integer", minimum: 0 },
              executables: { type: "integer", minimum: 0 },
              symlinks: { type: "integer", minimum: 0 },
              binaries: { type: "integer", minimum: 0 },
              bytes: { type: "integer", minimum: 0 },
            },
          },
          executables: {
            type: "array",
            items: {
              type: "object",
              required: ["path", "mode", "sha256", "kind"],
              properties: {
                path: { type: "string" },
                mode: { type: "string", description: "Octal file mode, e.g. '0755'." },
                sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                kind: {
                  type: "string",
                  description: "Content-derived type, using the sbom.json vocabulary.",
                },
              },
            },
          },
          commands: {
            description: "Every command a hook or MCP server would cause a host to run.",
            type: "array",
            items: {
              type: "object",
              required: ["origin", "name", "command"],
              properties: {
                origin: { enum: ["hook", "mcp"] },
                name: { type: "string", description: "Hook event, or MCP server name." },
                command: { type: "string" },
                args: stringArray,
                target: {
                  enum: TARGETS,
                  description: "Present when the command came from a targets.<target> override.",
                },
                path: { type: "string" },
              },
            },
          },
          baseline: {
            description: "Present only when --baseline was given.",
            type: "object",
            required: ["path", "compared", "added", "removed", "changed", "modeChanged"],
            properties: {
              path: { type: "string" },
              subject: {
                type: ["object", "null"],
                properties: { name: { type: "string" }, version: { type: "string" } },
              },
              generator: {
                type: ["object", "null"],
                properties: { name: { type: "string" }, version: { type: "string" } },
              },
              compared: { type: "integer", minimum: 0 },
              added: stringArray,
              removed: stringArray,
              changed: stringArray,
              modeChanged: {
                type: "array",
                items: {
                  type: "object",
                  required: ["path", "from", "to"],
                  properties: {
                    path: { type: "string" },
                    from: { type: "string" },
                    to: { type: "string" },
                  },
                },
              },
            },
          },
          limitations: {
            description:
              "What this command does not do. Carried as data rather than as a permanent notice, which would pollute every consumer's diagnostics and every --strict run.",
            ...stringArray,
          },
        },
      },
      test: {
        description: "Contract test results, emitted by `agent test`.",
        type: "object",
        required: ["schemaVersion", "files", "checks", "counts", "cases", "native"],
        properties: {
          schemaVersion: {
            type: "string",
            description:
              "The test-file format this release reads. Hand-owned, and independent of the package, contract, target-profile, and bundle versions.",
          },
          files: {
            description: "Test files loaded, bundle-relative POSIX.",
            ...stringArray,
          },
          checks: {
            description:
              "Assertion codes this run can report. Like `audit.checks`, this is what distinguishes 'every expectation held' from 'nothing was expected'.",
            ...stringArray,
          },
          counts: {
            type: "object",
            required: ["cases", "passed", "failed", "skipped", "assertions"],
            properties: {
              cases: { type: "integer", minimum: 0 },
              passed: { type: "integer", minimum: 0 },
              failed: { type: "integer", minimum: 0 },
              skipped: { type: "integer", minimum: 0 },
              assertions: { type: "integer", minimum: 0 },
            },
          },
          cases: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "file", "status", "targets", "profiles", "assertions", "failures"],
              properties: {
                name: { type: "string" },
                file: { type: "string" },
                status: { enum: ["passed", "failed", "skipped"] },
                targets: {
                  description: "The selection actually evaluated, after every filter.",
                  type: "array",
                  items: { enum: TARGETS },
                },
                profiles: { type: "array", items: { enum: PROFILES } },
                assertions: {
                  type: "object",
                  required: ["total", "passed", "failed"],
                  properties: {
                    total: { type: "integer", minimum: 0 },
                    passed: { type: "integer", minimum: 0 },
                    failed: { type: "integer", minimum: 0 },
                  },
                },
                failures: {
                  type: "array",
                  items: {
                    type: "object",
                    required: [
                      "code",
                      "assertion",
                      "message",
                      "expected",
                      "actual",
                      "target",
                      "profile",
                    ],
                    properties: {
                      code: { type: "string", pattern: "^AB[0-9]{3}$" },
                      assertion: {
                        type: "string",
                        description: "Which expectation failed, e.g. `paths.present`.",
                      },
                      message: { type: "string" },
                      expected: { type: "string" },
                      actual: { type: "string" },
                      target: { enum: TARGETS },
                      profile: { enum: PROFILES },
                    },
                  },
                },
                reason: {
                  type: "string",
                  description: "Why a case was skipped. Present only on `skipped`.",
                },
              },
            },
          },
          native: {
            type: "array",
            maxItems: 0,
            description:
              "Reserved for evidence from a host's own validator. Always empty: agent test never spawns a process.",
          },
        },
      },
      install: {
        description:
          "Install, uninstall, or listing result, emitted by `agent install`, `agent uninstall`, and `agent installed`.",
        type: "object",
        required: ["installs"],
        properties: {
          installs: {
            type: "array",
            items: {
              type: "object",
              required: [
                "name",
                "version",
                "target",
                "profile",
                "scope",
                "layout",
                "mode",
                "destination",
                "registered",
                "files",
              ],
              properties: {
                name: { type: "string" },
                version: { type: "string" },
                target: { enum: TARGETS },
                profile: { enum: PROFILES },
                scope: { enum: ["user", "project"] },
                layout: { enum: ["plugin-dir", "merge", "marketplace"] },
                mode: { enum: ["copy", "link"] },
                destination: { type: "string" },
                registered: { type: "boolean" },
                files: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
      verify: {
        description: "Drift and pin result, emitted by `agent verify`.",
        type: "object",
        required: ["config", "generator", "profileSchemaVersion", "pins", "entries", "counts"],
        properties: {
          config: {
            type: "object",
            required: ["path", "entries"],
            properties: {
              path: { type: "string", description: "The document the block was read from." },
              entries: { type: "integer", minimum: 0 },
            },
          },
          generator: {
            type: "object",
            required: ["name", "version"],
            description: "The build performing the verification, which is what the pins bound.",
            properties: { name: { type: "string" }, version: { type: "string" } },
          },
          profileSchemaVersion: { type: "string" },
          pins: {
            type: "object",
            description:
              "Every pin reports `actual` even when unpinned, so a consumer can write the pin from the output.",
            required: ["cli", "profileSchemaVersion", "targets"],
            properties: {
              cli: {
                type: "object",
                required: ["declared", "actual", "status"],
                properties: {
                  declared: { type: ["object", "null"] },
                  actual: { type: "string" },
                  status: { enum: ["satisfied", "violated", "unpinned"] },
                },
              },
              profileSchemaVersion: {
                type: "object",
                required: ["declared", "actual", "status"],
                properties: {
                  declared: { type: ["string", "null"] },
                  actual: { type: "string" },
                  status: { enum: ["satisfied", "violated", "unpinned"] },
                },
              },
              targets: {
                type: "array",
                items: {
                  type: "object",
                  required: ["target", "declared", "actual", "status"],
                  properties: {
                    target: { enum: TARGETS },
                    declared: { type: ["object", "null"] },
                    actual: {
                      type: "string",
                      description: "The target profile's documentation revision, an ISO date.",
                    },
                    status: { enum: ["satisfied", "violated", "unpinned"] },
                  },
                },
              },
            },
          },
          entries: {
            type: "array",
            items: {
              type: "object",
              required: [
                "name",
                "bundle",
                "target",
                "profile",
                "scope",
                "layout",
                "destination",
                "mode",
                "expected",
                "missing",
                "changed",
                "orphaned",
                "unmanaged",
                "ok",
              ],
              properties: {
                name: { type: "string" },
                bundle: { type: "string" },
                target: { enum: TARGETS },
                profile: { enum: PROFILES },
                scope: { enum: ["user", "project"] },
                layout: { enum: ["merge", "plugin-dir", "conversion"] },
                destination: { type: "string" },
                mode: {
                  enum: ["off", "orphaned", "strict"],
                  description: "How far the entry looks for files the render does not account for.",
                },
                expected: { type: "integer", minimum: 0 },
                missing: { ...stringArray, description: "Expected paths absent from the tree." },
                changed: {
                  ...stringArray,
                  description: "Expected paths whose bytes or mode differ.",
                },
                orphaned: {
                  ...stringArray,
                  description: "Paths a prior install recorded that the bundle no longer renders.",
                },
                unmanaged: {
                  ...stringArray,
                  description:
                    "Paths inside managed territory that neither the render nor the inventory accounts for.",
                },
                provenance: {
                  type: "object",
                  description:
                    "Corroboration read from the destination, when it carries a document. Absent otherwise; it never decides the verdict.",
                  required: ["source", "generator", "profileSchemaVersion", "status"],
                  properties: {
                    source: { type: "string" },
                    generator: { type: ["object", "null"] },
                    profileSchemaVersion: {
                      type: ["string", "null"],
                      description: "Null for an install manifest, which records none.",
                    },
                    status: { enum: ["matching", "older", "newer", "malformed"] },
                  },
                },
                ok: { type: "boolean" },
              },
            },
          },
          counts: {
            type: "object",
            required: ["entries", "ok", "missing", "changed", "orphaned", "unmanaged"],
            properties: {
              entries: { type: "integer", minimum: 0 },
              ok: { type: "integer", minimum: 0 },
              missing: { type: "integer", minimum: 0 },
              changed: { type: "integer", minimum: 0 },
              orphaned: { type: "integer", minimum: 0 },
              unmanaged: { type: "integer", minimum: 0 },
            },
          },
        },
      },
      plan: {
        description:
          "What a writing command did or would do, emitted by `agent init` and `agent add`.",
        type: "object",
        required: ["root", "operations"],
        properties: {
          root: { type: "string" },
          operations: {
            type: "array",
            items: {
              type: "object",
              required: ["action", "path", "kind", "bytes", "mode"],
              properties: {
                action: { enum: ["create", "update", "skip"] },
                path: { type: "string", description: "POSIX path relative to `root`." },
                kind: { type: "string" },
                bytes: { type: "integer", minimum: 0 },
                mode: { type: "string", description: "Octal file mode, e.g. '0644'." },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      dryRun: { type: "boolean" },
      check: { type: "boolean" },
      stale: { type: "boolean" },
    },
    $defs: {
      renderedPath: {
        type: "object",
        required: ["target", "profile", "path"],
        properties: {
          target: { enum: TARGETS },
          profile: { enum: PROFILES },
          path: { type: "string" },
        },
      },
      diagnostic: {
        type: "object",
        required: ["code", "severity", "message", "quality"],
        properties: {
          code: { type: "string", pattern: "^AB[0-9]{3}$" },
          severity: { enum: ["notice", "warning", "error"] },
          message: { type: "string" },
          quality: { enum: ["exact", "approximate", "unsupported"] },
          component: { type: "string" },
          path: { type: "string" },
          target: { enum: TARGETS },
          profile: { enum: PROFILES },
          remediation: { type: "string" },
        },
      },
      doctor: {
        type: "object",
        required: ["hosts", "undeclared", "native"],
        properties: {
          hosts: {
            type: "array",
            items: {
              type: "object",
              required: [
                "target",
                "requested",
                "minimumVersion",
                "verifiedThrough",
                "documentationRevision",
                "status",
              ],
              properties: {
                target: { enum: TARGETS },
                requested: { type: ["string", "null"] },
                minimumVersion: { type: ["string", "null"] },
                verifiedThrough: { type: ["string", "null"] },
                documentationRevision: { type: "string" },
                status: {
                  enum: ["unknown", "unverified", "below-minimum", "verified", "newer"],
                },
              },
            },
          },
          output: {
            description: "Present only when --output was given.",
            type: "object",
            required: ["root", "missing", "changed", "unmanaged"],
            properties: {
              root: { type: "string" },
              missing: stringArray,
              changed: stringArray,
              unmanaged: stringArray,
            },
          },
          undeclared: {
            type: "array",
            items: { $ref: "#/$defs/renderedPath" },
          },
          overlays: {
            description:
              "Paths contributed by a native overlay. Exempt from the declared-path check by design, so they are reported here rather than under `undeclared`.",
            type: "array",
            items: { $ref: "#/$defs/renderedPath" },
          },
          native: {
            type: "array",
            maxItems: 0,
            description:
              "Reserved for evidence from a host's own validator. Always empty: agent doctor never spawns a process.",
          },
        },
      },
    },
  },
};
