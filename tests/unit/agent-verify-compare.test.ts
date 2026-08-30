import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  diffTree,
  literalPrefix,
  treeMatches,
  walkRootsFor,
} from "../../src/agent/verify/compare.js";
import type { Artifact } from "../../src/agent/types.js";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-compare-"));
  roots.push(root);
  return fs.realpathSync(root);
}

function artifact(relative: string, content = "body\n", mode = 0o644): Artifact {
  return { path: relative, content: Buffer.from(content), mode };
}

function write(root: string, relative: string, content = "body\n", mode = 0o644): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("literalPrefix", () => {
  it("stops at the first wildcard segment", () => {
    expect(literalPrefix(".claude/skills/{name}/**")).toBe(".claude/skills");
    expect(literalPrefix(".claude/agents/{name}.md")).toBe(".claude/agents");
    expect(literalPrefix("assets/**")).toBe("assets");
  });

  it("returns a wholly literal pattern unchanged, which is how a leaf file is recognized", () => {
    expect(literalPrefix(".mcp.json")).toBe(".mcp.json");
    expect(literalPrefix("AGENTS.md")).toBe("AGENTS.md");
    expect(literalPrefix(".claude/settings.json")).toBe(".claude/settings.json");
  });
});

describe("walkRootsFor", () => {
  const expected = [
    ".claude/skills/one/SKILL.md",
    ".claude/agents/two.md",
    ".claude/rules/three.md",
    ".claude/settings.json",
    ".mcp.json",
  ];

  it("returns only the directory prefixes the render populated", () => {
    expect(walkRootsFor("claude-code", "project", expected)).toEqual([
      ".claude/agents",
      ".claude/rules",
      ".claude/skills",
    ]);
  });

  it("never yields the destination root itself, which is what bounds the walk", () => {
    for (const target of ["claude-code", "codex", "cursor", "antigravity", "opencode"] as const)
      for (const profile of ["plugin", "project"] as const)
        expect(walkRootsFor(target, profile, expected)).not.toContain("");
  });

  it("excludes a wholly literal declared path, which is compared by bytes instead", () => {
    const roots = walkRootsFor("claude-code", "project", expected);
    expect(roots).not.toContain(".mcp.json");
    expect(roots).not.toContain(".claude/settings.json");
  });

  it("excludes a prefix the render did not populate", () => {
    // `assets/**` is declared, but this render places nothing there, so a
    // repository's own assets/ directory stays out of reach.
    expect(walkRootsFor("claude-code", "project", expected)).not.toContain("assets");
    expect(walkRootsFor("claude-code", "project", [...expected, "assets/logo.png"])).toContain(
      "assets",
    );
  });
});

describe("diffTree", () => {
  it("reports a clean tree as matching", () => {
    const root = workspace();
    write(root, ".claude/skills/one/SKILL.md");
    const diff = diffTree(root, [artifact(".claude/skills/one/SKILL.md")], {
      unmanaged: "orphaned",
    });
    expect(treeMatches(diff)).toBe(true);
  });

  it("reports an absent expected artifact as missing", () => {
    const diff = diffTree(workspace(), [artifact(".claude/skills/one/SKILL.md")], {
      unmanaged: "off",
    });
    expect(diff.missing).toEqual([".claude/skills/one/SKILL.md"]);
  });

  it("reports differing bytes as changed", () => {
    const root = workspace();
    write(root, "a.md", "edited\n");
    expect(diffTree(root, [artifact("a.md")], { unmanaged: "off" }).changed).toEqual(["a.md"]);
  });

  it("reports a mode-only change, which a bytes-only comparison would miss", () => {
    const root = workspace();
    write(root, "hook.sh", "body\n", 0o644);
    expect(
      diffTree(root, [artifact("hook.sh", "body\n", 0o755)], { unmanaged: "off" }).changed,
    ).toEqual(["hook.sh"]);
  });

  it("never compares the install manifest by bytes, and never reports it missing", () => {
    const root = workspace();
    write(root, ".cairn-install.json", '{"generator":{"version":"1.0.0"}}');
    const artifacts = [artifact(".cairn-install.json", '{"generator":{"version":"9.9.9"}}')];
    expect(treeMatches(diffTree(root, artifacts, { unmanaged: "off" }))).toBe(true);
    expect(treeMatches(diffTree(workspace(), artifacts, { unmanaged: "off" }))).toBe(true);
  });

  it("reports an inventory entry the render no longer produces as orphaned", () => {
    const root = workspace();
    write(root, "kept.md");
    const diff = diffTree(root, [artifact("kept.md")], {
      unmanaged: "orphaned",
      priorInventory: ["kept.md", "gone.md"],
    });
    expect(diff.orphaned).toEqual(["gone.md"]);
  });

  it("finds nothing orphaned when the mode is off", () => {
    const root = workspace();
    write(root, "kept.md");
    expect(
      diffTree(root, [artifact("kept.md")], {
        unmanaged: "off",
        priorInventory: ["kept.md", "gone.md"],
      }).orphaned,
    ).toEqual([]);
  });

  it("reports a hand-added file inside a walk root as unmanaged", () => {
    const root = workspace();
    write(root, ".claude/skills/one/SKILL.md");
    write(root, ".claude/skills/one/EXTRA.md");
    const diff = diffTree(root, [artifact(".claude/skills/one/SKILL.md")], {
      unmanaged: "strict",
      walkRoots: [".claude/skills"],
    });
    expect(diff.unmanaged).toEqual([".claude/skills/one/EXTRA.md"]);
  });

  it("does not report a file the inventory still accounts for", () => {
    const root = workspace();
    write(root, ".claude/skills/one/SKILL.md");
    write(root, ".claude/skills/one/EXTRA.md");
    const diff = diffTree(root, [artifact(".claude/skills/one/SKILL.md")], {
      unmanaged: "strict",
      walkRoots: [".claude/skills"],
      priorInventory: [".claude/skills/one/SKILL.md", ".claude/skills/one/EXTRA.md"],
    });
    expect(diff.unmanaged).toEqual([]);
    expect(diff.orphaned).toEqual([".claude/skills/one/EXTRA.md"]);
  });

  it("never enumerates the repository, however many unrelated files it holds", () => {
    // The regression this whole containment rule exists to prevent: `diffOutput`
    // walks its roots exhaustively, and pointed at a repository root it would
    // report every source file, dependency, and git object as unmanaged.
    const root = workspace();
    write(root, ".claude/skills/one/SKILL.md");
    write(root, "README.md", "unrelated\n");
    write(root, "src/index.ts", "unrelated\n");
    write(root, ".git/config", "unrelated\n");
    for (let index = 0; index < 500; index += 1)
      write(root, `node_modules/pkg/file-${index}.js`, "unrelated\n");

    const diff = diffTree(root, [artifact(".claude/skills/one/SKILL.md")], {
      unmanaged: "strict",
      walkRoots: walkRootsFor("claude-code", "project", [".claude/skills/one/SKILL.md"]),
    });
    expect(diff.unmanaged).toEqual([]);
    expect(treeMatches(diff)).toBe(true);
  });

  it("reports a symlinked directory itself, but never what is behind it", () => {
    const root = workspace();
    const outside = workspace();
    write(outside, "secret.md", "elsewhere\n");
    write(root, ".claude/skills/one/SKILL.md");
    fs.symlinkSync(outside, path.join(root, ".claude/skills/linked"));
    const diff = diffTree(root, [artifact(".claude/skills/one/SKILL.md")], {
      unmanaged: "strict",
      walkRoots: [".claude/skills"],
    });
    // The link is something the render did not place, so it is a finding. Its
    // target is somebody else's tree, and is never enumerated.
    expect(diff.unmanaged).toEqual([".claude/skills/linked"]);
    expect(diff.unmanaged.some((entry) => entry.includes("secret.md"))).toBe(false);
  });

  it("sorts every list by byte comparison, not by locale", () => {
    const root = workspace();
    const diff = diffTree(root, [artifact("b.md"), artifact("A.md"), artifact("a.md")], {
      unmanaged: "orphaned",
      priorInventory: ["z.md", "B.md"],
    });
    expect(diff.missing).toEqual(["A.md", "a.md", "b.md"]);
    expect(diff.orphaned).toEqual(["B.md", "z.md"]);
  });
});
