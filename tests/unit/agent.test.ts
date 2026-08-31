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
