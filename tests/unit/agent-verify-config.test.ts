import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseVerifyBlock } from "../../src/agent/verify/config.js";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-config-"));
  roots.push(root);
  return fs.realpathSync(root);
}

function parse(block: unknown, directory = workspace()) {
  return parseVerifyBlock(block, { file: path.join(directory, ".cairn.yml"), directory });
}

const entry = {
  bundle: "bundle",
  target: "claude-code",
  profile: "project",
  destination: ".",
};

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("parseVerifyBlock", () => {
  it("returns an empty configuration when the key is absent", () => {
    expect(parse(undefined).entries).toEqual([]);
    expect(parse({}).entries).toEqual([]);
  });

  it("resolves paths against the document's directory", () => {
    const directory = workspace();
    const config = parse({ verify: { entries: [entry] } }, directory);
    expect(config.entries[0].bundle).toBe(path.join(directory, "bundle"));
    expect(config.entries[0].destination).toBe(directory);
  });

  it("names an entry after its bundle, target, and profile by default", () => {
    expect(parse({ verify: { entries: [entry] } }).entries[0].name).toBe(
      "bundle/claude-code/project",
    );
  });

  it("applies defaults, and lets an entry override them", () => {
    const config = parse({
      verify: {
        defaults: { unmanaged: "strict", scope: "user", profile: "plugin", layout: "plugin-dir" },
        entries: [
          { bundle: "a", target: "codex" },
          { ...entry, unmanaged: "off" },
        ],
      },
    });
    expect(config.entries[0].unmanaged).toBe("strict");
    expect(config.entries[0].scope).toBe("user");
    expect(config.entries[0].profile).toBe("plugin");
    expect(config.entries[0].layout).toBe("plugin-dir");
    expect(config.entries[1].unmanaged).toBe("off");
    expect(config.entries[1].profile).toBe("project");
  });

  it("defaults to the project scope and orphan detection", () => {
    const config = parse({ verify: { entries: [entry] } });
    expect(config.entries[0].scope).toBe("project");
    expect(config.entries[0].unmanaged).toBe("orphaned");
    expect(config.entries[0].layout).toBe("merge");
  });

  it("reads every pin, and reports an omitted one as absent", () => {
    const config = parse({
      verify: {
        pins: {
          cli: { min: "2.0.0", max: "3.0.0" },
          profileSchemaVersion: "2",
          targets: { codex: { exact: "2026-08-02" } },
        },
        entries: [entry],
      },
    });
    expect(config.pins.cli).toEqual({ min: "2.0.0", max: "3.0.0" });
    expect(config.pins.profileSchemaVersion).toBe("2");
    expect(config.pins.targets.codex).toEqual({ exact: "2026-08-02" });
    expect(parse({ verify: { entries: [entry] } }).pins.cli).toBeUndefined();
  });

  it("rejects an unknown key at every level", () => {
    expect(() => parse({ nope: 1 })).toThrow(/Unknown agent key/);
    expect(() => parse({ verify: { nope: 1, entries: [entry] } })).toThrow(
      /Unknown agent.verify key/,
    );
    expect(() => parse({ verify: { pins: { nope: 1 }, entries: [entry] } })).toThrow(
      /Unknown agent.verify.pins key/,
    );
    expect(() => parse({ verify: { entries: [{ ...entry, nope: 1 }] } })).toThrow(
      /Unknown agent.verify.entries\[0\] key/,
    );
    expect(() => parse({ verify: { defaults: { nope: 1 }, entries: [entry] } })).toThrow(
      /Unknown agent.verify.defaults key/,
    );
  });

  it("refuses a bound combining exact with a range", () => {
    expect(() =>
      parse({ verify: { pins: { cli: { exact: "2.0.0", min: "1.0.0" } }, entries: [entry] } }),
    ).toThrow(/cannot be combined/);
  });

  it("refuses an empty bound", () => {
    expect(() => parse({ verify: { pins: { cli: {} }, entries: [entry] } })).toThrow(
      /must declare exact, min, or max/,
    );
  });

  it("refuses a CLI pin that is not a version, and a revision that is not a date", () => {
    expect(() => parse({ verify: { pins: { cli: { min: "latest" } }, entries: [entry] } })).toThrow(
      /must be a version/,
    );
    expect(() =>
      parse({ verify: { pins: { targets: { codex: { min: "2026" } } }, entries: [entry] } }),
    ).toThrow(/must be an ISO date/);
  });

  it("refuses a bundle or destination that escapes the configuration directory", () => {
    expect(() => parse({ verify: { entries: [{ ...entry, bundle: "../outside" }] } })).toThrow(
      /escapes the configuration directory/,
    );
    expect(() => parse({ verify: { entries: [{ ...entry, destination: "../outside" }] } })).toThrow(
      /escapes the configuration directory/,
    );
  });

  it("refuses an unknown target, profile, layout, or unmanaged mode", () => {
    expect(() => parse({ verify: { entries: [{ ...entry, target: "gemini" }] } })).toThrow(
      /Unknown target/,
    );
    expect(() => parse({ verify: { entries: [{ ...entry, profile: "both" }] } })).toThrow(
      /Unknown profile/,
    );
    expect(() => parse({ verify: { entries: [{ ...entry, layout: "merged" }] } })).toThrow(
      /must be one of/,
    );
    expect(() => parse({ verify: { entries: [{ ...entry, unmanaged: "all" }] } })).toThrow(
      /must be one of/,
    );
    expect(() =>
      parse({ verify: { pins: { targets: { gemini: { min: "2026-01-01" } } }, entries: [entry] } }),
    ).toThrow(/Unknown target/);
  });

  it("requires at least one entry, so an empty block cannot read as a pass", () => {
    expect(() => parse({ verify: { entries: [] } })).toThrow(/at least one entry/);
    expect(() => parse({ verify: {} })).toThrow(/at least one entry/);
  });

  it("refuses two entries sharing a name", () => {
    expect(() =>
      parse({
        verify: {
          entries: [
            { ...entry, name: "one" },
            { ...entry, name: "one" },
          ],
        },
      }),
    ).toThrow(/Duplicate agent.verify entry name/);
  });

  it("requires the fields that have no sensible default", () => {
    expect(() => parse({ verify: { entries: [{ target: "codex" }] } })).toThrow(
      /bundle is required/,
    );
    expect(() => parse({ verify: { entries: [{ bundle: "a" }] } })).toThrow(/target is required/);
    expect(() => parse({ verify: { entries: [{ bundle: "a", target: "codex" }] } })).toThrow(
      /profile is required/,
    );
  });
});
