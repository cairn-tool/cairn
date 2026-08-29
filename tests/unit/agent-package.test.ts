import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TarPathTooLongError,
  archive,
  normalizeMode,
  tarball,
} from "../../src/agent/package/tar.js";
import {
  buildCatalogs,
  buildChecksums,
  buildSbom,
  checkCaseCollisions,
  checkExecutables,
  checkPinning,
  imageKind,
} from "../../src/agent/package/index.js";
import { loadBundle } from "../../src/agent/parser.js";
import { TARGETS } from "../../src/agent/types.js";
import type { AgentProfile, Artifact } from "../../src/agent/types.js";
import { profileFor } from "../../src/agent/targets/index.js";

const temporary: string[] = [];
const PROFILES: AgentProfile[] = ["plugin", "project"];

function artifact(filePath: string, content = "x", mode = 0o644): Artifact {
  return { path: filePath, content: Buffer.from(content), mode };
}

function bundle(marketplace = ""): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-package-"));
  temporary.push(root);
  fs.writeFileSync(
    path.join(root, "agent-bundle.yaml"),
    `schemaVersion: '2'\nname: demo\nversion: 1.2.3\ndescription: A demo\n${marketplace}`,
  );
  fs.mkdirSync(path.join(root, "skills", "hello"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: Say hello\n---\n\nSay hello.\n",
  );
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("deterministic tar", () => {
  const entries = [
    artifact("b/nested/file.md", "hello\n"),
    artifact("a.txt", "world\n"),
    artifact("run.sh", "#!/bin/sh\n", 0o755),
  ];

  it("produces identical bytes across runs", () => {
    expect(archive(entries).equals(archive(entries))).toBe(true);
  });

  it("does not depend on input order", () => {
    expect(archive(entries).equals(archive([...entries].reverse()))).toBe(true);
  });

  it("sorts by byte order rather than locale order", () => {
    // "a-b" sorts before "aB" by byte value; localeCompare disagrees, and an
    // ICU difference between machines would otherwise reorder the archive.
    const raw = tarball([artifact("aB.md"), artifact("a-b.md")]);
    expect(raw.indexOf(Buffer.from("a-b.md"))).toBeLessThan(raw.indexOf(Buffer.from("aB.md")));
  });

  it("zeroes every field that would otherwise embed the build machine", () => {
    const raw = tarball([artifact("a.txt")]);
    const header = raw.subarray(0, 512);
    expect(header.subarray(108, 116).toString()).toMatch(/^0{7}\0$/); // uid
    expect(header.subarray(116, 124).toString()).toMatch(/^0{7}\0$/); // gid
    expect(header.subarray(136, 148).toString()).toMatch(/^0{11}\0$/); // mtime
    expect(header.subarray(265, 297).toString().replace(/\0+$/, "")).toBe(""); // uname
    expect(header.subarray(297, 329).toString().replace(/\0+$/, "")).toBe(""); // gname
  });

  it("normalizes modes so a stray 0o777 cannot ship", () => {
    expect(normalizeMode(0o777, false)).toBe(0o755);
    expect(normalizeMode(0o600, false)).toBe(0o644);
    expect(normalizeMode(0o644, true)).toBe(0o755);
  });

  it("writes a valid header checksum", () => {
    const header = tarball([artifact("a.txt")]).subarray(0, 512);
    const declared = parseInt(header.subarray(148, 154).toString(), 8);
    const recomputed = [...header].reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
    expect(declared).toBe(recomputed);
  });

  it("pads to the standard blocking factor", () => {
    expect(tarball([artifact("a.txt")]).length % (512 * 20)).toBe(0);
  });

  it("refuses a path ustar cannot express rather than emitting a PAX header", () => {
    const long = `${"segment/".repeat(30)}${"n".repeat(120)}.md`;
    expect(() => tarball([artifact(long)])).toThrow(TarPathTooLongError);
  });

  it("gzips with a zero mtime and a fixed OS byte", () => {
    const compressed = archive(entries);
    expect(compressed.readUInt32LE(4)).toBe(0);
    expect(compressed[9]).toBe(0x03);
  });
});

describe("catalogs", () => {
  const FULL = [
    "marketplace:",
    "  displayName: Demo",
    "  categories: [example]",
    "  publisher:",
    "    name: Example",
    "  license: MIT",
    "  icon: assets/icon.png",
    "",
  ].join("\n");

  it("resolves entry fields from the target profile", () => {
    const result = buildCatalogs(loadBundle(bundle(FULL)), ["claude-code"], PROFILES, "repo");
    expect(result.diagnostics).toEqual([]);
    const spec = profileFor("claude-code").marketplace!;
    const entry = JSON.parse(result.artifacts[0].content.toString())[spec.entriesKey][0];
    expect(entry).toMatchObject({
      name: "demo",
      version: "1.2.3",
      description: "A demo",
      // An object, and one category rather than the bundle's list: Claude Code
      // rejects the bare-string author and the array that shipped in 1.10.0.
      author: { name: "Example" },
      category: "example",
      license: "MIT",
    });
  });

  it("names the marketplace itself at the document's top level", () => {
    const result = buildCatalogs(loadBundle(bundle(FULL)), ["claude-code"], PROFILES, "repo");
    expect(result.diagnostics).toEqual([]);
    const document = JSON.parse(result.artifacts[0].content.toString());
    // `name` has to match the settings key `agent install --register` writes,
    // which is the bundle name; Claude Code enforces the two agreeing.
    expect(document.name).toBe("demo");
    expect(document.description).toBe("A demo");
    expect(document.owner).toEqual({ name: "Example" });
  });

  it("requires a publisher for the claude-code catalog owner", () => {
    const result = buildCatalogs(loadBundle(bundle()), ["claude-code"], PROFILES, "repo");
    const owner = result.diagnostics.find((item) => item.message.includes("'owner'"));
    expect(owner?.code).toBe("AB500");
    expect(owner?.severity).toBe("error");
    // The remediation names the bundle key, not the catalog key.
    expect(owner?.remediation).toBe("Set marketplace.publisher in agent-bundle.yaml.");
  });

  it("keeps the cursor and codex publisher a bare name", () => {
    const result = buildCatalogs(loadBundle(bundle(FULL)), ["cursor", "codex"], PROFILES, "repo");
    for (const target of ["cursor", "codex"] as const) {
      const spec = profileFor(target).marketplace!;
      const artifact = result.artifacts.find((item) => item.path.startsWith(`${target}/`))!;
      const entry = JSON.parse(artifact.content.toString())[spec.entriesKey][0];
      expect(entry[target === "cursor" ? "author" : "publisher"]).toBe("Example");
      // Plural, so the whole list survives — unlike claude-code's `category`.
      expect(entry.categories).toEqual(["example"]);
    }
  });

  it("reports a missing required field with AB500", () => {
    // codex requires publisher, categories, icon, and license.
    const result = buildCatalogs(loadBundle(bundle()), ["codex"], PROFILES, "repo");
    const codes = [...new Set(result.diagnostics.map((item) => item.code))];
    expect(codes).toEqual(["AB500"]);
    expect(result.diagnostics.every((item) => item.severity === "error")).toBe(true);
  });

  it("emits one catalog per target, in the profile's declared location", () => {
    const result = buildCatalogs(loadBundle(bundle(FULL)), [...TARGETS], PROFILES, "repo");
    for (const target of TARGETS) {
      const spec = profileFor(target).marketplace!;
      expect(result.entries.map((entry) => entry.path)).toContain(
        `${target}/plugin/${spec.catalog.repo!.directory}/${spec.catalog.repo!.file}`,
      );
    }
  });

  it("emits nothing under --marketplace none", () => {
    const result = buildCatalogs(loadBundle(bundle(FULL)), [...TARGETS], PROFILES, "none");
    expect(result.artifacts).toEqual([]);
  });
});

describe("integrity", () => {
  it("writes a sha256sum-compatible file sorted by path", () => {
    const payload = [artifact("b.txt", "two"), artifact("a.txt", "one")];
    const lines = buildChecksums(payload).content.toString().trim().split("\n");
    expect(lines[0]).toBe(`${crypto.createHash("sha256").update("one").digest("hex")}  a.txt`);
    expect(lines[1].endsWith("  b.txt")).toBe(true);
  });

  it("classifies inventory components by content, not extension alone", () => {
    const payload = [
      artifact("hooks/run.sh", "#!/bin/sh\n", 0o755),
      { path: "blob.bin", content: Buffer.from([0, 1, 2]), mode: 0o644 },
      artifact("a.json", "{}"),
      artifact("a.md", "# Hi"),
    ];
    const sbom = JSON.parse(buildSbom(loadBundle(bundle()), payload).content.toString());
    expect(sbom.bomFormat).toBe("cairn-inventory");
    expect(
      Object.fromEntries(
        sbom.components.map((c: { path: string; type: string }) => [c.path, c.type]),
      ),
    ).toEqual({
      "hooks/run.sh": "script",
      "blob.bin": "binary",
      "a.json": "config",
      "a.md": "document",
    });
  });

  it("identifies image types from headers", () => {
    expect(imageKind(Buffer.from("89504e470d0a1a0a0000", "hex"))).toBe("png");
    expect(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(imageKind(Buffer.from('<svg xmlns="..."/>'))).toBe("svg");
    expect(imageKind(Buffer.from("not an image"))).toBeNull();
  });
});

describe("publish-readiness checks", () => {
  it("flags an executable outside hooks, scripts, or bin", () => {
    const findings = checkExecutables([
      artifact("hooks/ok.sh", "x", 0o755),
      artifact("scripts/ok.sh", "x", 0o755),
      artifact("docs/odd.md", "x", 0o755),
    ]);
    expect(findings.map((item) => [item.code, item.path])).toEqual([["AB504", "docs/odd.md"]]);
  });

  it("flags paths that collide on a case-insensitive filesystem", () => {
    const findings = checkCaseCollisions([artifact("README.md"), artifact("readme.md")]);
    expect(findings.map((item) => item.code)).toEqual(["AB505"]);
    expect(findings[0].severity).toBe("error");
  });

  it("notes an unpinned MCP package but accepts a pinned one", () => {
    const withServers = (spec: string) => {
      const root = bundle();
      fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "mcp", "mcp.json"),
        JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", spec] } } }),
      );
      return loadBundle(root);
    };
    expect(checkPinning(withServers("@scope/pkg")).map((item) => item.code)).toEqual(["AB506"]);
    expect(checkPinning(withServers("@scope/pkg@1.2.3"))).toEqual([]);
  });
});
