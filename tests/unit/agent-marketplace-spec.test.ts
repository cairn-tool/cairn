import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  loadSpec,
  selectedForTarget,
  CURRENT_SPEC_SCHEMA,
  SPEC_FILENAME,
} from "../../src/agent/marketplace/spec.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mkt-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a minimal bundle directory; the spec parser only checks it is a directory. */
function bundle(name: string): string {
  const dir = path.join(root, "plugins", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent-bundle.yaml"),
    stringifyYaml({ schemaVersion: "2", name, version: "1.0.0", description: `${name} bundle` }),
  );
  return `plugins/${name}`;
}

function write(spec: unknown, file = SPEC_FILENAME): string {
  const target = path.join(root, file);
  fs.writeFileSync(target, stringifyYaml(spec));
  return target;
}

const VALID = {
  schemaVersion: CURRENT_SPEC_SCHEMA,
  name: "cairn",
  version: "1.0.0",
  description: "Cairn's own toolsets, as plugins.",
  owner: { name: "Bryan Stockus", url: "https://github.com/bstockus" },
  targets: ["claude-code"],
};

function load(spec: unknown) {
  const result = loadSpec(write(spec));
  return { ...result, codes: [...new Set(result.diagnostics.map((d) => d.code))].sort() };
}

describe("a valid spec", () => {
  it("parses with no diagnostics", () => {
    const paths = [bundle("cairn-markdown"), bundle("cairn-agent")];
    const { spec, diagnostics } = load({ ...VALID, bundles: paths.map((p) => ({ path: p })) });
    expect(diagnostics).toEqual([]);
    expect(spec.name).toBe("cairn");
    expect(spec.version).toBe("1.0.0");
    expect(spec.owner).toEqual({ name: "Bryan Stockus", url: "https://github.com/bstockus" });
    expect(spec.targets).toEqual(["claude-code"]);
    expect(spec.bundles.map((b) => b.path)).toEqual(paths);
  });

  it("resolves a directory argument to the conventional filename", () => {
    write({ ...VALID, bundles: [{ path: bundle("a") }] });
    expect(loadSpec(root).spec.name).toBe("cairn");
  });

  it("expands `all` to every known target and deduplicates", () => {
    const { spec } = load({
      ...VALID,
      targets: ["all", "claude-code"],
      bundles: [{ path: bundle("a") }],
    });
    expect(spec.targets).toContain("claude-code");
    expect(spec.targets).toContain("codex");
    expect(new Set(spec.targets).size).toBe(spec.targets.length);
  });

  it("throws rather than reporting when the file is absent", () => {
    expect(() => loadSpec(path.join(root, "missing.yaml"))).toThrow(/not found/);
  });
});

describe("AB900 — schema version", () => {
  it("rejects an unsupported version", () => {
    const { codes } = load({ ...VALID, schemaVersion: "2", bundles: [{ path: bundle("a") }] });
    expect(codes).toContain("AB900");
  });

  it("rejects a missing version", () => {
    const spec = { ...VALID, bundles: [{ path: bundle("a") }] } as Record<string, unknown>;
    delete spec.schemaVersion;
    expect(load(spec).codes).toContain("AB900");
  });
});

describe("AB901 — required fields", () => {
  it.each(["name", "version", "owner", "targets", "bundles"])("reports a missing %s", (field) => {
    const spec = { ...VALID, bundles: [{ path: bundle("a") }] } as Record<string, unknown>;
    delete spec[field];
    expect(load(spec).codes).toContain("AB901");
  });

  it("reports an empty bundles list", () => {
    expect(load({ ...VALID, bundles: [] }).codes).toContain("AB901");
  });

  it("reports an empty targets list", () => {
    expect(load({ ...VALID, targets: [], bundles: [{ path: bundle("a") }] }).codes).toContain(
      "AB901",
    );
  });

  it("reports a missing owner.name", () => {
    expect(
      load({ ...VALID, owner: { url: "https://x" }, bundles: [{ path: bundle("a") }] }).codes,
    ).toContain("AB901");
  });
});

describe("AB902 — malformed fields", () => {
  it("rejects a non-kebab-case name", () => {
    expect(
      load({ ...VALID, name: "Cairn Plugins", bundles: [{ path: bundle("a") }] }).codes,
    ).toContain("AB902");
  });

  it("rejects a non-semver version", () => {
    expect(load({ ...VALID, version: "v1", bundles: [{ path: bundle("a") }] }).codes).toContain(
      "AB902",
    );
  });

  it("rejects an unknown target", () => {
    expect(
      load({ ...VALID, targets: ["claude-code", "emacs"], bundles: [{ path: bundle("a") }] }).codes,
    ).toContain("AB902");
  });

  it("rejects an unknown root key", () => {
    expect(load({ ...VALID, plugins: [], bundles: [{ path: bundle("a") }] }).codes).toContain(
      "AB902",
    );
  });

  it("rejects an unknown bundle key", () => {
    expect(load({ ...VALID, bundles: [{ path: bundle("a"), profile: "plugin" }] }).codes).toContain(
      "AB902",
    );
  });

  it("rejects a non-mapping owner", () => {
    expect(load({ ...VALID, owner: "Bryan", bundles: [{ path: bundle("a") }] }).codes).toContain(
      "AB902",
    );
  });
});

describe("AB903 — include and exclude together", () => {
  it("refuses a bundle declaring both", () => {
    const { codes, spec } = load({
      ...VALID,
      targets: ["claude-code", "cursor"],
      bundles: [{ path: bundle("a"), include: ["claude-code"], exclude: ["cursor"] }],
    });
    expect(codes).toContain("AB903");
    expect(spec.bundles).toEqual([]);
  });
});

describe("AB904 — bundle paths", () => {
  it("reports a path that does not exist", () => {
    expect(load({ ...VALID, bundles: [{ path: "plugins/absent" }] }).codes).toContain("AB904");
  });

  it("reports a path that is not a directory", () => {
    fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "file.txt"), "x");
    expect(load({ ...VALID, bundles: [{ path: "plugins/file.txt" }] }).codes).toContain("AB904");
  });

  it("reports a path that escapes the spec directory", () => {
    expect(load({ ...VALID, bundles: [{ path: ".." }] }).codes).toContain("AB904");
  });

  // A symlink that resolves outside is refused rather than followed, matching the
  // containment rule component paths inside a bundle already follow.
  it("reports a symlink whose target escapes", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-out-"));
    fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "plugins", "linked"));
    try {
      expect(load({ ...VALID, bundles: [{ path: "plugins/linked" }] }).codes).toContain("AB904");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("AB905 — duplicate bundles", () => {
  it("reports two entries resolving to the same directory", () => {
    const only = bundle("a");
    expect(load({ ...VALID, bundles: [{ path: only }, { path: `./${only}` }] }).codes).toContain(
      "AB905",
    );
  });
});

describe("selectedForTarget", () => {
  const base = { path: "p", root: "/p" };

  it("selects every target when neither list is given", () => {
    expect(selectedForTarget(base, "claude-code")).toBe(true);
    expect(selectedForTarget(base, "codex")).toBe(true);
  });

  it("honors include as an allowlist", () => {
    const b = { ...base, include: ["claude-code"] as const };
    expect(selectedForTarget({ ...b, include: ["claude-code"] }, "claude-code")).toBe(true);
    expect(selectedForTarget({ ...b, include: ["claude-code"] }, "codex")).toBe(false);
  });

  it("honors exclude as a denylist", () => {
    const b = { ...base, exclude: ["codex" as const] };
    expect(selectedForTarget(b, "claude-code")).toBe(true);
    expect(selectedForTarget(b, "codex")).toBe(false);
  });
});
