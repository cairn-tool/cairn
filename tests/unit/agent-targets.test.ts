import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEATURE_KEYS,
  HOOK_EVENT_ALIASES,
  PROFILE_SCHEMA_VERSION,
  TARGET_PROFILES,
  compareSemver,
  compatibilityMatrix,
  describesPath,
  outputPatternToRegExp,
  parseSemver,
  profileFor,
  specsPayload,
  validateProfile,
} from "../../src/agent/targets/index.js";
import { TARGETS } from "../../src/agent/types.js";

const sourceRoot = path.resolve(fileURLToPath(new URL("../../src", import.meta.url)));

/**
 * Frozen copy of the LEGACY_EVENTS table that lived in render.ts before the
 * profiles existed. HOOK_EVENT_ALIASES is now derived, so this pins the
 * derivation against the behavior it replaced.
 */
const LEGACY_EVENTS: Record<string, string> = {
  SessionStart: "session-start",
  sessionStart: "session-start",
  PreToolUse: "pre-tool-use",
  preToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  postToolUse: "post-tool-use",
  Stop: "stop",
  stop: "stop",
};

describe("target profiles", () => {
  it("declares every target with a valid profile", () => {
    for (const target of TARGETS) {
      const profile = profileFor(target);
      expect(profile.id).toBe(target);
      expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
      expect(validateProfile(profile)).toEqual([]);
    }
  });

  it("derives the legacy hook event aliases", () => {
    for (const [native, portable] of Object.entries(LEGACY_EVENTS))
      expect(HOOK_EVENT_ALIASES[native]).toBe(portable);
  });

  it("only claims diagnostic codes the renderer or parser actually emits", () => {
    const sources = ["agent/render.ts", "agent/parser.ts", "agent/overlays.ts"]
      .map((file) => fs.readFileSync(path.join(sourceRoot, file), "utf8"))
      .join("\n");
    for (const target of TARGETS)
      for (const key of FEATURE_KEYS)
        for (const code of profileFor(target).features[key].diagnostics)
          expect(sources, `${target}/${key} declares ${code}`).toContain(`"${code}"`);
  });

  it("produces a compatibility entry for every component on every target", () => {
    const matrix = compatibilityMatrix(TARGETS);
    expect(Object.keys(matrix)).toEqual([...TARGETS]);
    for (const target of TARGETS)
      for (const key of FEATURE_KEYS) expect(matrix[target][key]).toBeTruthy();
    // The free-text table this replaced omitted cursor's mcp entry entirely.
    expect(matrix.cursor.mcp).toBeTruthy();
  });

  it("round-trips the specs payload through JSON", () => {
    const payload = specsPayload(TARGETS);
    expect(payload.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("records install locations from the paths the hosts actually scan", () => {
    expect(profileFor("cursor").install).toEqual({
      user: {
        root: "~/.cursor/plugins/local",
        layout: "plugin-dir",
        profile: "plugin",
        activation: null,
      },
      project: { root: ".", layout: "merge", profile: "project", activation: null },
    });
    expect(profileFor("claude-code").install).toEqual({
      user: {
        root: "~/.claude/plugins/marketplaces",
        layout: "marketplace",
        profile: "plugin",
        activation: { file: "~/.claude/settings.json", form: "claude-enabled-plugins" },
      },
      project: { root: ".", layout: "merge", profile: "project", activation: null },
    });
    expect(profileFor("codex").install?.user).toBeNull();
    expect(profileFor("codex").install?.project).toEqual({
      root: ".",
      layout: "merge",
      profile: "project",
      activation: null,
    });
  });
});

describe("output patterns", () => {
  it("matches a single segment for a named placeholder", () => {
    const pattern = outputPatternToRegExp("agents/{name}.md");
    expect(pattern.test("agents/reviewer.md")).toBe(true);
    expect(pattern.test("agents/nested/reviewer.md")).toBe(false);
    expect(pattern.test("agents/reviewer.txt")).toBe(false);
  });

  it("matches any suffix for a trailing double star, including none", () => {
    const pattern = outputPatternToRegExp("skills/{name}/**");
    expect(pattern.test("skills/build/SKILL.md")).toBe(true);
    expect(pattern.test("skills/build/agents/openai.yaml")).toBe(true);
    expect(pattern.test("skills/build")).toBe(true);
    expect(pattern.test("skills")).toBe(false);
  });

  it("treats dots literally", () => {
    const pattern = outputPatternToRegExp(".claude-plugin/plugin.json");
    expect(pattern.test(".claude-plugin/plugin.json")).toBe(true);
    expect(pattern.test("xclaude-plugin/pluginXjson")).toBe(false);
  });

  it("resolves paths against the declared profile", () => {
    const profile = profileFor("claude-code");
    expect(describesPath(profile, "plugin", ".claude-plugin/plugin.json")).toBe(true);
    expect(describesPath(profile, "project", ".claude/rules/style.md")).toBe(true);
    // The project profile has no plugin manifest.
    expect(describesPath(profile, "project", ".claude-plugin/plugin.json")).toBe(false);
  });
});

describe("version comparison", () => {
  it("parses and rejects", () => {
    expect(parseSemver("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseSemver("1.2.3-beta.1")?.prerelease).toBe("beta.1");
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("x")).toBeNull();
  });

  it("orders releases and prereleases", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.10.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("1.2.3-beta", "1.2.3")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3-beta")).toBe(1);
    expect(compareSemver("1.2.3-alpha", "1.2.3-beta")).toBe(-1);
    expect(() => compareSemver("1.2", "1.2.3")).toThrow(/Invalid version/);
  });
});

describe("profile self-check", () => {
  it("reports an inconsistent profile", () => {
    const broken = {
      ...TARGET_PROFILES["claude-code"],
      schemaVersion: "99",
      host: { ...TARGET_PROFILES["claude-code"].host, minimumVersion: "not-a-version" },
      outputs: { plugin: [], project: [] },
    };
    const problems = validateProfile(broken);
    expect(problems.join("\n")).toMatch(/schemaVersion/);
    expect(problems.join("\n")).toMatch(/not a valid semantic version/);
    expect(problems.join("\n")).toMatch(/declares no output patterns/);
  });

  it("rejects a reference form that cannot spell a component name", () => {
    const cursor = TARGET_PROFILES.cursor;
    const broken = {
      ...cursor,
      naming: {
        ...cursor.naming,
        references: {
          forms: {
            ...cursor.naming.references.forms,
            skill: { plugin: "{bundle}", project: "{name}" },
          },
        },
      },
    };
    expect(validateProfile(broken).join("\n")).toMatch(/does not substitute \{name\}/);
  });

  it("rejects prefixing a kind the host cannot then reference", () => {
    // A prefixed identity no reference form can spell is a component nothing in
    // the bundle can name -- the mismatch the naming block replaced.
    const codex = TARGET_PROFILES.codex;
    const broken = {
      ...codex,
      naming: {
        ...codex.naming,
        namespace: { prefixed: { skills: [], agents: ["plugin"] }, separator: "-" },
      },
    };
    expect(validateProfile(broken).join("\n")).toMatch(
      /prefixes agents in 'plugin' but declares no agent reference form/,
    );
  });

  it("rejects a minimum above the verified ceiling", () => {
    const broken = {
      ...TARGET_PROFILES.codex,
      host: { ...TARGET_PROFILES.codex.host, minimumVersion: "3.0.0", verifiedThrough: "2.0.0" },
    };
    expect(validateProfile(broken).join("\n")).toMatch(/greater than verifiedThrough/);
  });
});
