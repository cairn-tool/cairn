import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { SCHEMAS, SCHEMA_BY_ID, schemaUriFor } from "../../src/contract/schemas/index.js";
import { COMMAND_CONTRACTS } from "../../src/contract/registry.js";
import {
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
    const ids = SCHEMAS.map((entry) => entry.id);
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
    for (const entry of SCHEMAS)
      for (const command of entry.commands)
        expect(
          COMMAND_CONTRACTS[command],
          `${entry.id} names unknown command ${command}`,
        ).toBeDefined();
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
          expect(SCHEMA_BY_ID.has(id), `${contract.id} names unknown schema ${id}`).toBe(true);
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
  });

  it("returns null for an unknown or absent id", () => {
    expect(schemaUriFor("nope")).toBeNull();
    expect(schemaUriFor(null)).toBeNull();
    expect(schemaUriFor(undefined)).toBeNull();
  });

  it("pins the contract version", () => {
    expect(CONTRACT_VERSION).toBe("3");
  });
});
