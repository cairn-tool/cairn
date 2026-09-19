import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { cliSchema } from "@cairn-tool/cli-schema";
import {
  EXTERNAL_SCHEMAS,
  SCHEMAS,
  SCHEMA_REFS,
  SCHEMA_REF_BY_ID,
  loadSchema,
  schemaUriFor,
} from "../../src/contract/schemas/index.js";
import { describeSchema } from "../../src/contract/schemas/meta.js";
import {
  inlineAgentBundleSchema as inlineAgentBundleRef,
  installableAgentBundlesSchema as installableAgentBundlesRef,
} from "../../src/contract/schemas/agent-docs.js";
import {
  inlineAgentBundleSchema,
  installableAgentBundlesSchema,
} from "@cairn-tool/agent-bundle-schema";
import { COMMAND_CONTRACTS } from "../../src/contract/registry.js";
import {
  CLI_SCHEMA_URI,
  CONTRACT_VERSION,
  SARIF_SCHEMA_URI,
  SCHEMA_BASE,
  schemaUri,
} from "../../src/contract/version.js";
import { ALL_FORMATS, agentFormatsFor, formatsFor } from "../../src/formats.js";

const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;

function walk(node: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) walk(value, visit);
}

describe("published schemas", () => {
  it("each compiles on its own", () => {
    for (const entry of SCHEMAS) {
      const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
      expect(() => ajv.compile(entry.schema), `${entry.id} must compile`).not.toThrow();
    }
  });

  it("uses unique, well-formed ids", () => {
    const ids = SCHEMA_REFS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of SCHEMAS) {
      expect(entry.uri).toBe(schemaUri("v1", entry.id));
      expect(entry.schema.$id).toBe(entry.uri);
      expect(entry.uri.startsWith(`${SCHEMA_BASE}/v1/`)).toBe(true);
      expect(entry.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(entry.schema.title).toBeTruthy();
    }
  });

  it("never closes a payload to additional properties", () => {
    // Consumers must ignore unknown properties, and adding one must stay a
    // non-breaking change. `additionalProperties: false` would break both.
    for (const entry of SCHEMAS)
      walk(entry.schema, (node) => {
        expect(node.additionalProperties, `${entry.id} closes a payload`).not.toBe(false);
      });
  });

  it("never references another document", () => {
    // A schema retrieved with `cairn schema <id>` must be independently
    // compilable, so every $ref stays within its own document.
    for (const entry of SCHEMAS)
      walk(entry.schema, (node) => {
        if (typeof node.$ref === "string")
          expect(node.$ref.startsWith("#/"), `${entry.id} has external $ref ${node.$ref}`).toBe(
            true,
          );
      });
  });

  it("resolves every $ref it declares", () => {
    for (const entry of SCHEMAS) {
      const defs = Object.keys((entry.schema.$defs as Record<string, unknown>) ?? {});
      walk(entry.schema, (node) => {
        if (typeof node.$ref !== "string") return;
        const name = node.$ref.replace("#/$defs/", "");
        expect(defs, `${entry.id} references missing $def ${name}`).toContain(name);
      });
    }
  });

  it("names only real commands", () => {
    for (const entry of SCHEMA_REFS)
      for (const command of entry.commands)
        expect(
          COMMAND_CONTRACTS[command],
          `${entry.id} names unknown command ${command}`,
        ).toBeDefined();
  });
});

describe("external schemas", () => {
  // Three documents another project owns. `describe` is a cli-schema document;
  // the two artifact schemas are published as `@cairn-tool/agent-bundle-schema`
  // so a documentation pipeline can validate an artifact without depending on
  // this CLI. All three load on demand, because each library's index does work
  // at import and this module sits on every command's path.
  it("is describe and the two artifact schemas", () => {
    expect(EXTERNAL_SCHEMAS.map((entry) => entry.id)).toEqual([
      "describe",
      "inline-agent-bundle",
      "installable-agent-bundles",
    ]);
    for (const id of ["describe", "inline-agent-bundle", "installable-agent-bundles"]) {
      expect(SCHEMAS.some((entry) => entry.id === id)).toBe(false);
      expect(SCHEMA_REFS.some((entry) => entry.id === id)).toBe(true);
    }
  });

  it("serves the artifact documents under the ids the commands declare", async () => {
    // The uri a command's envelope reports has to be the `$id` a consumer will
    // find inside the document, or validation by retrieval breaks.
    expect(inlineAgentBundleRef.uri).toBe(inlineAgentBundleSchema.$id);
    expect(installableAgentBundlesRef.uri).toBe(installableAgentBundlesSchema.$id);
    expect(await loadSchema("inline-agent-bundle")).toBe(inlineAgentBundleSchema);
    expect(await loadSchema("installable-agent-bundles")).toBe(installableAgentBundlesSchema);
  });

  it("composes each artifact schema into a self-contained document", () => {
    const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
    for (const schema of [inlineAgentBundleSchema, installableAgentBundlesSchema]) {
      // Compiled one at a time and with nothing else registered: that is the
      // whole point of inlining the shared definitions, and a stray external
      // `$ref` would only show up here.
      expect(() => new Ajv2020({ strict: false }).compile(schema)).not.toThrow();
      expect(() => ajv.compile(schema)).not.toThrow();
      const defs = Object.keys((schema.$defs as Record<string, unknown>) ?? {});
      walk(schema, (node) => {
        expect(node.additionalProperties, "an artifact schema closes a payload").not.toBe(false);
        if (typeof node.$ref !== "string") return;
        expect(node.$ref.startsWith("#/"), `external $ref ${node.$ref}`).toBe(true);
        expect(defs).toContain(node.$ref.replace("#/$defs/", ""));
      });
    }
  });

  it("serves the library's own document under the library's own id", async () => {
    expect(CLI_SCHEMA_URI).toBe(cliSchema.$id);
    expect(describeSchema.uri).toBe(CLI_SCHEMA_URI);
    expect(await describeSchema.load()).toBe(cliSchema);
    expect(await loadSchema("describe")).toBe(cliSchema);
    expect(await loadSchema("nope")).toBeUndefined();
    expect(cliSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("holds to the same rules as an owned schema", () => {
    const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
    expect(() => ajv.compile(cliSchema)).not.toThrow();
    const defs = Object.keys((cliSchema.$defs as Record<string, unknown>) ?? {});
    walk(cliSchema, (node) => {
      expect(node.additionalProperties, "cli-schema closes a payload").not.toBe(false);
      if (typeof node.$ref !== "string") return;
      expect(node.$ref.startsWith("#/"), `cli-schema has external $ref ${node.$ref}`).toBe(true);
      expect(defs).toContain(node.$ref.replace("#/$defs/", ""));
    });
  });
});

describe("command contract registry", () => {
  const entries = Object.values(COMMAND_CONTRACTS);

  it("keys every entry by its own id", () => {
    for (const [key, contract] of Object.entries(COMMAND_CONTRACTS)) expect(contract.id).toBe(key);
  });

  it("declares a success code and a usable default format", () => {
    for (const contract of entries) {
      expect(
        contract.exitCodes.some((exit) => exit.code === 0),
        contract.id,
      ).toBe(true);
      // A protocol command has no output format at all: `serve` writes JSON-RPC
      // frames to stdout rather than a payload, so there is nothing to select.
      // Both fields are null together or neither is.
      expect(contract.formats === null, contract.id).toBe(contract.defaultFormat === null);
      if (contract.formats === null) continue;
      expect(contract.formats, contract.id).toContain(contract.defaultFormat);
      for (const format of contract.formats) expect(ALL_FORMATS).toContain(format);
    }
  });

  it("declares no duplicate exit codes", () => {
    for (const contract of entries) {
      const codes = contract.exitCodes.map((exit) => exit.code);
      expect(new Set(codes).size, contract.id).toBe(codes.length);
    }
  });

  it("matches the formats each md command actually accepts", () => {
    for (const contract of entries) {
      if (!contract.id.startsWith("md ")) continue;
      expect(contract.formats, contract.id).toEqual(formatsFor(contract.id.slice(3)));
    }
  });

  it("matches the formats each agent command actually accepts", () => {
    for (const contract of entries) {
      if (!contract.id.startsWith("agent ")) continue;
      expect(contract.formats, contract.id).toEqual(agentFormatsFor(contract.id.slice(6)));
    }
  });

  it("only names published schemas", () => {
    for (const contract of entries)
      for (const id of [contract.outputSchema, contract.jsonlSchema])
        if (id)
          expect(SCHEMA_REF_BY_ID.has(id), `${contract.id} names unknown schema ${id}`).toBe(true);
  });

  it("declares a findings stream exactly when it can exit 2", () => {
    for (const contract of entries) {
      const canFail = contract.exitCodes.some((exit) => exit.code === 2);
      expect(Boolean(contract.stream.findings), contract.id).toBe(canFail);
    }
  });

  it("only offers the automation formats to commands that emit findings", () => {
    for (const contract of entries) {
      if (contract.formats === null) {
        expect(contract.jsonlSchema, contract.id).toBeFalsy();
        expect(contract.sarifSchema, contract.id).toBeFalsy();
        continue;
      }
      if (contract.formats.includes("jsonl"))
        expect(contract.jsonlSchema, contract.id).toBeTruthy();
      if (contract.jsonlSchema) expect(contract.formats, contract.id).toContain("jsonl");
      // SARIF is an external standard, so the contract names a URI rather than
      // a published schema id — but the two must still agree in both directions.
      if (contract.formats.includes("sarif"))
        expect(contract.sarifSchema, contract.id).toBe(SARIF_SCHEMA_URI);
      if (contract.sarifSchema) expect(contract.formats, contract.id).toContain("sarif");
    }
  });
});

describe("schema id resolution", () => {
  it("maps a known id to its uri", () => {
    expect(schemaUriFor("md-graph")).toBe(schemaUri("v1", "md-graph"));
    expect(schemaUriFor("describe")).toBe(CLI_SCHEMA_URI);
  });

  it("returns null for an unknown or absent id", () => {
    expect(schemaUriFor("nope")).toBeNull();
    expect(schemaUriFor(null)).toBeNull();
    expect(schemaUriFor(undefined)).toBeNull();
  });

  it("pins the contract version", () => {
    expect(CONTRACT_VERSION).toBe("4");
  });
});
