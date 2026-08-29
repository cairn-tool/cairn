import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findConfig, loadConfig, resolveCommandOptions, selectConfig } from "../../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-config-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const configPath = path.join(tmpDir, ".cairn.yml");
  fs.writeFileSync(configPath, content);
  return configPath;
}

describe("configuration", () => {
  it("discovers .cairn.yml upward", () => {
    const configPath = writeConfig("version: 1\n");
    const nested = path.join(tmpDir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    expect(findConfig(nested)).toBe(configPath);
  });

  it("loads typed defaults and resolves paths from the config directory", () => {
    const configPath = writeConfig(`
version: 1
root: docs
files:
  include: ["**/*.md"]
  exclude: ["drafts/**"]
output:
  format: json
  paths: relative
checks:
  mermaid: false
commands:
  toc:
    minDepth: 2
`);
    const config = loadConfig({ explicitPath: configPath, disabled: false });
    expect(config.root).toBe(path.join(tmpDir, "docs"));
    expect(config.output).toEqual({ format: "json", paths: "relative" });
    expect(config.checks.mermaid).toBe(false);
    expect(config.checks.katex).toBe(true);
    expect(config.commands.toc.minDepth).toBe(2);
  });

  it("rejects unknown keys and unsupported versions", () => {
    expect(() =>
      loadConfig({ explicitPath: writeConfig("version: 2\n"), disabled: false }),
    ).toThrow("version must be 1");
    expect(() =>
      loadConfig({ explicitPath: writeConfig("version: 1\nunknown: true\n"), disabled: false }),
    ).toThrow("Unknown configuration key");
  });

  it("lets explicit CLI values override command and global defaults", () => {
    const config = loadConfig({ disabled: true }, tmpDir);
    config.output.format = "human";
    config.commands.toc = { format: "json", minDepth: 2 };
    expect(
      resolveCommandOptions(config, "toc", { minDepth: 1 }, { format: "llm", minDepth: 3 }),
    ).toMatchObject({ format: "llm", minDepth: 3 });
  });

  it("supports explicit and disabled config selection", () => {
    expect(selectConfig(["md", "lint", "--config", "custom.yml"], tmpDir)).toEqual({
      explicitPath: path.join(tmpDir, "custom.yml"),
      disabled: false,
    });
    expect(selectConfig(["md", "lint", "--no-config"], tmpDir)).toEqual({ disabled: true });
    expect(() => selectConfig(["--config=x.yml", "--no-config"], tmpDir)).toThrow(
      "cannot be used together",
    );
  });

  it("loads URL cache and fallback configuration", () => {
    const configPath = writeConfig(`
version: 1
urls:
  ignore: ["https://ignored.example/**"]
  ignoreDomains: [private.example]
  allowedStatuses: [401]
  cache: false
  cacheTtl: 1200
  headFallbackStatuses: [403, 405]
  reportRedirects: true
commands:
  check-urls:
    allowedStatus: [418]
`);
    const config = loadConfig({ explicitPath: configPath, disabled: false });
    expect(config.urls).toMatchObject({
      ignoreDomains: ["private.example"],
      cache: false,
      cacheTtl: 1200,
      headFallbackStatuses: [403, 405],
      reportRedirects: true,
    });
    expect(config.commands["check-urls"].allowedStatus).toEqual([418]);
  });

  it("loads workspace asset extensions and query defaults", () => {
    const configPath = writeConfig(`
version: 1
assets:
  extensions: [.png, svg]
commands:
  query:
    field: heading-slug
    assetExtension: [.pdf]
`);
    const config = loadConfig({ explicitPath: configPath, disabled: false });
    expect(config.assets.extensions).toEqual([".png", "svg"]);
    expect(config.commands.query).toMatchObject({
      field: "heading-slug",
      assetExtension: [".pdf"],
    });
  });
});
