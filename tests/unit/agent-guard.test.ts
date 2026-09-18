import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseGuardBlock, isAllowlisted } from "../../src/agent/guard/config.js";
import { classifyPath, guardMessage } from "../../src/agent/guard/index.js";
import type { GuardConfig } from "../../src/agent/guard/config.js";
import { matchOutputPattern, TARGET_PROFILES } from "../../src/agent/targets/index.js";
import { describesPath } from "../../src/agent/targets/schema.js";
import type { AgentProfile } from "../../src/agent/types.js";
import { TARGETS } from "../../src/agent/types.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-guard-"));
  roots.push(root);
  return fs.realpathSync(root);
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A repository with one bundle installed into itself for `targets`. */
function repository(): string {
  const root = workspace();
  write(
    path.join(root, "bundles/demo/agent-bundle.yaml"),
    'schemaVersion: "2"\nname: demo\nversion: 1.0.0\ndescription: Demo.\n',
  );
  write(
    path.join(root, "bundles/demo/skills/greet/SKILL.md"),
    "---\nname: greet\ndescription: Say hello.\n---\n\n# Greet\n",
  );
  write(path.join(root, "bundles/demo/skills/greet/reference/notes.md"), "# Notes\n");
  write(
    path.join(root, "bundles/demo/agents/reviewer.agent.md"),
    "---\nname: reviewer\ndescription: Review.\n---\n\n# Reviewer\n",
  );
  write(path.join(root, "bundles/demo/mcp/mcp.yaml"), "servers: {}\n");
  write(path.join(root, "bundles/demo/assets/logo.svg"), "<svg/>\n");
  write(path.join(root, "bundles/demo/hooks/hooks.yaml"), "hooks: {}\n");
  write(path.join(root, "bundles/demo/hooks/run.sh"), "#!/bin/sh\n");
  return root;
}

function guardIn(root: string, block: Record<string, unknown>, extra = {}): GuardConfig {
  const agent = {
    install: {
      targets: ["claude-code"],
      scope: "project",
      into: ".",
      bundles: [{ path: "bundles/demo" }],
      ...extra,
    },
    guard: block,
  };
  const config = parseGuardBlock(agent, { file: path.join(root, ".cairn.yml"), directory: root });
  if (!config) throw new Error("expected a guard config");
  return config;
}

describe("matchOutputPattern", () => {
  it("captures the {name} segment that describesPath only tests for", () => {
    const profile = TARGET_PROFILES["claude-code"];
    const candidate = ".claude/skills/bundle-authoring/SKILL.md";
    expect(describesPath(profile, "project", candidate)).toBe(true);
    expect(matchOutputPattern(profile, "project", candidate)).toEqual({
      feature: "skills",
      pattern: ".claude/skills/{name}/**",
      name: "bundle-authoring",
      rest: "SKILL.md",
    });
  });

  it("captures a nested tail, and an empty one for the bare directory", () => {
    const profile = TARGET_PROFILES["claude-code"];
    expect(matchOutputPattern(profile, "project", ".claude/skills/x/reference/a/b.md")?.rest).toBe(
      "reference/a/b.md",
    );
    expect(matchOutputPattern(profile, "project", ".claude/skills/x")?.rest).toBe("");
  });

  it("matches a literal leaf with no captures at all", () => {
    expect(matchOutputPattern(TARGET_PROFILES["claude-code"], "project", ".mcp.json")).toEqual({
      feature: "mcp",
      pattern: ".mcp.json",
    });
  });

  it("returns null for a path no pattern describes", () => {
    expect(matchOutputPattern(TARGET_PROFILES["claude-code"], "project", "src/cli.ts")).toBeNull();
  });

  it("agrees with describesPath across the whole profile matrix", () => {
    // The capturing compiler is a second implementation of the same grammar.
    // These are the paths each declared pattern is meant to describe, plus a
    // near miss, exercised against both so the two cannot drift.
    for (const target of TARGETS)
      for (const profile of ["plugin", "project"] as AgentProfile[])
        for (const { pattern } of TARGET_PROFILES[target].outputs[profile] ?? []) {
          const candidate = pattern.replace(/\{[^}]+\}/g, "sample").replace(/\/\*\*$/, "/leaf.md");
          const declared = TARGET_PROFILES[target];
          expect(
            [
              describesPath(declared, profile, candidate),
              Boolean(matchOutputPattern(declared, profile, candidate)),
            ],
            `${target}/${profile} ${pattern}`,
          ).toEqual([true, true]);
          const miss = `unrelated/${candidate}`;
          expect(
            [
              describesPath(declared, profile, miss),
              Boolean(matchOutputPattern(declared, profile, miss)),
            ],
            `${target}/${profile} ${pattern} (miss)`,
          ).toEqual([false, false]);
        }
  });

  it("declares no two patterns in one cell that describe the same path", () => {
    // `classifyPath` takes the first match, which is only unambiguous while
    // this holds. A future profile that broke it would pick a feature by
    // declaration order, silently.
    for (const target of TARGETS)
      for (const profile of ["plugin", "project"] as AgentProfile[]) {
        const patterns = TARGET_PROFILES[target].outputs[profile] ?? [];
        for (const { pattern, feature } of patterns) {
          const candidate = pattern.replace(/\{[^}]+\}/g, "sample").replace(/\/\*\*$/, "/leaf.md");
          const matched = patterns.filter((entry) =>
            Boolean(
              matchOutputPattern(
                { ...TARGET_PROFILES[target], outputs: { [profile]: [entry] } } as never,
                profile,
                candidate,
              ),
            ),
          );
          expect(
            matched.map((entry) => entry.feature),
            `${target}/${profile} ${pattern}`,
          ).toEqual([feature]);
        }
      }
  });
});

describe("parseGuardBlock", () => {
  it("returns undefined when the block is absent, so nothing is guarded", () => {
    const root = workspace();
    const context = { file: path.join(root, ".cairn.yml"), directory: root };
    expect(parseGuardBlock(undefined, context)).toBeUndefined();
    expect(parseGuardBlock({ verify: { entries: [] } }, context)).toBeUndefined();
  });

  it("derives entries from agent.install rather than restating them", () => {
    const root = repository();
    const config = guardIn(root, {}, { targets: ["claude-code", "codex"] });
    expect(config.derived).toBe(true);
    expect(config.entries.map((entry) => `${entry.bundlePath}/${entry.target}`)).toEqual([
      "bundles/demo/claude-code",
      "bundles/demo/codex",
    ]);
    expect(config.entries[0].profile).toBe("project");
    expect(config.entries[0].destination).toBe(root);
  });

  it("derives nothing from a user-scope install", () => {
    const root = repository();
    const agent = {
      install: {
        targets: ["claude-code"],
        scope: "user",
        bundles: [{ path: "bundles/demo" }],
      },
      guard: {},
    };
    const config = parseGuardBlock(agent, {
      file: path.join(root, ".cairn.yml"),
      directory: root,
    });
    expect(config?.entries).toEqual([]);
  });

  it("defaults to blocking, and to allowing an unowned path", () => {
    const config = guardIn(repository(), {});
    expect(config.mode).toBe("block");
    expect(config.unowned).toBe("allow");
  });

  it("rejects an unknown key, mode, or escaping path", () => {
    const root = repository();
    expect(() => guardIn(root, { modes: "block" })).toThrow(/Unknown agent.guard key/);
    expect(() => guardIn(root, { mode: "refuse" })).toThrow(/agent.guard.mode must be one of/);
    expect(() => guardIn(root, { allow: ["../outside"] })).toThrow(/destination-relative/);
    expect(() =>
      guardIn(root, { entries: [{ bundle: "../elsewhere", target: "claude-code" }] }),
    ).toThrow(/escapes the configuration directory/);
  });
});

describe("isAllowlisted", () => {
  it("matches an exact path, and a /** prefix with its own directory", () => {
    expect(isAllowlisted([".claude/settings.json"], ".claude/settings.json")).toBe(true);
    expect(isAllowlisted([".claude/settings.json"], ".claude/settings.local.json")).toBe(false);
    expect(isAllowlisted([".claude/local/**"], ".claude/local")).toBe(true);
    expect(isAllowlisted([".claude/local/**"], ".claude/local/a/b.md")).toBe(true);
    expect(isAllowlisted([".claude/local/**"], ".claude/locale.md")).toBe(false);
  });
});

describe("classifyPath", () => {
  it("blocks a generated skill and names its source", () => {
    const root = repository();
    const config = guardIn(root, { regenerate: "cairn agent install" });
    const verdict = classifyPath(path.join(root, ".claude/skills/greet/SKILL.md"), config);
    expect(verdict.decision).toBe("block");
    expect(verdict.reason).toBe("generated");
    expect(verdict.bundle).toEqual({ name: "demo", path: "bundles/demo" });
    expect(verdict.sources).toEqual(["bundles/demo/skills/greet/SKILL.md"]);
    expect(verdict.match?.feature).toBe("skills");
    expect(verdict.match?.name).toBe("greet");
  });

  it("points at the sidecar being edited, not the skill document", () => {
    const root = repository();
    const config = guardIn(root, {});
    const verdict = classifyPath(
      path.join(root, ".claude/skills/greet/reference/notes.md"),
      config,
    );
    expect(verdict.sources).toEqual(["bundles/demo/skills/greet/reference/notes.md"]);
  });

  it("maps a subagent back through its .agent.md spelling", () => {
    const root = repository();
    const config = guardIn(root, {});
    const verdict = classifyPath(path.join(root, ".claude/agents/reviewer.md"), config);
    expect(verdict.reason).toBe("generated");
    expect(verdict.sources).toEqual(["bundles/demo/agents/reviewer.agent.md"]);
  });

  it("follows a frontmatter name that disagrees with the directory", () => {
    const root = repository();
    write(
      path.join(root, "bundles/demo/skills/local-dir/SKILL.md"),
      "---\nname: renamed\ndescription: Renamed.\n---\n\n# Renamed\n",
    );
    const config = guardIn(root, {});
    const verdict = classifyPath(path.join(root, ".claude/skills/renamed/SKILL.md"), config);
    expect(verdict.sources).toEqual(["bundles/demo/skills/local-dir/SKILL.md"]);
  });

  it("allows an ordinary file, and the bundle source itself", () => {
    const root = repository();
    const config = guardIn(root, {});
    expect(classifyPath(path.join(root, "src/index.ts"), config).reason).toBe("unmatched");
    const source = classifyPath(path.join(root, "bundles/demo/skills/greet/SKILL.md"), config);
    expect(source.decision).toBe("allow");
    expect(source.reason).toBe("unmatched");
  });

  it("reports a cairn-shaped path no bundle sources as unowned, and allows it by default", () => {
    const root = repository();
    const config = guardIn(root, {});
    const verdict = classifyPath(path.join(root, ".claude/skills/handwritten/SKILL.md"), config);
    expect(verdict.reason).toBe("unowned");
    expect(verdict.decision).toBe("allow");
    expect(verdict.sources).toEqual([]);
    expect(
      classifyPath(path.join(root, ".claude/skills/handwritten/SKILL.md"), {
        ...config,
        unowned: "block",
      }).decision,
    ).toBe("block");
  });

  it("honours the allow list and mode: off", () => {
    const root = repository();
    const allowed = guardIn(root, { allow: [".claude/skills/greet/**"] });
    expect(classifyPath(path.join(root, ".claude/skills/greet/SKILL.md"), allowed).reason).toBe(
      "allowlisted",
    );
    const off = guardIn(root, { mode: "off" });
    expect(classifyPath(path.join(root, ".claude/skills/greet/SKILL.md"), off).reason).toBe(
      "disabled",
    );
  });

  it("warns rather than blocks under mode: warn", () => {
    const root = repository();
    const config = guardIn(root, { mode: "warn" });
    const verdict = classifyPath(path.join(root, ".claude/skills/greet/SKILL.md"), config);
    expect(verdict.decision).toBe("warn");
    expect(verdict.reason).toBe("generated");
  });

  it("names every bundle behind a rendered file that merges several", () => {
    const root = repository();
    write(
      path.join(root, "bundles/other/agent-bundle.yaml"),
      'schemaVersion: "2"\nname: other\nversion: 1.0.0\ndescription: Other.\n',
    );
    write(path.join(root, "bundles/other/mcp/mcp.yaml"), "servers: {}\n");
    const config = guardIn(
      root,
      {},
      { bundles: [{ path: "bundles/demo" }, { path: "bundles/other" }] },
    );
    const verdict = classifyPath(path.join(root, ".mcp.json"), config);
    expect(verdict.reason).toBe("generated");
    expect(verdict.sources).toEqual(["bundles/demo/mcp/mcp.yaml", "bundles/other/mcp/mcp.yaml"]);
    // No single bundle owns it, so naming one would be misleading.
    expect(verdict.bundle).toBeUndefined();
  });

  it("does not claim an asset the bundle does not have", () => {
    const root = repository();
    const config = guardIn(root, {});
    expect(classifyPath(path.join(root, "assets/logo.svg"), config).reason).toBe("generated");
    expect(classifyPath(path.join(root, "assets/absent.svg"), config).reason).toBe("unowned");
  });

  it("withholds a marketplace asset from the project profile, as the renderer does", () => {
    const root = repository();
    write(
      path.join(root, "bundles/demo/agent-bundle.yaml"),
      'schemaVersion: "2"\nname: demo\nversion: 1.0.0\ndescription: Demo.\nmarketplace:\n  icon: assets/logo.svg\n',
    );
    const config = guardIn(root, {});
    expect(classifyPath(path.join(root, "assets/logo.svg"), config).reason).toBe("unowned");
  });

  it("maps a hook script and the rendered hook document back to source", () => {
    const root = repository();
    const config = guardIn(root, {}, { targets: ["claude-code"] });
    // Hooks are a plugin-profile feature, so the project entry cannot see them;
    // a plugin-profile entry is what a packaged plugin destination looks like.
    const plugin: GuardConfig = {
      ...config,
      entries: config.entries.map((entry) => ({ ...entry, profile: "plugin" as AgentProfile })),
    };
    expect(classifyPath(path.join(root, "hooks/run.sh"), plugin).sources).toEqual([
      "bundles/demo/hooks/run.sh",
    ]);
    expect(classifyPath(path.join(root, "hooks/hooks.json"), plugin).sources).toEqual([
      "bundles/demo/hooks/hooks.yaml",
    ]);
    expect(classifyPath(path.join(root, "hooks/absent.sh"), plugin).reason).toBe("unowned");
  });

  it("resolves a path outside every destination without touching the filesystem", () => {
    const root = repository();
    const config = guardIn(root, {});
    expect(classifyPath("/etc/hosts", config).reason).toBe("unmatched");
    expect(classifyPath(path.join(root, ".."), config).reason).toBe("unmatched");
  });
});

describe("guardMessage", () => {
  it("names the file, the source, and the command that regenerates", () => {
    const root = repository();
    const config = guardIn(root, { regenerate: "cairn agent install" });
    const verdict = classifyPath(path.join(root, ".claude/skills/greet/SKILL.md"), config);
    const message = guardMessage({
      ...verdict,
      config: config.file,
      mode: config.mode,
      regenerate: "cairn agent install",
    });
    expect(message).toContain(".claude/skills/greet/SKILL.md");
    expect(message).toContain("bundles/demo/skills/greet/SKILL.md");
    expect(message).toContain("cairn agent install");
    expect(message).toContain("Refusing to edit");
  });

  it("is empty when the decision allows, so no surface prints a stray refusal", () => {
    const root = repository();
    const config = guardIn(root, {});
    const verdict = classifyPath(path.join(root, "src/index.ts"), config);
    expect(guardMessage({ ...verdict, config: config.file, mode: config.mode })).toBe("");
  });
});
