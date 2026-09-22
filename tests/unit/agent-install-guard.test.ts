import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBundle } from "../../src/agent/parser.js";
import {
  INSTALL_MANIFEST,
  commitInstall,
  planInstall,
  readInstallDocument,
} from "../../src/agent/install/index.js";
import type { InstallRecord } from "../../src/agent/install/index.js";
import {
  DEFAULT_GUARD_SETTINGS,
  guardSettingsFrom,
  isGuardRecord,
  planGuard,
} from "../../src/agent/install/guard.js";
import { renderGuardScript } from "../../src/agent/install/guard-script.js";
import {
  composeHookDocument,
  guardCommand,
  stripHookDocument,
} from "../../src/agent/install/hook-document.js";
import { classifyPath, guardMessage } from "../../src/agent/guard/index.js";
import { parseGuardBlock } from "../../src/agent/guard/config.js";
import { TARGETS } from "../../src/agent/types.js";
import { profileFor } from "../../src/agent/targets/index.js";
import { packageVersion } from "../../src/version.js";

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-guard-")));
  temporary.push(root);
  return root;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A repository holding one bundle with a component of every kind the guard maps. */
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
  write(
    path.join(root, "bundles/demo/rules/style.md"),
    "---\nname: style\ndescription: Style.\nactivation: always\n---\n\nBe terse.\n",
  );
  write(path.join(root, "bundles/demo/mcp/mcp.yaml"), "servers: {}\n");
  write(path.join(root, "bundles/demo/assets/logo.svg"), "<svg/>\n");
  return root;
}

function install(root: string, target: "claude-code" | "cursor" | "codex"): void {
  commitInstall(
    planInstall(loadBundle(path.join(root, "bundles/demo")), target, {
      scope: "project",
      into: root,
    }),
  );
}

function document(root: string): InstallRecord[] {
  const read = readInstallDocument(root);
  if (read === "missing" || read === "malformed") throw new Error(`manifest is ${read}`);
  return read.installs;
}

describe("the hook document", () => {
  it("composes the guard's handler in each host's shape and finds it again", () => {
    const claude = composeHookDocument("claude-code", { permissions: { allow: ["x"] } });
    expect(claude).toEqual({
      permissions: { allow: ["x"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [
              { type: "command", command: '"${CLAUDE_PROJECT_DIR}"/.cairn-guard.sh', timeout: 10 },
            ],
          },
        ],
      },
    });
    // Once present, composing again changes nothing.
    expect(composeHookDocument("claude-code", claude)).toEqual(claude);

    const cursor = composeHookDocument("cursor", {});
    expect(cursor).toEqual({
      version: 1,
      hooks: {
        preToolUse: [
          {
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            command: "./.cairn-guard.sh",
            timeout: 10,
          },
        ],
      },
    });
  });

  it("replaces its handler in place rather than moving it to the end", () => {
    const stale = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo one" }] },
          { matcher: "Edit", hooks: [{ type: "command", command: "/old/.cairn-guard.sh" }] },
          { matcher: "Write", hooks: [{ type: "command", command: "echo three" }] },
        ],
      },
    };
    const composed = composeHookDocument("claude-code", stale);
    const matchers = (composed.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse.map(
      (entry) => entry.matcher,
    );
    expect(matchers).toEqual(["Bash", "Edit|Write|MultiEdit|NotebookEdit", "Write"]);
  });

  it("strips only its own handler and reports when nothing of substance remains", () => {
    const mixed = composeHookDocument("claude-code", {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
    });
    const stripped = stripHookDocument("claude-code", mixed);
    expect(stripped.changed).toBe(true);
    expect(stripped.empty).toBe(false);
    expect(stripped.document).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
    });

    const alone = stripHookDocument("cursor", composeHookDocument("cursor", {}));
    expect(alone).toEqual({ document: { version: 1 }, changed: true, empty: true });

    const untouched = stripHookDocument("claude-code", { permissions: {} });
    expect(untouched.changed).toBe(false);
    expect(untouched.empty).toBe(false);
  });

  it("spells the command with the host's own project root, quoted when it is a variable", () => {
    expect(guardCommand("claude-code")).toBe('"${CLAUDE_PROJECT_DIR}"/.cairn-guard.sh');
    expect(guardCommand("cursor")).toBe("./.cairn-guard.sh");
  });

  it("is declared by every target whose profile maps pre-tool-use", () => {
    for (const target of TARGETS) {
      const profile = profileFor(target);
      if (profile.paths.project.hooksFile !== null)
        expect(profile.hooks.events["pre-tool-use"], target).not.toBeNull();
    }
  });
});

describe("the guard script", () => {
  it("speaks the same refusal as agent guard", () => {
    const script = renderGuardScript({
      mode: "block",
      allow: [],
      regenerate: "cairn agent install",
      entries: [{ path: ".claude/skills/greet/SKILL.md", bundle: "demo", sources: ["a", "b"] }],
    }).toString("utf8");
    const spoken = guardMessage({
      path: "/x/.claude/skills/greet/SKILL.md",
      decision: "block",
      reason: "generated",
      sources: ["a", "b"],
      config: "/x/.cairn.yml",
      mode: "block",
      regenerate: "cairn agent install",
    });
    for (const line of spoken.split("\n"))
      if (line && !line.startsWith("  ") && !line.includes("is generated by"))
        expect(script, line).toContain(line);
    expect(script).toContain("Edit the source instead:");
    expect(script).toContain("Edit the source instead, in:");
  });

  it("orders entries by bytes and quotes what needs quoting", () => {
    const script = renderGuardScript({
      mode: "warn",
      allow: ["docs/**", ".claude/settings.local.json"],
      regenerate: "make agents",
      entries: [
        { path: "b/it's.md", bundle: "x", sources: [] },
        { path: "B/upper.md", bundle: "x", sources: ["src/B.md"] },
        { path: "a/z.md", sources: ["s2", "s1"] },
      ],
    }).toString("utf8");
    expect(script.indexOf("'B/upper.md')")).toBeLessThan(script.indexOf("'a/z.md')"));
    expect(script.indexOf("'a/z.md')")).toBeLessThan(script.indexOf("'b/it'\\''s.md')"));
    expect(script).toContain("sources='s1\ns2'");
    expect(script).toContain("'docs'|'docs/'*) exit 0 ;;");
    expect(script).toContain("'.claude/settings.local.json') exit 0 ;;");
    expect(script).toContain("mode=warn");
    expect(script).toContain("regenerate='make agents'");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });
});

describe("planning the guard for a destination", () => {
  it("names the same sources agent guard would, for every generated file", () => {
    const root = repository();
    install(root, "claude-code");
    install(root, "cursor");
    const records = document(root);
    const guard = planGuard({
      destination: root,
      records: records.filter((record) => !isGuardRecord(record)),
      drafts: [],
      priorGuards: records.filter(isGuardRecord),
      settings: DEFAULT_GUARD_SETTINGS,
      version: packageVersion,
    });
    expect(guard.diagnostics).toEqual([]);
    const script = guard.artifacts.find((artifact) => artifact.path === ".cairn-guard.sh");
    expect(script?.mode).toBe(0o755);

    // The command's oracle is the output patterns; the script's is the
    // inventory. They must agree on what to say about every generated file.
    const config = parseGuardBlock(
      {
        install: {
          targets: ["claude-code", "cursor"],
          scope: "project",
          into: ".",
          bundles: [{ path: "bundles/demo" }],
        },
        guard: { mode: "block" },
      },
      { file: path.join(root, ".cairn.yml"), directory: root },
    );
    if (!config) throw new Error("expected a guard config");
    const text = script!.content.toString("utf8");
    const generated = records
      .filter((record) => !isGuardRecord(record))
      .flatMap((record) => record.files.map((file) => file.path));
    expect(generated.length).toBeGreaterThan(5);
    for (const relative of new Set(generated)) {
      const verdict = classifyPath(path.join(root, relative), config);
      expect(verdict.decision, relative).toBe("block");
      const branch = text.slice(text.indexOf(`'${relative}')`));
      const sources = /sources='([^']*)'/.exec(branch.slice(0, branch.indexOf(";;")));
      expect((sources?.[1] ?? "").split("\n").filter(Boolean), relative).toEqual(verdict.sources);
    }
  });

  it("records what the manifest needs, and reads it back", () => {
    const root = repository();
    install(root, "claude-code");
    const records = document(root);
    const bundle = records.find((record) => !isGuardRecord(record));
    const guard = records.find(isGuardRecord);
    expect(bundle?.source).toBe("bundles/demo");
    expect(guard).toMatchObject({
      kind: "guard",
      bundle: { name: ".cairn-guard", version: packageVersion },
      target: "claude-code",
      profile: "project",
      scope: "project",
      layout: "merge",
      hookDocument: { created: true },
    });
    expect(guard?.files.map((file) => file.path)).toEqual([
      ".cairn-guard.sh",
      ".claude/settings.json",
    ]);

    // `created` is carried forward: on the second run the file exists because
    // cairn made it, and a fresh look would say otherwise.
    install(root, "claude-code");
    expect(document(root).find(isGuardRecord)?.hookDocument).toEqual({ created: true });
  });

  it("refuses a manifest whose record kind it does not know", () => {
    const root = workspace();
    const manifest = {
      generator: { name: "cairn", version: "1.0.0" },
      installs: [
        {
          kind: "mystery",
          bundle: { name: "x", version: "1.0.0" },
          target: "claude-code",
          profile: "project",
          scope: "project",
          layout: "merge",
          mode: "copy",
          destination: root,
          files: [],
        },
      ],
    };
    fs.writeFileSync(path.join(root, INSTALL_MANIFEST), JSON.stringify(manifest));
    expect(readInstallDocument(root)).toBe("malformed");
  });

  it("emits nothing where no target has a project hook surface", () => {
    const root = repository();
    install(root, "codex");
    const records = document(root);
    expect(records.some(isGuardRecord)).toBe(false);
    expect(fs.existsSync(path.join(root, ".cairn-guard.sh"))).toBe(false);
  });

  it("copies rather than links the guard under --link", () => {
    const root = repository();
    commitInstall(
      planInstall(loadBundle(path.join(root, "bundles/demo")), "claude-code", {
        scope: "project",
        into: root,
        link: true,
      }),
    );
    expect(fs.lstatSync(path.join(root, ".cairn-guard.sh")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(root, ".claude/settings.json")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(root, ".claude/skills/greet/SKILL.md")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("derives settings from the block, with a fixed regenerate default", () => {
    expect(guardSettingsFrom(undefined)).toEqual(DEFAULT_GUARD_SETTINGS);
    expect(guardSettingsFrom({ mode: "warn", allow: ["x"], regenerate: "make" })).toEqual({
      mode: "warn",
      allow: ["x"],
      regenerate: "make",
    });
    expect(guardSettingsFrom({ mode: "off", allow: [] }).regenerate).toBe("cairn agent install");
  });
});
