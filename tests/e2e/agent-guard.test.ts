import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(cwd: string, ...args: string[]): Promise<Run> {
  try {
    const result = await exec("node", [cli, ...args], { cwd, env: { ...process.env, CI: "1" } });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

/** A repository with one bundle, a `.cairn.yml`, and a `cairn` shim on PATH. */
function workspace(guard = "  guard:\n    mode: block\n"): { root: string; shim: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-e2e-")));
  temporary.push(root);
  write(
    path.join(root, "bundles/demo/agent-bundle.yaml"),
    'schemaVersion: "2"\nname: demo\nversion: 1.0.0\ndescription: Demo.\n',
  );
  write(
    path.join(root, "bundles/demo/skills/greet/SKILL.md"),
    "---\nname: greet\ndescription: Say hello.\n---\n\n# Greet\n",
  );
  write(
    path.join(root, ".cairn.yml"),
    [
      "version: 1",
      "agent:",
      "  install:",
      "    targets: [claude-code, codex, cursor]",
      "    scope: project",
      "    into: .",
      "    bundles:",
      "      - path: bundles/demo",
      guard,
    ].join("\n"),
  );
  const shim = path.join(root, ".shim");
  write(path.join(shim, "cairn"), `#!/bin/sh\nexec node ${cli} "$@"\n`, 0o755);
  return { root, shim };
}

function payload(result: Run): Record<string, unknown> {
  return (JSON.parse(result.stdout) as { guard: Record<string, unknown> }).guard;
}

describe("agent guard", () => {
  it("exits 0 and reports not-configured where no block is declared", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-bare-")));
    temporary.push(root);
    write(path.join(root, "notes.md"), "# Notes\n");
    const result = await run(root, "agent", "guard", "notes.md", "--format", "json");
    expect(result.exitCode).toBe(0);
    expect(payload(result)).toMatchObject({ reason: "not-configured", decision: "allow" });
    expect(result.stderr).toBe("");
  });

  it("blocks a generated file and names the bundle source on stdout", async () => {
    const { root } = workspace();
    expect((await run(root, "agent", "install", "--config", ".cairn.yml")).exitCode).toBe(0);

    const result = await run(
      root,
      "agent",
      "guard",
      ".claude/skills/greet/SKILL.md",
      "--format",
      "json",
    );
    expect(result.exitCode).toBe(2);
    // Every agent subcommand puts findings on stdout, including this one.
    expect(result.stderr).toBe("");
    expect(payload(result)).toMatchObject({
      decision: "block",
      reason: "generated",
      bundle: { name: "demo", path: "bundles/demo" },
      sources: ["bundles/demo/skills/greet/SKILL.md"],
    });
  });

  it("blocks the same file for every target the install declares", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    for (const generated of [
      ".claude/skills/greet/SKILL.md",
      ".agents/skills/greet/SKILL.md",
      ".cursor/skills/greet/SKILL.md",
    ]) {
      const result = await run(root, "agent", "guard", generated, "--format", "json");
      expect(result.exitCode, generated).toBe(2);
      expect(payload(result).sources).toEqual(["bundles/demo/skills/greet/SKILL.md"]);
    }
  });

  it("allows the bundle source and an unrelated file", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    for (const allowed of ["bundles/demo/skills/greet/SKILL.md", ".cairn.yml"]) {
      const result = await run(root, "agent", "guard", allowed, "--format", "json");
      expect(result.exitCode, allowed).toBe(0);
      expect(payload(result).decision).toBe("allow");
    }
  });

  it("warns without blocking under mode: warn", async () => {
    const { root } = workspace("  guard:\n    mode: warn\n");
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const result = await run(
      root,
      "agent",
      "guard",
      ".claude/skills/greet/SKILL.md",
      "--format",
      "json",
    );
    expect(result.exitCode).toBe(0);
    expect(payload(result)).toMatchObject({ decision: "warn", reason: "generated" });
  });

  it("never writes, even to a destination it refuses", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const before = fs.readdirSync(root).sort();
    const generated = path.join(root, ".claude/skills/greet/SKILL.md");
    const bytes = fs.readFileSync(generated);
    await run(root, "agent", "guard", ".claude/skills/greet/SKILL.md");
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.readFileSync(generated)).toEqual(bytes);
  });
});

/**
 * Runs the guard `agent install` generated at `root`, directly -- through its
 * shebang and mode bits, as a host would -- with `event` on stdin.
 */
async function runGuard(root: string, event: unknown, cwd = root): Promise<Run> {
  const child = execFile(path.join(root, ".cairn-guard.sh"), [], { cwd }, () => undefined);
  child.stdin?.end(typeof event === "string" ? event : JSON.stringify(event));
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = await new Promise<number>((resolve) =>
    child.on("close", (code) => resolve(code ?? 0)),
  );
  return { stdout, stderr, exitCode };
}

function edit(file: string, tool = "Edit"): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: file } };
}

function settingsOf(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function preToolUse(root: string): unknown[] {
  const hooks = settingsOf(root).hooks as Record<string, unknown[]> | undefined;
  return hooks?.PreToolUse ?? [];
}

describe("the installed edit guard", () => {
  it("is written by a project-scope install and registered in each host's document", async () => {
    const { root } = workspace();
    const result = await run(root, "agent", "install", "--config", ".cairn.yml", "-fj");
    expect(result.exitCode).toBe(0);
    const script = path.join(root, ".cairn-guard.sh");
    expect(fs.statSync(script).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(script, "utf8").startsWith("#!/bin/sh\n")).toBe(true);

    // Claude Code: one nested handler in settings.json.
    const claude = preToolUse(root) as Array<Record<string, unknown>>;
    expect(claude).toHaveLength(1);
    expect(claude[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect((claude[0].hooks as Array<Record<string, unknown>>)[0].command).toBe(
      '"${CLAUDE_PROJECT_DIR}"/.cairn-guard.sh',
    );
    // Cursor: the flat, versioned shape.
    const cursor = JSON.parse(fs.readFileSync(path.join(root, ".cursor/hooks.json"), "utf8")) as {
      version: number;
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.preToolUse[0].command).toBe("./.cairn-guard.sh");

    // Codex declares no project hook surface: reported once, as a notice.
    const payload = JSON.parse(result.stdout) as {
      diagnostics: Array<{ code: string; severity: string; target?: string }>;
      install: { installs: Array<{ name: string }> };
    };
    const notices = payload.diagnostics.filter((item) => item.code === "AB810");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ severity: "notice", target: "codex" });
    // The install payload lists bundles; the guard's records show in `installed`.
    expect(payload.install.installs.map((entry) => entry.name)).toEqual(["demo", "demo", "demo"]);
    const installed = await run(
      root,
      "agent",
      "installed",
      "--target",
      "all",
      "--scope",
      "project",
      "-fj",
    );
    const rows = (
      JSON.parse(installed.stdout) as {
        install: { installs: Array<{ name: string; kind?: string }> };
      }
    ).install.installs;
    expect(rows.filter((row) => row.kind === "guard").map((row) => row.name)).toEqual([
      ".cairn-guard",
      ".cairn-guard",
    ]);
  });

  it("refuses a write to a generated file with the reason on stderr, forking nothing", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const result = await runGuard(root, edit(path.join(root, ".claude/skills/greet/SKILL.md")));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Refusing to edit a cairn-generated file.");
    expect(result.stderr).toContain("is generated by cairn from bundle 'demo'");
    expect(result.stderr).toContain("bundles/demo/skills/greet/SKILL.md");
    expect(result.stderr).toContain("cairn agent install");
    // Every target's files are in the one list, hook surface or not.
    expect(
      (await runGuard(root, edit(path.join(root, ".agents/skills/greet/SKILL.md")))).exitCode,
    ).toBe(2);
    expect((await runGuard(root, edit(path.join(root, ".cairn-guard.sh")))).exitCode).toBe(2);
  });

  it("answers Cursor with a deny decision on stdout rather than an exit code", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const result = await runGuard(root, {
      conversation_id: "c1",
      workspace_roots: [root],
      tool_name: "Write",
      tool_input: { file_path: path.join(root, ".cursor/skills/greet/SKILL.md") },
    });
    // Cursor ignores the status, so a nonzero one here would be a silent no-op.
    expect(result.exitCode).toBe(0);
    const decision = JSON.parse(result.stdout) as Record<string, string>;
    expect(decision.permission).toBe("deny");
    expect(decision.agentMessage).toContain("bundles/demo/skills/greet/SKILL.md");
    expect(decision.userMessage).toBe(decision.agentMessage);
  });

  it("allows everything that is not a write to a generated file", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    write(path.join(root, "notes.md"), "# Notes\n");
    const generated = path.join(root, ".claude/skills/greet/SKILL.md");
    for (const [label, event] of [
      ["the bundle source", edit(path.join(root, "bundles/demo/skills/greet/SKILL.md"))],
      ["an unrelated file", edit(path.join(root, "notes.md"))],
      ["a file outside the root", edit(path.join(os.tmpdir(), "elsewhere.md"))],
      [
        "a non-write tool",
        { ...edit(generated, "Bash"), tool_input: { command: `cat ${generated}` } },
      ],
      ["a call with no path", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }],
      ["an unparseable event", "not json"],
      ["an empty event", ""],
      ["a new file in a generated directory", edit(path.join(root, ".claude/skills/greet/new.md"))],
      // A JSON escape in the path is left undecoded, and undecoded means allow.
      [
        "an escaped path",
        `{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"${generated}\\u0041"}}`,
      ],
    ] as const) {
      const result = await runGuard(root, event);
      expect(result.exitCode, label).toBe(0);
      expect(result.stdout + result.stderr, label).toBe("");
    }
    // A decoy key inside a Write body is JSON-escaped and cannot match.
    const decoy = await runGuard(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: path.join(root, "notes.md"),
        content: `{"file_path": "${generated}"}`,
      },
    });
    expect(decoy.exitCode).toBe(0);
  });

  it("resolves a relative path against the working directory and a root through a symlink", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const relative = await runGuard(root, edit(".claude/skills/greet/SKILL.md"), root);
    expect(relative.exitCode).toBe(2);
    const link = path.join(os.tmpdir(), `guard-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(root, link);
    temporary.push(link);
    try {
      const viaLink = await runGuard(root, edit(path.join(link, ".claude/skills/greet/SKILL.md")));
      expect(viaLink.exitCode).toBe(2);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("honours agent.guard.allow, mode: warn, and mode: off", async () => {
    const generated = ".claude/skills/greet/SKILL.md";
    const allowed = workspace("  guard:\n    allow: [.claude/skills/**]\n");
    await run(allowed.root, "agent", "install", "--config", ".cairn.yml");
    expect((await runGuard(allowed.root, edit(path.join(allowed.root, generated)))).exitCode).toBe(
      0,
    );
    expect(
      (await runGuard(allowed.root, edit(path.join(allowed.root, ".cursor/skills/greet/SKILL.md"))))
        .exitCode,
    ).toBe(2);

    const warning = workspace("  guard:\n    mode: warn\n");
    await run(warning.root, "agent", "install", "--config", ".cairn.yml");
    const warned = await runGuard(warning.root, edit(path.join(warning.root, generated)));
    expect(warned.exitCode).toBe(0);
    expect(warned.stderr).toContain("the next render will overwrite it");

    const off = workspace("  guard:\n    mode: off\n");
    const result = await run(off.root, "agent", "install", "--config", ".cairn.yml", "-fj");
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(off.root, ".cairn-guard.sh"))).toBe(false);
    expect(fs.existsSync(path.join(off.root, ".claude/settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(off.root, ".cursor/hooks.json"))).toBe(false);
  });

  it("merges into a settings.json the user already has, in place, and settles", async () => {
    const { root } = workspace();
    const own = {
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };
    write(path.join(root, ".claude/settings.json"), JSON.stringify(own, null, 2) + "\n");
    expect((await run(root, "agent", "install", "--config", ".cairn.yml")).exitCode).toBe(0);
    const after = settingsOf(root);
    expect(after.permissions).toEqual(own.permissions);
    const handlers = preToolUse(root) as Array<Record<string, unknown>>;
    expect(handlers).toHaveLength(2);
    expect(handlers[0].matcher).toBe("Bash");
    const first = fs.readFileSync(path.join(root, ".claude/settings.json"));

    // The user appends a handler after cairn's; the next install replaces in
    // place rather than moving cairn's to the end, so the bytes settle.
    const edited = settingsOf(root);
    (edited.hooks as Record<string, unknown[]>).PreToolUse.push({
      matcher: "Write",
      hooks: [{ type: "command", command: "echo after" }],
    });
    write(path.join(root, ".claude/settings.json"), JSON.stringify(edited, null, 2) + "\n");
    expect((await run(root, "agent", "install", "--config", ".cairn.yml")).exitCode).toBe(0);
    const again = preToolUse(root) as Array<Record<string, unknown>>;
    expect(again.map((handler) => handler.matcher)).toEqual([
      "Bash",
      "Edit|Write|MultiEdit|NotebookEdit",
      "Write",
    ]);
    const second = fs.readFileSync(path.join(root, ".claude/settings.json"));
    expect((await run(root, "agent", "install", "--config", ".cairn.yml")).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(root, ".claude/settings.json")).equals(second)).toBe(true);
    expect(first.equals(second)).toBe(false);

    // The user's file is not a generated one, so editing it is allowed.
    expect((await runGuard(root, edit(path.join(root, ".claude/settings.json")))).exitCode).toBe(0);
  });

  it("is rebuilt when a bundle leaves, and retired with the last one", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    const generated = path.join(root, ".claude/skills/greet/SKILL.md");

    // The guard cannot be uninstalled by name: its files include the user's.
    const refused = await run(
      root,
      "agent",
      "uninstall",
      ".cairn-guard",
      "--target",
      "claude-code",
      "--scope",
      "project",
      "-fj",
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toContain("AB813");
    expect(fs.existsSync(path.join(root, ".cairn-guard.sh"))).toBe(true);

    // Dropping codex leaves the guard describing the survivors.
    expect(
      (await run(root, "agent", "uninstall", "demo", "--target", "codex", "--scope", "project"))
        .exitCode,
    ).toBe(0);
    expect((await runGuard(root, edit(generated))).exitCode).toBe(2);
    expect(fs.readFileSync(path.join(root, ".cairn-guard.sh"), "utf8")).not.toContain(
      ".agents/skills",
    );

    // The last bundle takes the guard with it: cairn created settings.json, so
    // it goes; the script goes; the manifest goes.
    expect(
      (await run(root, "agent", "uninstall", "demo", "--target", "cursor", "--scope", "project"))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await run(
          root,
          "agent",
          "uninstall",
          "demo",
          "--target",
          "claude-code",
          "--scope",
          "project",
        )
      ).exitCode,
    ).toBe(0);
    expect(fs.existsSync(path.join(root, ".cairn-guard.sh"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".claude/settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".cursor/hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".cairn-install.json"))).toBe(false);
  });

  it("strips its handler from a settings.json it did not create, and keeps the rest", async () => {
    const { root } = workspace();
    write(path.join(root, ".claude/settings.json"), '{\n  "permissions": {}\n}\n');
    await run(root, "agent", "install", "--config", ".cairn.yml");
    expect(preToolUse(root)).toHaveLength(1);
    for (const target of ["claude-code", "codex", "cursor"])
      await run(root, "agent", "uninstall", "demo", "--target", target, "--scope", "project");
    expect(fs.existsSync(path.join(root, ".claude/settings.json"))).toBe(true);
    expect(settingsOf(root)).toEqual({ permissions: {} });
  });

  it("reports a stale guard under --check and reproduces it under verify", async () => {
    const { root } = workspace();
    await run(root, "agent", "install", "--config", ".cairn.yml");
    expect(
      (await run(root, "agent", "install", "--config", ".cairn.yml", "--check")).exitCode,
    ).toBe(0);
    // A new skill in the bundle is a new generated path the script does not list.
    write(
      path.join(root, "bundles/demo/skills/wave/SKILL.md"),
      "---\nname: wave\ndescription: Wave.\n---\n\n# Wave\n",
    );
    const stale = await run(root, "agent", "install", "--config", ".cairn.yml", "--check", "-fj");
    expect(stale.exitCode).toBe(2);
    expect(JSON.parse(stale.stdout)).toMatchObject({ stale: true });

    await run(root, "agent", "install", "--config", ".cairn.yml");
    write(
      path.join(root, ".cairn.yml"),
      fs.readFileSync(path.join(root, ".cairn.yml"), "utf8") +
        [
          "  verify:",
          "    defaults: { scope: project, profile: project, layout: merge, unmanaged: strict }",
          "    entries:",
          "      - { name: a, bundle: bundles/demo, target: claude-code, destination: . }",
          "      - { name: b, bundle: bundles/demo, target: cursor, destination: . }",
          "",
        ].join("\n"),
    );
    const clean = await run(root, "agent", "verify", "--config", ".cairn.yml", "-fj");
    expect(clean.exitCode, clean.stdout).toBe(0);

    // Drift in the guard is reported once for the destination, not per entry.
    fs.appendFileSync(path.join(root, ".cairn-guard.sh"), "# edited\n");
    const drifted = await run(root, "agent", "verify", "--config", ".cairn.yml", "-fj");
    expect(drifted.exitCode).toBe(2);
    const findings = (
      JSON.parse(drifted.stdout) as { diagnostics: Array<{ code: string; path?: string }> }
    ).diagnostics.filter((item) => item.code === "AB402");
    expect(findings.map((item) => item.path)).toEqual([".cairn-guard.sh"]);
  });

  it("regenerates the guard on a partial run without a sibling conflict", async () => {
    const { root } = workspace();
    write(
      path.join(root, "bundles/other/agent-bundle.yaml"),
      'schemaVersion: "2"\nname: other\nversion: 1.0.0\ndescription: Other.\n',
    );
    write(
      path.join(root, "bundles/other/skills/wave/SKILL.md"),
      "---\nname: wave\ndescription: Wave.\n---\n\n# Wave\n",
    );
    write(
      path.join(root, ".cairn.yml"),
      fs
        .readFileSync(path.join(root, ".cairn.yml"), "utf8")
        .replace(
          "      - path: bundles/demo\n",
          "      - path: bundles/demo\n      - path: bundles/other\n",
        ),
    );
    expect((await run(root, "agent", "install", "--config", ".cairn.yml")).exitCode).toBe(0);
    const partial = await run(
      root,
      "agent",
      "install",
      "--config",
      ".cairn.yml",
      "--name",
      "other",
      "-fj",
    );
    expect(partial.exitCode, partial.stdout).toBe(0);
    const codes = (
      JSON.parse(partial.stdout) as { diagnostics: Array<{ code: string }> }
    ).diagnostics.map((item) => item.code);
    expect(codes).not.toContain("AB808");
    // Both bundles' files, with the absent bundle's source pointer read from the manifest.
    const refused = await runGuard(root, edit(path.join(root, ".claude/skills/greet/SKILL.md")));
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("bundles/demo/skills/greet/SKILL.md");
  });
});
