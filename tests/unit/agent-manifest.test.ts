import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeManifest,
  defaultOverlayRoot,
  isSupportedSchema,
} from "../../src/agent/manifest.js";
import { loadBundle } from "../../src/agent/parser.js";
import { renderBundle } from "../../src/agent/render.js";
import type { AgentDiagnostic, AgentProfile } from "../../src/agent/types.js";
import { TARGETS } from "../../src/agent/types.js";

function normalize(raw: Record<string, unknown>, legacy = false) {
  const diagnostics: AgentDiagnostic[] = [];
  const manifest = normalizeManifest(
    raw,
    "/bundle/agent-bundle.yaml",
    legacy,
    "fallback",
    diagnostics,
  );
  return { manifest, diagnostics, codes: diagnostics.map((item) => item.code).sort() };
}

const V1 = { schemaVersion: "1", name: "demo", version: "1.0.0", description: "A demo" };
const V2 = { ...V1, schemaVersion: "2" };

describe("schema versions", () => {
  it("accepts 1, 1.0, and 2", () => {
    for (const schemaVersion of ["1", "1.0", "2"])
      expect(isSupportedSchema(schemaVersion)).toBe(true);
    expect(isSupportedSchema("3")).toBe(false);
    expect(isSupportedSchema("2.0")).toBe(false);
  });

  it("reports the layer for each schema version", () => {
    expect(normalize(V1).manifest.layer).toBe(1);
    expect(normalize({ ...V1, schemaVersion: "1.0" }).manifest.layer).toBe(1);
    expect(normalize(V2).manifest.layer).toBe(2);
    expect(normalize({ name: "legacy" }, true).manifest.layer).toBe(0);
  });

  it("rejects an unsupported schema version with AB112", () => {
    expect(normalize({ ...V1, schemaVersion: "3" }).codes).toContain("AB112");
  });

  it("still reports a missing schemaVersion as 'legacy', as it always has", () => {
    // AB103 in the parser flags the missing field; changing the reported value
    // would change `agent inspect` output for those bundles.
    expect(normalize({ name: "demo" }).manifest.schemaVersion).toBe("legacy");
  });
});

describe("v1 compatibility", () => {
  it("parses no marketplace or native block", () => {
    const { manifest, codes } = normalize(V1);
    expect(manifest.marketplace).toBeUndefined();
    expect(manifest.native).toEqual([]);
    expect(codes).toEqual([]);
  });

  it("refuses v2-only blocks rather than silently ignoring them", () => {
    expect(normalize({ ...V1, marketplace: { displayName: "X" } }).codes).toContain("AB127");
    expect(normalize({ ...V1, native: { codex: "native/codex" } }).codes).toContain("AB127");
  });
});

describe("marketplace metadata", () => {
  it("parses a full block", () => {
    const { manifest, codes } = normalize({
      ...V2,
      marketplace: {
        displayName: "Demo",
        summary: "A demo bundle",
        categories: ["ci", "release"],
        keywords: ["demo"],
        publisher: { name: "Someone", url: "https://example.invalid" },
        license: "MIT",
        icon: "assets/icon.png",
        screenshots: ["assets/one.png"],
        starterPrompts: [{ title: "Go", prompt: "Do the thing." }],
        legal: { privacyPolicy: "https://example.invalid/privacy" },
      },
    });
    expect(codes).toEqual([]);
    expect(manifest.marketplace?.displayName).toBe("Demo");
    expect(manifest.marketplace?.categories).toEqual(["ci", "release"]);
    expect(manifest.marketplace?.publisher).toEqual({
      name: "Someone",
      url: "https://example.invalid",
    });
    expect(manifest.marketplace?.starterPrompts).toEqual([
      { title: "Go", prompt: "Do the thing." },
    ]);
    expect(manifest.marketplace?.legal?.privacyPolicy).toBe("https://example.invalid/privacy");
  });

  it("accepts a partially filled block, because publish-readiness is agent package's question", () => {
    const { manifest, codes } = normalize({ ...V2, marketplace: { displayName: "Demo" } });
    expect(codes).toEqual([]);
    expect(manifest.marketplace?.categories).toEqual([]);
    expect(manifest.marketplace?.starterPrompts).toEqual([]);
  });

  it("rejects a non-object marketplace with AB119", () => {
    expect(normalize({ ...V2, marketplace: "nope" }).codes).toEqual(["AB119"]);
    expect(normalize({ ...V2, marketplace: ["nope"] }).codes).toEqual(["AB119"]);
  });

  it("rejects malformed marketplace fields with AB122", () => {
    expect(normalize({ ...V2, marketplace: { categories: "ci" } }).codes).toEqual(["AB122"]);
    expect(normalize({ ...V2, marketplace: { displayName: 7 } }).codes).toEqual(["AB122"]);
    expect(normalize({ ...V2, marketplace: { publisher: { url: "x" } } }).codes).toEqual(["AB122"]);
    expect(normalize({ ...V2, marketplace: { starterPrompts: [{ title: "x" }] } }).codes).toEqual([
      "AB122",
    ]);
  });
});

describe("native overlay declarations", () => {
  it("defaults every target to native/<target>", () => {
    const { manifest, codes } = normalize(V2);
    expect(codes).toEqual([]);
    expect(manifest.native).toEqual([
      { target: "claude-code", root: "native/claude-code" },
      { target: "codex", root: "native/codex" },
      { target: "cursor", root: "native/cursor" },
      { target: "antigravity", root: "native/antigravity" },
    ]);
    expect(defaultOverlayRoot("codex")).toBe("native/codex");
  });

  it("accepts both the string shorthand and the object form", () => {
    const shorthand = normalize({ ...V2, native: { codex: "vendor/codex" } });
    const object = normalize({ ...V2, native: { codex: { root: "vendor/codex" } } });
    for (const result of [shorthand, object]) {
      expect(result.codes).toEqual([]);
      expect(result.manifest.native.find((item) => item.target === "codex")?.root).toBe(
        "vendor/codex",
      );
    }
  });

  it("leaves undeclared targets at their default root", () => {
    const { manifest } = normalize({ ...V2, native: { codex: "vendor/codex" } });
    expect(manifest.native.find((item) => item.target === "cursor")?.root).toBe("native/cursor");
  });

  it("rejects a non-object native block with AB180", () => {
    expect(normalize({ ...V2, native: "native" }).codes).toEqual(["AB180"]);
  });

  it("rejects an unknown target with AB184", () => {
    expect(normalize({ ...V2, native: { windsurf: "native/windsurf" } }).codes).toEqual(["AB184"]);
  });

  it("rejects an invalid root with AB185", () => {
    expect(normalize({ ...V2, native: { codex: { root: "" } } }).codes).toEqual(["AB185"]);
    expect(normalize({ ...V2, native: { codex: 7 } }).codes).toEqual(["AB185"]);
  });
});

describe("a v2 bundle renders byte-identically to its v1 equivalent", () => {
  const fixtures = path.resolve(
    fileURLToPath(new URL("../fixtures/agent/conformance", import.meta.url)),
  );
  const PROFILES: AgentProfile[] = ["plugin", "project"];

  it("emits the same paths, bytes, and modes for minimal and v2-minimal", () => {
    // The two fixtures differ only in schemaVersion and the v2-only blocks. If
    // introducing schema 2 could change any existing bundle's output, this fails.
    const render = (name: string) =>
      renderBundle(loadBundle(path.join(fixtures, name, "bundle")), [...TARGETS], PROFILES)
        .artifacts.map((artifact) => ({
          path: artifact.path,
          mode: artifact.mode,
          content: artifact.content.toString("utf8"),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(render("v2-minimal")).toEqual(render("minimal"));
  });

  it("carries marketplace metadata that renders nothing", () => {
    const bundle = loadBundle(path.join(fixtures, "v2-minimal", "bundle"));
    expect(bundle.marketplace?.displayName).toBe("Minimal");
    expect(bundle.schemaVersion).toBe("2");
    expect(renderBundle(bundle, [...TARGETS], PROFILES).diagnostics).toEqual([]);
  });
});

describe("deprecated top-level component paths", () => {
  it("still honors them under v2 but emits a non-blocking AB126 notice", () => {
    const { diagnostics } = normalize({ ...V2, skills: "lib/skills" });
    const notice = diagnostics.find((item) => item.code === "AB126");
    expect(notice?.severity).toBe("notice");
    // Quality must stay `exact`: `hasFindings` blocks on approximate, which would
    // turn a deprecation into a failed conversion.
    expect(notice?.quality).toBe("exact");
  });

  it("does not flag them under v1", () => {
    expect(normalize({ ...V1, skills: "lib/skills" }).codes).toEqual([]);
  });
});
