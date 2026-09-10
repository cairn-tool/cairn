import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBundle, splitFrontmatter } from "../../src/agent/parser.js";
import { processTargetBlocks, renderBundle } from "../../src/agent/render.js";

const temporary: string[] = [];

function bundleRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bundle-unit-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "skills", "release"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agent-bundle.yaml"),
    "schemaVersion: '1'\nname: sample\nversion: 1.0.0\ndescription: Sample bundle\n",
  );
  fs.writeFileSync(
    path.join(root, "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Prepare a release\n---\nUse ${ARGUMENTS}.\n<!-- target:cursor -->Cursor only.\n<!-- /target:cursor -->\n",
  );
  fs.writeFileSync(path.join(root, "skills", "release", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent bundles", () => {
  it("parses frontmatter and conventional components", () => {
    const bundle = loadBundle(bundleRoot());
    expect(bundle.name).toBe("sample");
    expect(bundle.skills.map((skill) => skill.name)).toEqual(["release"]);
    expect(bundle.diagnostics).toEqual([]);
  });

  it("rejects malformed frontmatter", () => {
    expect(() => splitFrontmatter("---\nname: [\n---\nbody", "bad.md")).toThrow(
      "invalid frontmatter",
    );
  });

  it("processes canonical and legacy target blocks", () => {
    const source =
      "A\n<!-- target:cursor -->C\n<!-- /target:cursor -->\n<!-- platform:codex -->X\n<!-- /platform:codex -->";
    expect(processTargetBlocks(source, "cursor")).toContain("C");
    expect(processTargetBlocks(source, "cursor")).not.toContain("X");
  });

  it("treats a comma list as OR and a leading not as negation", () => {
    const source =
      "<!-- if target:codex, cursor -->BOTH<!-- endif -->\n<!-- if not target:cursor -->NOTCURSOR<!-- endif -->\n";
    expect(processTargetBlocks(source, "cursor")).toContain("BOTH");
    expect(processTargetBlocks(source, "codex")).toContain("BOTH");
    expect(processTargetBlocks(source, "claude-code")).not.toContain("BOTH");
    expect(processTargetBlocks(source, "cursor")).not.toContain("NOTCURSOR");
    expect(processTargetBlocks(source, "codex")).toContain("NOTCURSOR");
  });

  it("takes exactly one branch of an if/elif/else chain", () => {
    const source =
      "<!-- if target:claude-code -->A<!-- elif target:codex,cursor -->B<!-- else -->C<!-- endif -->";
    expect(processTargetBlocks(source, "claude-code")).toBe("A");
    expect(processTargetBlocks(source, "codex")).toBe("B");
    expect(processTargetBlocks(source, "cursor")).toBe("B");
    expect(processTargetBlocks(source, "antigravity")).toBe("C");
  });

  it("resolves nested conditionals", () => {
    const source =
      "<!-- if not target:cursor -->outer<!-- if target:codex -->inner<!-- endif --><!-- endif -->";
    expect(processTargetBlocks(source, "codex")).toBe("outerinner");
    expect(processTargetBlocks(source, "claude-code")).toBe("outer");
    expect(processTargetBlocks(source, "cursor")).toBe("");
  });

  it("leaves markers inside a fenced code block alone", () => {
    // The defect this guard exists for: a fenced *example* of the syntax was
    // stripped as if it were live, so this project's own bundle-format
    // reference rendered with an empty code block.
    const source =
      "before\n\n```markdown\n<!-- target:cursor -->\nX\n<!-- /target:cursor -->\n```\n\nafter\n";
    expect(processTargetBlocks(source, "codex")).toBe(source);
    expect(processTargetBlocks(source, "cursor")).toBe(source);
  });

  it("leaves an unbalanced document alone rather than half-stripping it", () => {
    const source = "<!-- if target:codex -->kept\n";
    expect(processTargetBlocks(source, "codex")).toBe(source);
  });

  it("renders deterministic target layouts and preserves executable modes", () => {
    const rendered = renderBundle(
      loadBundle(bundleRoot()),
      ["claude-code", "cursor"],
      ["plugin", "project"],
    );
    const paths = rendered.artifacts.map((artifact) => artifact.path);
    expect(paths).toContain("claude-code/plugin/.claude-plugin/plugin.json");
    expect(paths).toContain("claude-code/project/.claude/skills/release/SKILL.md");
    expect(paths).toContain("cursor/plugin/skills/sample-release/SKILL.md");
    expect(paths).toContain("cursor/project/.cursor/skills/release/SKILL.md");
    expect(rendered.artifacts.find((artifact) => artifact.path.endsWith("run.sh"))?.mode).toBe(
      0o755,
    );
    const cursor = rendered.artifacts
      .find((artifact) => artifact.path === "cursor/plugin/skills/sample-release/SKILL.md")
      ?.content.toString();
    expect(cursor).toContain("Cursor only.");
    expect(cursor).toContain("literal `$ARGUMENTS`");
  });

  it("reports missing references and cycles", () => {
    const root = bundleRoot();
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release\nskills: [release, missing]\n---\nBody\n",
    );
    const codes = loadBundle(root).diagnostics.map((item) => item.code);
    expect(codes).toContain("AB150");
    expect(codes).toContain("AB160");
  });

  describe("shared resources", () => {
    /** A v2 bundle plus a sibling `shared/` directory outside it. */
    function sharedRoot(
      manifestExtra: string,
      resources: string,
    ): { root: string; parent: string } {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shared-unit-"));
      temporary.push(parent);
      const root = path.join(parent, "bundle");
      fs.mkdirSync(path.join(root, "skills", "release"), { recursive: true });
      fs.mkdirSync(path.join(parent, "shared"), { recursive: true });
      fs.writeFileSync(path.join(parent, "shared", "standards.md"), "# Shared standard\n");
      fs.writeFileSync(path.join(parent, "shared", "other.md"), "# Other\n");
      fs.writeFileSync(
        path.join(root, "agent-bundle.yaml"),
        `schemaVersion: '2'\nname: sample\nversion: 1.0.0\ndescription: Sample bundle\n${manifestExtra}`,
      );
      fs.writeFileSync(
        path.join(root, "skills", "release", "SKILL.md"),
        `---\nname: release\ndescription: Prepare a release\n${resources}---\nBody\n`,
      );
      return { root, parent };
    }

    it("materializes a declared resource from outside the bundle", () => {
      const { root } = sharedRoot(
        "resourceRoots:\n  - ../shared\n",
        "resources:\n  - path: ../../../shared/standards.md\n    as: reference/standards.md\n",
      );
      const bundle = loadBundle(root);
      expect(bundle.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      const skill = bundle.skills[0];
      const landed = skill.files.find(
        (file) => file.path.split(path.sep).join("/") === "reference/standards.md",
      );
      expect(landed?.content.toString("utf8")).toBe("# Shared standard\n");

      // It must land inside the skill's own rendered directory on every target,
      // because no placeholder can name a sibling skill's directory off Claude Code.
      const rendered = renderBundle(bundle, ["claude-code", "cursor"], ["plugin", "project"]);
      const paths = rendered.artifacts.map((artifact) => artifact.path);
      expect(paths).toContain("claude-code/plugin/skills/release/reference/standards.md");
      expect(paths).toContain("cursor/plugin/skills/sample-release/reference/standards.md");
      expect(paths).toContain("cursor/project/.cursor/skills/release/reference/standards.md");
    });

    it("rewrites the mapping form to its landing path in rendered frontmatter", () => {
      const { root } = sharedRoot(
        "resourceRoots:\n  - ../shared\n",
        "resources:\n  - path: ../../../shared/standards.md\n    as: reference/standards.md\n",
      );
      const rendered = renderBundle(loadBundle(root), ["claude-code"], ["plugin"]);
      const skill = rendered.artifacts.find(
        (artifact) => artifact.path === "claude-code/plugin/skills/release/SKILL.md",
      );
      const text = skill?.content.toString("utf8") ?? "";
      expect(text).toContain("reference/standards.md");
      // The authored path would be dead text in the rendered tree.
      expect(text).not.toContain("../../../shared/standards.md");
    });

    it("defaults the landing path to the resource basename", () => {
      const { root } = sharedRoot(
        "resourceRoots:\n  - ../shared\n",
        "resources:\n  - ../../../shared/standards.md\n",
      );
      const bundle = loadBundle(root);
      expect(bundle.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(bundle.skills[0].files.map((file) => file.path.split(path.sep).join("/"))).toContain(
        "standards.md",
      );
    });

    it("reports AB153 when no declared root covers the resource", () => {
      const { root } = sharedRoot("", "resources:\n  - ../../../shared/standards.md\n");
      const codes = loadBundle(root).diagnostics.map((item) => item.code);
      expect(codes).toContain("AB153");
    });

    it("reports AB154 when two resources land at the same path", () => {
      const { root } = sharedRoot(
        "resourceRoots:\n  - ../shared\n",
        "resources:\n  - path: ../../../shared/standards.md\n    as: reference/x.md\n  - path: ../../../shared/other.md\n    as: reference/x.md\n",
      );
      const codes = loadBundle(root).diagnostics.map((item) => item.code);
      expect(codes).toContain("AB154");
    });

    it("reports AB155 for a missing or absolute declared root", () => {
      const missing = sharedRoot("resourceRoots:\n  - ../nope\n", "");
      expect(loadBundle(missing.root).diagnostics.map((item) => item.code)).toContain("AB155");
      const absolute = sharedRoot("resourceRoots:\n  - /etc\n", "");
      expect(loadBundle(absolute.root).diagnostics.map((item) => item.code)).toContain("AB155");
    });

    it("refuses a landing path that would escape the component", () => {
      const { root } = sharedRoot(
        "resourceRoots:\n  - ../shared\n",
        "resources:\n  - path: ../../../shared/standards.md\n    as: ../escape.md\n",
      );
      const codes = loadBundle(root).diagnostics.map((item) => item.code);
      expect(codes).toContain("AB152");
    });

    it("still reports AB151 for a missing component-local resource", () => {
      const { root } = sharedRoot("", "resources:\n  - reference/absent.md\n");
      const codes = loadBundle(root).diagnostics.map((item) => item.code);
      expect(codes).toContain("AB151");
    });

    it("refuses resourceRoots on a schemaVersion 1 bundle", () => {
      const root = bundleRoot();
      fs.writeFileSync(
        path.join(root, "agent-bundle.yaml"),
        "schemaVersion: '1'\nname: sample\nversion: 1.0.0\ndescription: Sample\nresourceRoots:\n  - ../shared\n",
      );
      expect(loadBundle(root).diagnostics.map((item) => item.code)).toContain("AB127");
    });
  });

  it("rejects component paths outside the bundle", () => {
    const root = bundleRoot();
    fs.writeFileSync(
      path.join(root, "agent-bundle.yaml"),
      "schemaVersion: '1'\nname: sample\nversion: 1.0.0\ndescription: Sample\nskills: ../skills\n",
    );
    expect(() => loadBundle(root)).toThrow("escapes the bundle root");
  });

  it("validates target blocks and target IDs", () => {
    const root = bundleRoot();
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release\ninclude: [future]\n---\n<!-- target:future -->bad\n",
    );
    const codes = loadBundle(root).diagnostics.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(["AB106", "AB120", "AB121"]));
  });

  it("reports AB123 for a marker that looks conditional but does not parse", () => {
    // Each of these used to match neither regex and so did nothing, silently.
    for (const marker of [
      "<!-- target: cursor -->",
      "<!-- targets:cursor -->",
      "<!-- if target: cursor -->",
      "<!-- elif not target -->",
    ]) {
      const root = bundleRoot();
      fs.writeFileSync(
        path.join(root, "skills", "release", "SKILL.md"),
        `---\nname: release\ndescription: Release\n---\n${marker}\n`,
      );
      const codes = loadBundle(root).diagnostics.map((item) => item.code);
      expect(codes, marker).toContain("AB123");
    }
  });

  it("does not mistake an ordinary HTML comment for a conditional", () => {
    const root = bundleRoot();
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release\n---\n<!-- if you change this, update the docs -->\n<!-- TODO: platform support -->\n",
    );
    const codes = loadBundle(root).diagnostics.map((item) => item.code);
    expect(codes).not.toContain("AB123");
    expect(codes).not.toContain("AB121");
  });

  it("reports an else with no enclosing block, and a doubled else", () => {
    const root = bundleRoot();
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release\n---\n<!-- else -->\n<!-- if target:codex -->a<!-- else -->b<!-- else -->c<!-- endif -->\n",
    );
    const codes = loadBundle(root).diagnostics.map((item) => item.code);
    expect(codes).toContain("AB121");
  });

  it("validates conditional blocks in a textual asset, not only Markdown", () => {
    // The renderer processes blocks in hook scripts too, so an unclosed block
    // there was silently mangled with no diagnostic.
    const root = bundleRoot();
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "assets", "setup.sh"),
      "#!/bin/sh\n<!-- if target: codex -->\n",
    );
    const codes = loadBundle(root).diagnostics.map((item) => item.code);
    expect(codes).toContain("AB123");
  });

  it("withholds marketplace assets from the project profile and keeps the rest", () => {
    // AB502 makes `marketplace.icon` mandatory, so before this every pair of
    // schema 2 bundles merged into one project destination collided (AB808) on
    // `assets/icon.svg` -- a file only a catalog reads, and a catalog is only
    // built from the plugin profile. The linked asset beside it still renders.
    const root = bundleRoot();
    fs.mkdirSync(path.join(root, "art"), { recursive: true });
    fs.writeFileSync(path.join(root, "art", "icon.svg"), "<svg/>\n");
    fs.writeFileSync(path.join(root, "art", "shot.png"), "png\n");
    fs.writeFileSync(path.join(root, "art", "cli-basics.md"), "Conventions.\n");
    fs.writeFileSync(
      path.join(root, "agent-bundle.yaml"),
      [
        "schemaVersion: '2'",
        "name: sample",
        "version: 1.0.0",
        "description: Sample bundle",
        "components:",
        "  assets: art",
        "marketplace:",
        "  icon: art/icon.svg",
        "  screenshots: [art/shot.png]",
        "",
      ].join("\n"),
    );
    const rendered = renderBundle(loadBundle(root), ["claude-code"], ["plugin", "project"]);
    const paths = rendered.artifacts.map((artifact) => artifact.path);
    expect(paths).toContain("claude-code/plugin/assets/icon.svg");
    expect(paths).toContain("claude-code/plugin/assets/shot.png");
    expect(paths).toContain("claude-code/plugin/assets/cli-basics.md");
    expect(paths).not.toContain("claude-code/project/assets/icon.svg");
    expect(paths).not.toContain("claude-code/project/assets/shot.png");
    expect(paths).toContain("claude-code/project/assets/cli-basics.md");
  });

  it("normalizes typed hooks and copies executable hook scripts", () => {
    const root = bundleRoot();
    fs.mkdirSync(path.join(root, "hooks"));
    fs.writeFileSync(
      path.join(root, "hooks", "hooks.yaml"),
      "hooks:\n  pre-tool-use:\n    - matcher: shell\n      command: ${BUNDLE_ROOT}/hooks/check.sh\n      timeout: 5\n",
    );
    fs.writeFileSync(path.join(root, "hooks", "check.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const rendered = renderBundle(loadBundle(root), ["claude-code", "cursor"], ["plugin"]);
    const claude = JSON.parse(
      rendered.artifacts
        .find((artifact) => artifact.path === "claude-code/plugin/hooks/hooks.json")!
        .content.toString(),
    );
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain("CLAUDE_PLUGIN_ROOT");
    const cursor = JSON.parse(
      rendered.artifacts
        .find((artifact) => artifact.path === "cursor/plugin/hooks/hooks.json")!
        .content.toString(),
    );
    expect(cursor.version).toBe(1);
    expect(
      rendered.artifacts.find((artifact) => artifact.path.endsWith("hooks/check.sh"))?.mode,
    ).toBe(0o755);
  });

  it("renders command policies with native decisions and examples", () => {
    const root = bundleRoot();
    fs.mkdirSync(path.join(root, "policies"));
    fs.writeFileSync(
      path.join(root, "policies", "git.yaml"),
      "rules:\n  - pattern: [git, push]\n    action: deny\n    justification: Use reviewed automation\n    positiveExamples: [git push origin main]\n    negativeExamples: [git status]\n",
    );
    const rendered = renderBundle(loadBundle(root), ["codex", "cursor"], ["project"]);
    const codex = rendered.artifacts
      .find((artifact) => artifact.path === "codex/project/.codex/rules/bundle.rules")!
      .content.toString();
    expect(codex).toContain('decision = "forbidden"');
    expect(codex).toContain("not_match");
    expect(rendered.diagnostics.map((item) => item.code)).toContain("AB361");
  });

  it("omits manifest keys the host derives from the layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bundle-implied-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "skills", "release"), { recursive: true });
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "agent-bundle.yaml"),
      "schemaVersion: '2'\nname: sample\nversion: 1.0.0\ndescription: Sample bundle\n",
    );
    fs.writeFileSync(
      path.join(root, "hooks", "hooks.yaml"),
      "hooks:\n  session-start:\n    - command: echo\n      args: [hi]\n",
    );
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Prepare a release\n---\nShip it.\n",
    );
    fs.writeFileSync(
      path.join(root, "agents", "auditor.agent.md"),
      "---\nname: auditor\ndescription: Audit things\n---\nAudit.\n",
    );
    const rendered = renderBundle(loadBundle(root), ["claude-code", "cursor"], ["plugin"]);
    const read = (target: string, file: string): Record<string, unknown> =>
      JSON.parse(
        rendered.artifacts
          .find((artifact) => artifact.path === `${target}/plugin/${file}`)!
          .content.toString(),
      );
    // `agents` takes a list of files and rejects a directory, failing the whole
    // manifest; naming the standard `hooks/hooks.json` the host already loaded
    // is a duplicate that drops the plugin's hooks. Omitting both is what loads
    // them. `claude plugin validate` catches neither.
    const claude = read("claude-code", ".claude-plugin/plugin.json");
    expect(claude.agents).toBeUndefined();
    expect(claude.hooks).toBeUndefined();
    expect(claude.skills).toBe("./skills/");
    for (const emitted of ["agents/auditor.md", "hooks/hooks.json"])
      expect(
        rendered.artifacts.some((artifact) => artifact.path === `claude-code/plugin/${emitted}`),
      ).toBe(true);
    // Cursor declares no implied keys, so its manifest is unchanged.
    const cursor = read("cursor", ".cursor-plugin/plugin.json");
    expect(cursor.agents).toBe("./agents/");
    expect(cursor.hooks).toBe("./hooks/hooks.json");
  });
});

/**
 * A bundle with a skill, a command-shaped skill, an agent and an asset, all
 * naming each other — the shapes the reference directive exists for.
 */
function referenceBundleRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ref-unit-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "skills", "review", "reference"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "standards"), { recursive: true });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agent-bundle.yaml"),
    "schemaVersion: '2'\nname: cr\nversion: 1.0.0\ndescription: Reference bundle\n",
  );
  fs.writeFileSync(
    path.join(root, "skills", "standards", "SKILL.md"),
    "---\nname: standards\ndescription: The formats.\n---\n# standards\nBody.\n",
  );
  fs.writeFileSync(
    path.join(root, "skills", "review", "SKILL.md"),
    [
      "---",
      "name: review",
      "description: Uses the <!-- ref:skill:standards --> skill.",
      "invocationPolicy: explicit",
      'argumentHint: "[<!-- ref:skill:standards -->]"',
      "---",
      "",
      "# review",
      "",
      "Formats live in the `<!-- ref:skill:standards -->` skill.",
      "Spawn `<!-- ref:agent:diff-reviewer -->` per batch.",
      "Run <!-- ref:command:review --> to start.",
      "",
      "<!-- ref:skill:standards -->",
      "next line survives",
      "",
      "```markdown",
      "Fenced: <!-- ref:skill:standards -->",
      "```",
      "",
      "<!-- if target:codex -->only codex: <!-- ref:skill:standards --><!-- endif -->",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "skills", "review", "reference", "notes.md"),
    "Sibling names `<!-- ref:agent:diff-reviewer -->`.\n",
  );
  fs.writeFileSync(
    path.join(root, "agents", "diff-reviewer.agent.md"),
    "---\nname: diff-reviewer\ndescription: Reviews a slice.\n---\n# diff-reviewer\nNot `<!-- ref:agent:diff-reviewer -->`'s call.\n",
  );
  fs.writeFileSync(
    path.join(root, "assets", "basics.md"),
    "Asset: <!-- ref:skill:standards -->.\n",
  );
  return root;
}

describe("cursor component namespacing", () => {
  const render = (target: "cursor" | "claude-code") => {
    const rendered = renderBundle(
      loadBundle(referenceBundleRoot()),
      [target],
      ["plugin", "project"],
    );
    const read = (file: string): string => {
      const artifact = rendered.artifacts.find((entry) => entry.path === file);
      if (!artifact)
        throw new Error(
          `no artifact ${file}; have ${rendered.artifacts.map((a) => a.path).join(", ")}`,
        );
      return artifact.content.toString("utf8");
    };
    return { rendered, read, paths: rendered.artifacts.map((entry) => entry.path) };
  };

  it("prefixes a plugin skill's directory and its frontmatter name together", () => {
    // The defect: the directory was namespaced while `name:` was not, so one
    // skill shipped under two identities.
    const { read, paths } = render("cursor");
    expect(paths).toContain("cursor/plugin/skills/cr-review/SKILL.md");
    expect(read("cursor/plugin/skills/cr-review/SKILL.md")).toContain("name: cr-review");
  });

  it("prefixes a plugin agent's filename and its frontmatter name", () => {
    const { read, paths } = render("cursor");
    expect(paths).toContain("cursor/plugin/agents/cr-diff-reviewer.md");
    expect(paths).not.toContain("cursor/plugin/agents/diff-reviewer.md");
    expect(read("cursor/plugin/agents/cr-diff-reviewer.md")).toContain("name: cr-diff-reviewer");
  });

  it("leaves the project profile bare, where nothing is namespaced", () => {
    const { read, paths } = render("cursor");
    expect(paths).toContain("cursor/project/.cursor/skills/review/SKILL.md");
    expect(paths).toContain("cursor/project/.cursor/agents/diff-reviewer.md");
    expect(read("cursor/project/.cursor/skills/review/SKILL.md")).toContain("name: review");
  });

  it("leaves every other target unprefixed", () => {
    const { read, paths } = render("claude-code");
    expect(paths).toContain("claude-code/plugin/skills/review/SKILL.md");
    expect(paths).toContain("claude-code/plugin/agents/diff-reviewer.md");
    expect(read("claude-code/plugin/skills/review/SKILL.md")).toContain("name: review");
  });
});

describe("inline component references", () => {
  const bodyOf = (target: "cursor" | "claude-code" | "codex", file: string): string => {
    const rendered = renderBundle(loadBundle(referenceBundleRoot()), [target], ["plugin"]);
    const artifact = rendered.artifacts.find((entry) => entry.path === file);
    if (!artifact) throw new Error(`no artifact ${file}`);
    return artifact.content.toString("utf8");
  };

  it("resolves each kind to the identity the host actually uses", () => {
    const cursor = bodyOf("cursor", "cursor/plugin/skills/cr-review/SKILL.md");
    expect(cursor).toContain("`cr-standards` skill");
    expect(cursor).toContain("`cr-diff-reviewer` per batch");
    expect(cursor).toContain("Run cr-review to start.");

    const claude = bodyOf("claude-code", "claude-code/plugin/skills/review/SKILL.md");
    expect(claude).toContain("`cr:standards` skill");
    expect(claude).toContain("`cr:diff-reviewer` per batch");
    expect(claude).toContain("Run /cr:review to start.");
  });

  it("expands inside an inline code span but not inside a fenced block", () => {
    // The asymmetry with conditionals: `` `<!-- ref:skill:x -->` `` is how a
    // sentence names a skill in code voice, so protecting spans would make the
    // most natural spelling the one that silently does nothing. A fenced
    // example still has to survive, or this syntax cannot be documented.
    const cursor = bodyOf("cursor", "cursor/plugin/skills/cr-review/SKILL.md");
    expect(cursor).toContain("`cr-standards`");
    expect(cursor).toContain("Fenced: <!-- ref:skill:standards -->");
  });

  it("does not swallow the newline after a reference on its own line", () => {
    const cursor = bodyOf("cursor", "cursor/plugin/skills/cr-review/SKILL.md");
    expect(cursor).toContain("cr-standards\nnext line survives");
  });

  it("resolves references in frontmatter description and argument hint", () => {
    expect(bodyOf("cursor", "cursor/plugin/skills/cr-review/SKILL.md")).toContain(
      "description: Uses the cr-standards skill.",
    );
    expect(bodyOf("cursor", "cursor/plugin/skills/cr-review/SKILL.md")).toContain(
      'argument-hint: "[cr-standards]"',
    );
  });

  it("resolves references in sibling resources, agents and assets", () => {
    expect(bodyOf("cursor", "cursor/plugin/skills/cr-review/reference/notes.md")).toContain(
      "`cr-diff-reviewer`",
    );
    expect(bodyOf("cursor", "cursor/plugin/agents/cr-diff-reviewer.md")).toContain(
      "`cr-diff-reviewer`'s call",
    );
    expect(bodyOf("cursor", "cursor/plugin/assets/basics.md")).toContain("Asset: cr-standards.");
  });

  it("drops a reference with the conditional branch that was not taken", () => {
    expect(bodyOf("cursor", "cursor/plugin/skills/cr-review/SKILL.md")).not.toContain("only codex");
    expect(bodyOf("codex", "codex/plugin/skills/review/SKILL.md")).toContain(
      "only codex: standards",
    );
  });

  it("leaves markers verbatim when no resolver is supplied", () => {
    const source = "the `<!-- ref:skill:standards -->` skill\n";
    expect(processTargetBlocks(source, "cursor")).toBe(source);
  });

  it("leaves references unresolved in an unbalanced document", () => {
    const source = "<!-- if target:cursor --><!-- ref:skill:standards -->\n";
    expect(processTargetBlocks(source, "cursor")).toBe(source);
  });
});

describe("inline reference diagnostics", () => {
  /** `bundleRoot`'s single skill, with `body` as its whole document body. */
  const withBody = (body: string): string[] => {
    const root = bundleRoot();
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      `---\nname: release\ndescription: Release\n---\n${body}\n`,
    );
    return loadBundle(root).diagnostics.map((item) => item.code);
  };

  it("reports AB124 for a marker that looks like a reference but does not parse", () => {
    for (const marker of [
      "<!-- ref: skill:release -->",
      "<!-- refs:skill:release -->",
      "<!-- ref:skil:release -->",
      "<!-- ref:rule:release -->",
      "<!-- ref:skill: -->",
      "<!-- ref:skill:Not_Kebab -->",
    ])
      expect(withBody(marker), marker).toContain("AB124");
  });

  it("does not mistake an ordinary comment for a reference", () => {
    // `reference:` and `refactor` both begin with `ref`; only a colon straight
    // after `ref`/`refs` makes a comment one of these.
    const codes = withBody(
      "<!-- reference: docs/x.md -->\n<!-- refactor this later -->\n<!-- refresh the cache -->",
    );
    expect(codes).not.toContain("AB124");
    expect(codes).not.toContain("AB156");
  });

  it("reports AB156 for a reference to a component the bundle does not define", () => {
    expect(withBody("<!-- ref:skill:nope -->")).toContain("AB156");
    expect(withBody("<!-- ref:agent:nope -->")).toContain("AB156");
    // The skill exists, so the *name* resolves; only the kind's pool differs.
    expect(withBody("<!-- ref:agent:release -->")).toContain("AB156");
    expect(withBody("<!-- ref:skill:release -->")).not.toContain("AB156");
  });

  it("reports AB161 when a command reference names a model-invocable skill", () => {
    // A command is a skill the model does not reach for; referencing one that
    // is still auto-invocable names an entry point the host does not present.
    expect(withBody("<!-- ref:command:release -->")).toContain("AB161");
    const root = bundleRoot();
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release\ninvocationPolicy: explicit\n---\n<!-- ref:command:release -->\n",
    );
    expect(loadBundle(root).diagnostics.map((item) => item.code)).not.toContain("AB161");
  });

  it("reports AB157 where the renderer copies a file verbatim", () => {
    // Validation is wider than expansion, so a reference in a hook script would
    // otherwise ship as a literal comment with nothing to say so.
    const root = bundleRoot();
    fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "hooks", "hooks.yaml"),
      "session-start:\n  - command: ./hooks/start.sh\n",
    );
    fs.writeFileSync(
      path.join(root, "hooks", "start.sh"),
      "#!/bin/sh\n# names <!-- ref:skill:release -->\n",
      { mode: 0o755 },
    );
    const codes = loadBundle(root).diagnostics.map((item) => item.code);
    expect(codes).toContain("AB157");
  });

  it("does not treat a prose reference as a composition dependency", () => {
    // Two documents pointing at each other for further reading is normal --
    // cairn's own portability-triage and target-portability skills do it -- so
    // only the frontmatter `skills:` list feeds the AB160 cycle check. A
    // document naming itself, which a standards skill legitimately does, is not
    // a cycle either.
    const root = bundleRoot();
    fs.mkdirSync(path.join(root, "skills", "other"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release\n---\nsee <!-- ref:skill:other -->\n",
    );
    fs.writeFileSync(
      path.join(root, "skills", "other", "SKILL.md"),
      "---\nname: other\ndescription: Other\n---\nsee <!-- ref:skill:release -->\n",
    );
    expect(loadBundle(root).diagnostics.map((item) => item.code)).not.toContain("AB160");
    expect(
      withBody("this is <!-- ref:skill:release -->, run <!-- ref:command:release -->"),
    ).not.toContain("AB160");
  });
});
