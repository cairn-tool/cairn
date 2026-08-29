import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedMarkdownFiles, resolveMarkdownInputs } from "../../src/input-selection.js";
import { loadConfig } from "../../src/config.js";
import { initializeRuntime, resetRuntime } from "../../src/runtime.js";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-inputs-"));
  initializeRuntime(loadConfig({ disabled: true }, directory));
});

afterEach(() => {
  resetRuntime();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("input selection", () => {
  it("expands files, directories, and globs without duplicates", () => {
    fs.mkdirSync(path.join(directory, "nested"));
    fs.writeFileSync(path.join(directory, "one.md"), "# One\n");
    fs.writeFileSync(path.join(directory, "nested", "two.md"), "# Two\n");
    const selected = resolveMarkdownInputs([directory, path.join(directory, "**/*.md")]);
    expect(selected).toEqual([
      path.join(directory, "nested", "two.md"),
      path.join(directory, "one.md"),
    ]);
  });

  it("selects modified and untracked files and omits deletions", () => {
    execFileSync("git", ["init", "-q", directory]);
    const kept = path.join(directory, "kept.md");
    const deleted = path.join(directory, "deleted.md");
    fs.writeFileSync(kept, "before\n");
    fs.writeFileSync(deleted, "delete\n");
    execFileSync("git", ["-C", directory, "add", "."]);
    execFileSync("git", [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "initial",
    ]);
    fs.writeFileSync(kept, "after\n");
    fs.rmSync(deleted);
    const untracked = path.join(directory, "new.md");
    fs.writeFileSync(untracked, "new\n");
    expect(changedMarkdownFiles("HEAD", directory)).toEqual([kept, untracked]);
  });
});
