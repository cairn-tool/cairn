import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  candidateLayouts,
  detectLayout,
  distinctivePatterns,
  resolveLayout,
} from "../../src/agent/import/detect.js";
import {
  normalizeTree,
  reverseModel,
  reversePlaceholders,
  reverseTools,
} from "../../src/agent/import/normalize.js";
import { loadBundle } from "../../src/agent/parser.js";
import { renderBundle } from "../../src/agent/render.js";
import { TARGETS } from "../../src/agent/types.js";
import type { AgentProfile, AgentTarget, Artifact, SourceFile } from "../../src/agent/types.js";

const temporary: string[] = [];
const fixtures = path.resolve("tests/fixtures/agent/conformance");

function scratch(prefix = "agent-import-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  return root;
}

/** Renders a fixture and materializes one target/profile tree on disk. */
function nativeTree(
  fixture: string,
  target: AgentTarget,
  profile: AgentProfile,
): { root: string; files: SourceFile[] } {
  const { artifacts } = renderBundle(
    loadBundle(path.join(fixtures, fixture, "bundle")),
    [target],
    [profile],
  );
  const root = scratch("agent-import-native-");
  const prefix = `${target}/${profile}/`;
  const files: SourceFile[] = [];
  for (const artifact of artifacts) {
    const relative = artifact.path.slice(prefix.length);
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, artifact.content, { mode: artifact.mode });
    files.push({ path: relative, content: artifact.content, mode: artifact.mode });
  }
  return { root, files };
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("detection", () => {
  it("identifies every layout the renderer can emit", () => {
    // Built by rendering and feeding the result back, so detection cannot drift
    // from what agent convert actually produces.
    for (const { target, profile } of candidateLayouts()) {
      const { root, files } = nativeTree("full", target, profile);
      const detected = detectLayout(root, files);
      expect([detected.target, detected.profile], `${target}/${profile}`).toEqual([
        target,
        profile,
      ]);
    }
  });

  it("recognizes a plugin layout by its manifest", () => {
    const { root, files } = nativeTree("full", "codex", "plugin");
    expect(detectLayout(root, files).confidence).toBe("manifest");
  });

  it("keeps at least one distinctive pattern per layout", () => {
    // A profile edit that made two layouts indistinguishable would silently
    // degrade detection to a coin flip; this fails instead.
    const distinctive = distinctivePatterns();
    for (const { target, profile } of candidateLayouts()) {
      const owned = [...distinctive.values()].filter((cells) => cells.has(`${target}/${profile}`));
      expect(owned.length, `${target}/${profile} has no distinctive pattern`).toBeGreaterThan(0);
    }
  });

  it("refuses to guess when nothing matches", () => {
    const root = scratch();
    fs.writeFileSync(path.join(root, "README.md"), "# Nothing");
    expect(() =>
      detectLayout(root, [{ path: "README.md", content: Buffer.from("# Nothing"), mode: 0o644 }]),
    ).toThrow(/Could not detect/);
  });

  it("honors an explicit --from and --scope", () => {
    const { root, files } = nativeTree("full", "claude-code", "plugin");
    const forced = resolveLayout(root, files, "cursor", "project");
    expect([forced.target, forced.profile, forced.confidence]).toEqual([
      "cursor",
      "project",
      "explicit",
    ]);
  });

  it("rejects an unknown --from", () => {
    const { root, files } = nativeTree("full", "claude-code", "plugin");
    expect(() => resolveLayout(root, files, "windsurf", undefined)).toThrow(/Unknown --from/);
  });
});

describe("placeholder and vocabulary reversal", () => {
  it("reverses a variable bundle root", () => {
    const result = reversePlaceholders("Path: ${CLAUDE_PLUGIN_ROOT}/x", "claude-code", "plugin");
    expect(result.content).toBe("Path: ${BUNDLE_ROOT}/x");
    expect(result.reversible).toBe(true);
  });

  it("refuses to reverse a bundle root rendered as a bare dot", () => {
    // Cursor renders ${BUNDLE_ROOT} to ".". Rewriting every "." back would
    // corrupt relative paths and every sentence-ending period in the corpus.
    const text = "See ./docs. Then stop.";
    const result = reversePlaceholders(text, "cursor", "plugin");
    expect(result.content).toBe(text);
    expect(result.reversible).toBe(false);
  });

  it("maps native tool names back to portable capabilities", () => {
    expect(reverseTools(["Read", "Glob", "Bash"], "claude-code")).toEqual({
      capabilities: ["read", "shell"],
      unmapped: [],
    });
  });

  it("keeps tool names that have no portable capability", () => {
    expect(reverseTools(["Read", "Telepathy"], "claude-code")).toEqual({
      capabilities: ["read"],
      unmapped: ["Telepathy"],
    });
  });

  it("returns null when the target cannot express tool restriction", () => {
    expect(reverseTools(["anything"], "codex")).toBeNull();
  });

  it("maps a native model id back to its semantic class", () => {
    expect(reverseModel("opus", "claude-code")).toEqual({ model: "capable", ambiguous: false });
  });

  it("resolves an ambiguous model id to inherit and says so", () => {
    // Cursor maps balanced, capable, and inherit all to "inherit".
    expect(reverseModel("inherit", "cursor")).toEqual({ model: "inherit", ambiguous: true });
  });
});

describe("normalizeTree", () => {
  function normalize(target: AgentTarget, profile: AgentProfile, fixture = "full") {
    const { files } = nativeTree(fixture, target, profile);
    return normalizeTree(files, target, profile, "rich", false);
  }

  it("accounts for every input file exactly once", () => {
    for (const { target, profile } of candidateLayouts()) {
      const { files } = nativeTree("full", target, profile);
      const result = normalizeTree(files, target, profile, "rich", false);
      const sources = result.provenance.map((entry) => entry.source);
      expect(new Set(sources).size, `${target}/${profile} duplicated a source`).toBe(
        sources.length,
      );
      for (const file of files) expect(sources).toContain(file.path);
    }
  });

  it("undoes cursor plugin skill namespacing", () => {
    const result = normalize("cursor", "plugin");
    const paths = result.artifacts.map((artifact) => artifact.path);
    expect(paths).toContain("skills/build/SKILL.md");
    expect(paths.some((candidate) => candidate.includes("rich-build"))).toBe(false);
  });

  it("undoes cursor plugin agent namespacing", () => {
    const result = normalize("cursor", "plugin");
    const paths = result.artifacts.map((artifact) => artifact.path);
    expect(paths).toContain("agents/reviewer.agent.md");
    expect(paths.some((candidate) => candidate.includes("rich-reviewer"))).toBe(false);
  });

  it("restores the portable name inside a namespaced component, not just its path", () => {
    // The renderer writes the namespaced identity into `name:` as well as the
    // path, so importing has to undo both -- otherwise the round trip returns a
    // skill called `rich-build` sitting in a directory called `build`.
    const result = normalize("cursor", "plugin");
    const body = (file: string): string => {
      const artifact = result.artifacts.find((entry) => entry.path === file);
      if (!artifact) throw new Error(`no artifact ${file}`);
      return artifact.content.toString("utf8");
    };
    expect(body("skills/build/SKILL.md")).toContain("name: build");
    expect(body("skills/build/SKILL.md")).not.toContain("rich-build");
    expect(body("agents/reviewer.agent.md")).toContain("name: reviewer");
    expect(body("agents/reviewer.agent.md")).not.toContain("rich-reviewer");
  });

  it("preserves an unclaimed file as a native overlay rather than dropping it", () => {
    const { files } = nativeTree("full", "claude-code", "plugin");
    const extended = [
      ...files,
      { path: "vendor/thing.bin", content: Buffer.from("native"), mode: 0o644 },
    ];
    const result = normalizeTree(extended, "claude-code", "plugin", "rich", false);
    const entry = result.provenance.find((item) => item.source === "vendor/thing.bin");
    expect(entry?.layer).toBe("native");
    expect(entry?.destination).toBe("native/claude-code/plugin/vendor/thing.bin");
  });

  it("emits a bundle manifest at schema 2", () => {
    const result = normalize("claude-code", "plugin");
    const manifest = result.artifacts.find((item) => item.path === "agent-bundle.yaml");
    expect(manifest?.content.toString()).toMatch(/schemaVersion: ["']2["']/);
  });

  it("produces byte-identical output for the same input", () => {
    const { files } = nativeTree("full", "claude-code", "plugin");
    const shape = (artifacts: Artifact[]) =>
      artifacts.map((item) => `${item.path}:${item.mode}:${item.content.toString("base64")}`);
    expect(shape(normalizeTree(files, "claude-code", "plugin", "rich", false).artifacts)).toEqual(
      shape(normalizeTree(files, "claude-code", "plugin", "rich", false).artifacts),
    );
  });

  it("writes only overlay files under nativeOnly", () => {
    const { files } = nativeTree("full", "claude-code", "plugin");
    const result = normalizeTree(files, "claude-code", "plugin", "rich", true);
    const portable = result.artifacts.filter(
      (item) => !item.path.startsWith("native/") && item.path !== "agent-bundle.yaml",
    );
    expect(portable).toEqual([]);
  });
});

describe("convert then import then convert is a fixed point", () => {
  // The strongest available fidelity check: whatever survives the portable
  // model must render back to exactly the same native bytes.
  for (const target of TARGETS) {
    it(`round-trips the full fixture through ${target}/plugin`, () => {
      const { files } = nativeTree("full", target, "plugin");
      const result = normalizeTree(files, target, "plugin", "rich", false);

      const bundleRoot = scratch("agent-import-bundle-");
      for (const artifact of result.artifacts) {
        const full = path.join(bundleRoot, artifact.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, artifact.content, { mode: artifact.mode });
      }

      const rerendered = renderBundle(loadBundle(bundleRoot), [target], ["plugin"]);
      const shape = (entries: Array<{ path: string; content: Buffer }>) =>
        entries.map((entry) => `${entry.path} ${entry.content.toString("base64")}`).sort();
      expect(
        shape(
          rerendered.artifacts.map((artifact) => ({
            path: artifact.path.slice(`${target}/plugin/`.length),
            content: artifact.content,
          })),
        ),
      ).toEqual(shape(files));
    });
  }
});
