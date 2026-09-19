import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "@cairn-tool/agent-bundle-schema";
import { loadBundle } from "../../src/agent/parser.js";
import { documentBundle, PROFILES } from "../../src/agent/docs/payload.js";
import { inlineArtifact } from "../../src/agent/docs/inline.js";
import { TARGETS } from "../../src/agent/types.js";
import type { AgentProfile, AgentTarget } from "../../src/agent/types.js";

const fixtureRoot = path.resolve(
  fileURLToPath(new URL("../fixtures/agent/conformance", import.meta.url)),
);

const fixtures = fs
  .readdirSync(fixtureRoot)
  .filter((name) => fs.statSync(path.join(fixtureRoot, name)).isDirectory())
  .sort();

const everything = {
  targets: [...TARGETS] as AgentTarget[],
  profiles: [...PROFILES] as AgentProfile[],
};

function bundleAt(fixture: string): ReturnType<typeof loadBundle> {
  return loadBundle(path.join(fixtureRoot, fixture, "bundle"));
}

describe.each(fixtures)("documenting the %s bundle", (fixture) => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, fixture, "expected.json"), "utf8"),
  ) as { legacy: boolean; layouts: Record<string, string[]> };

  // The render matrix is reached a second way here: the golden records what
  // `agent convert` writes, and this asserts the artifact describes the same
  // tree. A payload that quietly stopped rendering, or rendered somewhere else,
  // would agree with itself and disagree with this.
  it("describes the same layout the conformance golden records", () => {
    const documented = documentBundle(bundleAt(fixture), everything);
    const actual = Object.fromEntries(
      documented.targets.map((render) => [
        `${render.target}/${render.profile}`,
        render.artifacts.map((artifact) => artifact.path).sort(),
      ]),
    );
    const golden = Object.fromEntries(
      Object.entries(expected.layouts)
        .filter(([, paths]) => paths.length > 0)
        .map(([key, paths]) => [key, [...paths].sort()]),
    );
    expect(actual).toEqual(golden);
  });

  it("reports the source manifest's own version and legacy flag", () => {
    const bundle = bundleAt(fixture);
    const documented = documentBundle(bundle, everything);
    expect(documented.legacy).toBe(expected.legacy);
    expect(documented.manifestSchemaVersion).toBe(bundle.schemaVersion);
  });

  it("carries every component's body and its bundle-relative paths", () => {
    const documented = documentBundle(bundleAt(fixture), everything);
    const components = [
      ...(documented.components.skills ?? []),
      ...(documented.components.agents ?? []),
      ...(documented.components.rules ?? []),
    ];
    for (const component of components) {
      // The body is the reason this artifact exists rather than `agent inspect`.
      expect(typeof component.body).toBe("string");
      expect(path.isAbsolute(component.source), `${component.source} is absolute`).toBe(false);
      expect(component.source).not.toContain("\\");
      for (const file of component.files ?? []) {
        expect(path.isAbsolute(file), `${file} is absolute`).toBe(false);
        expect(file.startsWith(path.posix.dirname(component.source))).toBe(true);
      }
    }
  });

  it("produces an artifact that validates against the published schema", () => {
    const artifact = inlineArtifact(bundleAt(fixture), everything);
    const result = validate("inline-agent-bundle", artifact);
    expect(result.errors.map((error) => `${error.instancePath} ${error.message}`)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is byte-stable across runs", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const once = inlineArtifact(bundleAt(fixture), everything, { generatedAt: at });
    const twice = inlineArtifact(bundleAt(fixture), everything, { generatedAt: at });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("profile filtering", () => {
  it("drops hooks from a project-only view and keeps them for a plugin one", () => {
    const bundle = bundleAt("full");
    const project = documentBundle(bundle, { targets: [...TARGETS], profiles: ["project"] });
    const plugin = documentBundle(bundle, { targets: [...TARGETS], profiles: ["plugin"] });
    // Hooks are plugin-profile only on every target, so an inline view showing
    // them would be describing something no host ever receives.
    expect(project.components.hooks).toBeUndefined();
    expect(project.components.hookFiles).toBeUndefined();
    expect(plugin.components.hooks).toBeDefined();
    expect(project.targets.every((render) => render.profile === "project")).toBe(true);
    expect(plugin.targets.every((render) => render.profile === "plugin")).toBe(true);
  });

  it("prunes the graph to the components a target filter kept", () => {
    const bundle = bundleAt("full");
    for (const target of TARGETS) {
      const documented = documentBundle(bundle, { targets: [target], profiles: [...PROFILES] });
      const names = new Set([
        ...(documented.components.skills ?? []).map((component) => component.name),
        ...(documented.components.agents ?? []).map((component) => component.name),
      ]);
      for (const [node, refs] of Object.entries(documented.graph)) {
        expect(names.has(node), `${target}: graph node ${node} is not documented`).toBe(true);
        for (const ref of refs)
          expect(names.has(ref), `${target}: graph edge ${node} -> ${ref} dangles`).toBe(true);
      }
    }
  });
});

describe("artifact identity", () => {
  it("defaults the id to the bundle name and the title to its display name", () => {
    const bundle = bundleAt("v2-minimal");
    const artifact = inlineArtifact(bundle, everything);
    expect(artifact.id).toBe(bundle.name);
    expect(artifact.title).toBe(bundle.marketplace?.displayName ?? bundle.name);
    expect(artifact.kind).toBe("inline-agent-bundle");
  });

  it("lets a caller override both", () => {
    const artifact = inlineArtifact(bundleAt("v2-minimal"), everything, {
      id: "custom-id",
      title: "Custom Title",
    });
    expect(artifact.id).toBe("custom-id");
    expect(artifact.title).toBe("Custom Title");
  });
});
