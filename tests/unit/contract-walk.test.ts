import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { CONTRACT_VERSION as CLI_SCHEMA_VERSION } from "@cairn-tool/cli-schema";
import { buildDescription, walkCommands } from "@cairn-tool/cli-schema-commander";
import { collect } from "../../src/option-utils.js";
import { FORMAT_SHORTHANDS, isRepeatable, walkOptions } from "../../src/contract/walk-options.js";
import { CLI_SCHEMA_URI, CONTRACT_VERSION } from "../../src/contract/version.js";
import { NOTIFIER_CONTRACT } from "../../src/update-notifier.js";

/**
 * The walker itself belongs to `@cairn-tool/cli-schema-commander` and is tested
 * there. What is pinned here is the wiring this repository hands it: the
 * repeatability predicate, the advisory notice, the registry merge, and the
 * schema references.
 */
function program(): Command {
  const root = new Command().name("tool");
  root
    .command("leaf")
    .description("A leaf")
    .option("-r, --repeat <value>", "Accumulates through collect", collect)
    .option("--twin <value>", "A structurally identical accumulator", (value: string, acc = []) => {
      (acc as string[]).push(value);
      return acc;
    })
    .option("--plain", "A boolean")
    .option("--no-plain", "Disable the boolean")
    .action(() => undefined);
  // A real registry id, so the merge can be observed without a fixture registry.
  root
    .command("describe")
    .description("Stands in for the real command")
    .action(() => undefined);
  return root;
}

const leaf = () => walkCommands(program(), walkOptions()).find((command) => command.id === "leaf")!;
const option = (name: string) => leaf().options.find((item) => item.name === name)!;

describe("isRepeatable", () => {
  it("detects repeatability by identity with collect, not by shape", () => {
    expect(option("--repeat").arity).toEqual({ min: 1, max: null });
    expect(option("--twin").arity).toEqual({ min: 1, max: 1 });
  });

  it("leaves flags and negations alone", () => {
    expect(option("--plain").arity).toEqual({ min: 0, max: 0 });
    expect(option("--no-plain").negatable).toBe(true);
    expect(option("--no-plain").arity.max).toBe(0);
  });

  it("is the predicate the walk options carry", () => {
    expect(walkOptions().isRepeatable).toBe(isRepeatable);
  });
});

describe("walkOptions", () => {
  const described = buildDescription(program(), { name: "tool", version: "0.0.0" }, walkOptions());

  it("produces a document versioned by the cli-schema spec, not this contract", () => {
    expect(described.schemaVersion).toBe(CLI_SCHEMA_VERSION);
    expect(described.schemaVersion).not.toBe(CONTRACT_VERSION);
  });

  it("publishes the update notifier's guarantees as the advisory output", () => {
    expect(described.advisoryOutput).toEqual(NOTIFIER_CONTRACT);
    expect(described.advisoryOutput?.optOutEnv).toBe("CAIRN_NO_UPDATE_NOTIFIER");
  });

  it("carries the argv shorthands cli.ts rewrites", () => {
    expect(described.formatShorthands).toEqual(FORMAT_SHORTHANDS);
    expect(described.formatShorthands["-fj"]).toBe("--format=json");
  });

  it("lists every published schema as a reference without a body", () => {
    const ids = described.schemas.map((entry) => entry.id);
    expect(ids).toContain("md-graph");
    expect(ids).toContain("describe");
    for (const entry of described.schemas) {
      expect(entry).not.toHaveProperty("schema");
      expect(entry).not.toHaveProperty("load");
    }
    expect(described.schemas.find((entry) => entry.id === "md-graph")!.uri).toContain(
      "/v1/md-graph.json",
    );
    expect(described.schemas.find((entry) => entry.id === "describe")!.uri).toBe(CLI_SCHEMA_URI);
  });

  it("merges the registry by command id", () => {
    const merged = described.commands.find((command) => command.id === "describe")!;
    expect(merged.stability).toBe("stable");
    expect(merged.outputSchema).toBe("describe");
    expect(merged.exitCodes.map((exit) => exit.code)).toEqual([0, 1]);
    const unknown = described.commands.find((command) => command.id === "leaf")!;
    expect(unknown.stability).toBe("undeclared");
    expect(unknown.outputSchema).toBeNull();
    expect(unknown.exitCodes).toEqual([]);
  });
});
