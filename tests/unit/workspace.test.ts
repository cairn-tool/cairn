import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { Workspace } from "../../src/workspace.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-workspace-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Workspace", () => {
  it("applies include, exclude, permanent exclusions, and stable sorting", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cairn.yml"),
      'version: 1\nfiles:\n  include: ["**/*.md"]\n  exclude: ["drafts/**"]\n',
    );
    fs.mkdirSync(path.join(tmpDir, "drafts"));
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.mkdirSync(path.join(tmpDir, ".github"));
    fs.writeFileSync(path.join(tmpDir, "b.md"), "# B\n");
    fs.writeFileSync(path.join(tmpDir, "a.md"), "# A\n");
    fs.writeFileSync(path.join(tmpDir, "drafts", "skip.md"), "# Skip\n");
    fs.writeFileSync(path.join(tmpDir, "node_modules", "skip.md"), "# Skip\n");
    fs.writeFileSync(path.join(tmpDir, ".github", "included.md"), "# Included\n");
    const workspace = new Workspace(loadConfig({ disabled: false }, tmpDir));
    expect(workspace.markdownFiles().map((file) => path.basename(file))).toEqual([
      "included.md",
      "a.md",
      "b.md",
    ]);
  });

  it("caches unchanged documents and detects file changes", () => {
    const file = path.join(tmpDir, "doc.md");
    fs.writeFileSync(file, "# First\n");
    const workspace = new Workspace(loadConfig({ disabled: true }, tmpDir));
    const first = workspace.document(file);
    expect(workspace.document(file)).toBe(first);
    fs.writeFileSync(file, "# Second\n");
    expect(workspace.document(file).headings[0].text).toBe("Second");
  });

  it("persists, rebuilds, reports, and clears a workspace index", () => {
    const file = path.join(tmpDir, "doc.md");
    const cachePath = path.join(tmpDir, "cache", "index.json");
    fs.writeFileSync(file, "# First\n");
    const config = loadConfig({ disabled: true }, tmpDir);
    const first = new Workspace(config, { cachePath });
    first.rebuildIndex(tmpDir, [file]);
    expect(first.indexStatus([file])).toMatchObject({ exists: true, current: 1, stale: 0 });

    const second = new Workspace(config, { cachePath });
    expect(second.document(file).headings[0].text).toBe("First");
    fs.writeFileSync(file, "# Changed title\n");
    expect(second.indexStatus([file])).toMatchObject({ current: 0, stale: 1 });
    expect(second.document(file).headings[0].text).toBe("Changed title");
    second.flush();
    second.clearIndex();
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("treats structurally corrupt index records as cache misses", () => {
    const file = path.join(tmpDir, "doc.md");
    const cachePath = path.join(tmpDir, "index.json");
    fs.writeFileSync(file, "# Parsed from disk\n");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        root: tmpDir,
        renderer: "github",
        documents: { "doc.md": { fingerprint: null, document: {} } },
      }),
    );
    const workspace = new Workspace(loadConfig({ disabled: true }, tmpDir), { cachePath });
    expect(workspace.document(file).headings[0].text).toBe("Parsed from disk");
  });

  it("refuses configured scans outside the workspace", () => {
    fs.writeFileSync(path.join(tmpDir, ".cairn.yml"), "version: 1\n");
    const workspace = new Workspace(loadConfig({ disabled: false }, tmpDir));
    expect(() => workspace.markdownFiles(path.dirname(tmpDir))).toThrow("outside configured");
  });
});
