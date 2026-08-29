import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseScriptsBlock } from "../../src/scripts/registry.js";

const CONTEXT = { file: "/repo/.cairn.yml", directory: "/repo" };

function parse(yaml: string) {
  const document = parseYaml(yaml) as { scripts?: unknown };
  return parseScriptsBlock(document?.scripts, CONTEXT);
}

describe("script registry", () => {
  it("returns an empty registry when the block is absent", () => {
    const registry = parseScriptsBlock(undefined, CONTEXT);
    expect(registry.scripts.size).toBe(0);
    expect(registry.file).toBe(CONTEXT.file);
    expect(registry.directory).toBe(CONTEXT.directory);
  });

  it("parses both forms and preserves declaration order", () => {
    const registry = parse(`
scripts:
  build:
    description: Build it
    run: npm run build
  lint:
    exec: ["npm", "run", "lint"]
`);
    expect([...registry.scripts.keys()]).toEqual(["build", "lint"]);
    expect(registry.scripts.get("build")).toEqual({
      name: "build",
      description: "Build it",
      run: "npm run build",
      cwd: { kind: "registry" },
    });
    expect(registry.scripts.get("lint")?.exec).toEqual(["npm", "run", "lint"]);
  });

  it("requires exactly one of run and exec", () => {
    expect(() => parse('scripts:\n  a:\n    run: x\n    exec: ["y"]\n')).toThrow(
      "scripts.a must set exactly one of run or exec",
    );
    expect(() => parse("scripts:\n  a:\n    description: nothing\n")).toThrow(
      "scripts.a must set exactly one of run or exec",
    );
  });

  it("accepts the three cwd forms and rejects an absolute path", () => {
    expect(parse("scripts:\n  a:\n    run: x\n    cwd: registry\n").scripts.get("a")?.cwd).toEqual({
      kind: "registry",
    });
    expect(
      parse("scripts:\n  a:\n    run: x\n    cwd: invocation\n").scripts.get("a")?.cwd,
    ).toEqual({ kind: "invocation" });
    expect(parse("scripts:\n  a:\n    run: x\n    cwd: sub/dir\n").scripts.get("a")?.cwd).toEqual({
      kind: "path",
      value: "sub/dir",
    });
    expect(() => parse("scripts:\n  a:\n    run: x\n    cwd: /etc\n")).toThrow(
      "scripts.a.cwd must be relative to the registry",
    );
  });

  it("rejects unknown keys and a shell on exec", () => {
    expect(() => parse("scripts:\n  a:\n    run: x\n    exce: y\n")).toThrow(
      "Unknown scripts.a key: exce",
    );
    expect(() => parse('scripts:\n  a:\n    exec: ["x"]\n    shell: bash\n')).toThrow(
      "scripts.a.shell applies to run, not exec",
    );
  });

  it("rejects an empty or non-list exec and an empty run", () => {
    expect(() => parse("scripts:\n  a:\n    exec: []\n")).toThrow(
      "scripts.a.exec must be a non-empty list of strings",
    );
    expect(() => parse('scripts:\n  a:\n    exec: ["", "x"]\n')).toThrow(
      "scripts.a.exec[0] must be a non-empty program name",
    );
    expect(() => parse("scripts:\n  a:\n    exec: notalist\n")).toThrow(
      "scripts.a.exec must be a list of strings",
    );
    expect(() => parse('scripts:\n  a:\n    run: "   "\n')).toThrow(
      "scripts.a.run must be a non-empty string",
    );
  });

  it("rejects names that would not read unambiguously on a command line", () => {
    for (const name of ["../escape", "has space", "UPPER", "-leading", "trailing-", "a/b"]) {
      expect(() => parse(`scripts:\n  "${name}":\n    run: x\n`)).toThrow(
        `Invalid script name: ${name}`,
      );
    }
    expect(() => parse(`scripts:\n  ${"a".repeat(65)}:\n    run: x\n`)).toThrow(
      "Invalid script name",
    );
    expect(parse("scripts:\n  build.all:\n    run: x\n").scripts.has("build.all")).toBe(true);
    expect(parse("scripts:\n  ci:test:\n    run: x\n").scripts.has("ci:test")).toBe(true);
  });

  it("rejects a NUL byte in exec", () => {
    expect(() => parseScriptsBlock({ a: { exec: ["node", "\u0000"] } }, CONTEXT)).toThrow(
      "scripts.a.exec must not contain NUL bytes",
    );
  });

  it("rejects a scripts block that is not a mapping", () => {
    expect(() => parse("scripts: [1, 2]\n")).toThrow("scripts must be a mapping");
    expect(() => parse("scripts:\n  a: notamapping\n")).toThrow("scripts.a must be a mapping");
  });
});
