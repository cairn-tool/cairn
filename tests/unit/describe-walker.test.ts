import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { buildDescription, selectCommands, walkCommands } from "../../src/contract/describe.js";
import { collect } from "../../src/option-utils.js";

function program(): Command {
  const root = new Command().name("tool");
  const group = root.command("group").description("A group");
  group
    .command("leaf")
    .description("A leaf")
    .argument("<required>", "A required argument")
    .argument("[optional...]", "Optional variadic", ["a"])
    .requiredOption("--must <value>", "A mandatory option")
    .option("-r, --repeat <value>", "Repeatable", collect)
    .option("--plain", "A boolean")
    .option("--no-plain", "Disable the boolean")
    .option("--maybe [value]", "Optional value", "fallback")
    .action(() => undefined);
  root.command("hidden-one", { hidden: true }).description("Hidden");
  return root;
}

/**
 * A three-level tree: `tool outer inner leaf`.
 *
 * `jira adf to-markdown` is the real one. The walk has never assumed a depth,
 * but nothing pinned that until a toolset actually nested a group inside a
 * group, and three test sites elsewhere did assume it.
 */
function nestedProgram(): Command {
  const root = new Command().name("tool");
  const outer = root.command("outer").description("An outer group");
  const inner = outer.command("inner").description("An inner group");
  inner
    .command("leaf")
    .description("A nested leaf")
    .action(() => undefined);
  return root;
}

const leaf = () => walkCommands(program()).find((command) => command.id === "group leaf")!;
const option = (flags: string) => leaf().options.find((item) => item.flags === flags)!;

describe("walkCommands", () => {
  it("walks nested commands and records their paths", () => {
    const ids = walkCommands(program()).map((command) => command.id);
    expect(ids).toEqual(["group", "group leaf"]);
  });

  it("walks a group nested inside a group", () => {
    const ids = walkCommands(nestedProgram()).map((command) => command.id);
    expect(ids).toEqual(["outer", "outer inner", "outer inner leaf"]);
    const paths = walkCommands(nestedProgram()).map((command) => command.path);
    expect(paths).toEqual([["outer"], ["outer", "inner"], ["outer", "inner", "leaf"]]);
  });

  it("records subcommands at every level of a nested tree", () => {
    const walked = walkCommands(nestedProgram());
    expect(walked.find((command) => command.id === "outer")!.subcommands).toEqual(["outer inner"]);
    expect(walked.find((command) => command.id === "outer inner")!.subcommands).toEqual([
      "outer inner leaf",
    ]);
    expect(walked.find((command) => command.id === "outer inner leaf")!.subcommands).toEqual([]);
  });

  it("excludes hidden commands and the implicit help placeholder", () => {
    const ids = walkCommands(program()).map((command) => command.id);
    expect(ids).not.toContain("hidden-one");
    expect(ids.some((id) => id.endsWith("help"))).toBe(false);
  });

  it("records subcommands on the parent", () => {
    const group = walkCommands(program()).find((command) => command.id === "group")!;
    expect(group.subcommands).toEqual(["group leaf"]);
  });

  it("extracts argument arity and defaults", () => {
    expect(leaf().arguments).toEqual([
      { name: "required", required: true, variadic: false, description: "A required argument" },
      {
        name: "optional",
        required: false,
        variadic: true,
        description: "Optional variadic",
        default: ["a"],
      },
    ]);
  });

  it("detects a repeatable option by its accumulator, not its description", () => {
    expect(option("-r, --repeat <value>")).toMatchObject({
      long: "--repeat",
      short: "-r",
      valueName: "value",
      repeatable: true,
    });
    expect(option("--plain").repeatable).toBe(false);
  });

  it("distinguishes mandatory, optional-value, and negated options", () => {
    expect(option("--must <value>")).toMatchObject({ mandatory: true, valueRequired: true });
    expect(option("--maybe [value]")).toMatchObject({
      valueOptional: true,
      valueName: "value",
      default: "fallback",
    });
    expect(option("--no-plain").negated).toBe(true);
  });

  it("marks a command with no registry entry as undeclared", () => {
    // The synthetic program shares no ids with the real registry.
    expect(leaf().stability).toBe("undeclared");
    expect(leaf().outputSchema).toBeNull();
    expect(leaf().exitCodes).toEqual([]);
  });
});

describe("buildDescription", () => {
  const result = () => buildDescription(program(), { name: "tool", version: "9.9.9" });

  it("includes the tool identity, shorthands, and stream guarantees", () => {
    const described = result();
    expect(described.tool).toEqual({ name: "tool", version: "9.9.9" });
    expect(described.formatShorthands["-fj"]).toBe("--format=json");
    expect(described.machineStreams.optOutEnv).toBe("CAIRN_NO_UPDATE_NOTIFIER");
    expect(described.machineStreams.suppressedWhen.length).toBeGreaterThan(0);
  });

  it("lists the published schemas without their bodies", () => {
    const entry = result().schemas.find((item) => item.id === "md-graph")!;
    expect(entry.uri).toContain("/v1/md-graph.json");
    expect(entry).not.toHaveProperty("schema");
  });
});

describe("selectCommands", () => {
  it("narrows to a command and its descendants", () => {
    const narrowed = selectCommands(buildDescription(program(), { name: "t", version: "1" }), [
      "group",
    ]);
    expect(narrowed.commands.map((command) => command.id)).toEqual(["group", "group leaf"]);
  });

  it("throws on an unknown path", () => {
    const described = buildDescription(program(), { name: "t", version: "1" });
    expect(() => selectCommands(described, ["group", "nope"])).toThrow(
      /Unknown command: group nope/,
    );
  });

  it("does not match a command by prefix alone", () => {
    const described = buildDescription(program(), { name: "t", version: "1" });
    expect(() => selectCommands(described, ["gro"])).toThrow(/Unknown command/);
  });
});
