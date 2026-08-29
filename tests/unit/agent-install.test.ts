import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBundle } from "../../src/agent/parser.js";
import {
  INSTALL_MANIFEST,
  LEGACY_INSTALL_MANIFEST,
  commitInstall,
  commitUninstall,
  expandInstallRoot,
  installIsCurrent,
  listInstalled,
  locationFor,
  missingInstallDiagnostic,
  pathEscapesRoot,
  planInstall,
  planUninstall,
  readInstallManifest,
} from "../../src/agent/install/index.js";
import { installHasFindings } from "../../src/commands/agent-install.js";
import type { AgentDiagnostic } from "../../src/agent/types.js";

const temporary: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-install-"));
  temporary.push(root);
  return root;
}

function bundle(extra = ""): string {
  const root = workspace();
  fs.writeFileSync(
    path.join(root, "agent-bundle.yaml"),
    `schemaVersion: '2'\nname: hello\nversion: 1.0.0\ndescription: Hello bundle\n${extra}`,
  );
  fs.mkdirSync(path.join(root, "skills", "greet"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: Say hello\n---\n\nSay hello.\n",
  );
  return root;
}

function hooked(): string {
  const root = bundle();
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: { "session-start": [{ command: "echo", args: ["hi"] }] },
    }),
  );
  return root;
}

function codes(diagnostics: AgentDiagnostic[]): string[] {
  return [...new Set(diagnostics.map((item) => item.code))];
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("install location resolution", () => {
  it("expands ~ against an injected home and . against cwd", () => {
    const home = workspace();
    const cwd = workspace();
    expect(expandInstallRoot("~/.cursor/plugins/local", { home, cwd })).toBe(
      path.join(home, ".cursor/plugins/local"),
    );
    expect(expandInstallRoot(".", { home, cwd })).toBe(cwd);
  });

  it("records a user location for cursor and none for codex", () => {
    expect(locationFor("cursor", "user")?.layout).toBe("plugin-dir");
    expect(locationFor("codex", "user")).toBeNull();
    expect(locationFor("codex", "project")?.layout).toBe("merge");
  });

  it("rejects a path that would escape the install root", () => {
    const root = workspace();
    expect(pathEscapesRoot(root, "../outside.md")).toBe(true);
    expect(pathEscapesRoot(root, "/etc/passwd")).toBe(true);
    expect(pathEscapesRoot(root, "skills/greet/SKILL.md")).toBe(false);
  });
});

describe("planInstall", () => {
  it("reports AB800 when the target has no location for the scope", () => {
    const plan = planInstall(loadBundle(bundle()), "codex", { scope: "user" });
    expect(codes(plan.diagnostics)).toContain("AB800");
    expect(plan.destination).toBe("");
  });

  it("plans a cursor user install under --into without writing", () => {
    const source = bundle();
    const into = path.join(workspace(), "plugins");
    const plan = planInstall(loadBundle(source), "cursor", { scope: "user", into });
    expect(plan.destination).toBe(path.join(into, "hello"));
    expect(plan.layout).toBe("plugin-dir");
    expect(plan.profile).toBe("plugin");
    expect(plan.artifacts.some((artifact) => artifact.path.endsWith("SKILL.md"))).toBe(true);
    expect(fs.existsSync(plan.destination)).toBe(false);
  });

  it("includes a marketplace catalog and AB805 without --register", () => {
    const home = workspace();
    const plan = planInstall(loadBundle(bundle()), "claude-code", {
      scope: "user",
      home,
    });
    expect(plan.layout).toBe("marketplace");
    expect(plan.artifacts.some((artifact) => artifact.path.endsWith("marketplace.json"))).toBe(
      true,
    );
    expect(codes(plan.diagnostics)).toContain("AB805");
    expect(plan.register).toBe(false);
  });

  it("reports AB803 when a feature does not render in the installed profile", () => {
    const into = workspace();
    const plan = planInstall(loadBundle(hooked()), "cursor", {
      scope: "project",
      into,
    });
    expect(codes(plan.diagnostics)).toContain("AB803");
    expect(plan.diagnostics.find((item) => item.code === "AB803")?.message).toMatch(/hooks/);
  });

  it("reports AB807 under --link", () => {
    const plan = planInstall(loadBundle(bundle()), "cursor", {
      scope: "user",
      into: workspace(),
      link: true,
    });
    expect(codes(plan.diagnostics)).toContain("AB807");
    expect(plan.mode).toBe("link");
    expect(plan.manifest.materialized).toMatch(/[/\\]\.install[/\\]cursor[/\\]plugin$/);
  });
});

describe("commitInstall and uninstall", () => {
  it("copies a cursor plugin-dir install and records an inventory", () => {
    const source = bundle();
    const into = workspace();
    const loaded = loadBundle(source);
    const plan = planInstall(loaded, "cursor", { scope: "user", into });
    commitInstall(plan);
    const dest = plan.destination;
    expect(fs.existsSync(path.join(dest, INSTALL_MANIFEST))).toBe(true);
    const manifest = readInstallManifest(dest);
    expect(manifest).not.toBe("missing");
    expect(manifest).not.toBe("malformed");
    if (manifest === "missing" || manifest === "malformed") return;
    expect(manifest.bundle.name).toBe("hello");
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const file of manifest.files)
      expect(fs.existsSync(path.join(dest, file.path)), file.path).toBe(true);
    expect(installIsCurrent(plan)).toBe(true);
  });

  it("refuses a foreign occupant without --force (AB801) and replaces a prior install (AB802)", () => {
    const source = bundle();
    const into = workspace();
    const dest = path.join(into, "hello");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "stranger.txt"), "nope");
    const blocked = planInstall(loadBundle(source), "cursor", { scope: "user", into });
    expect(codes(blocked.diagnostics)).toContain("AB801");
    expect(installHasFindings(blocked.diagnostics, false)).toBe(true);

    const forced = planInstall(loadBundle(source), "cursor", {
      scope: "user",
      into,
      force: true,
    });
    expect(codes(forced.diagnostics)).not.toContain("AB801");
    commitInstall(forced);

    const again = planInstall(loadBundle(source), "cursor", { scope: "user", into });
    expect(codes(again.diagnostics)).toContain("AB802");
    expect(installHasFindings(again.diagnostics, false)).toBe(false);
  });

  it("does not wipe unrelated project files on a merge install", () => {
    const source = bundle();
    const project = workspace();
    fs.writeFileSync(path.join(project, "README.md"), "keep\n");
    const plan = planInstall(loadBundle(source), "cursor", { scope: "project", into: project });
    commitInstall(plan);
    expect(fs.readFileSync(path.join(project, "README.md"), "utf8")).toBe("keep\n");
    expect(fs.existsSync(path.join(project, INSTALL_MANIFEST))).toBe(true);
    const removed = planUninstall("hello", "cursor", { scope: "project", into: project });
    commitUninstall(removed);
    expect(fs.readFileSync(path.join(project, "README.md"), "utf8")).toBe("keep\n");
    expect(fs.existsSync(path.join(project, INSTALL_MANIFEST))).toBe(false);
  });

  it("reads, lists, and removes an install left behind under the legacy manifest name", () => {
    const into = workspace();
    const plan = planInstall(loadBundle(bundle()), "cursor", { scope: "user", into });
    commitInstall(plan);
    const dest = plan.destination;

    // Rename in place, as an install written before the Cairn rename would be.
    fs.renameSync(path.join(dest, INSTALL_MANIFEST), path.join(dest, LEGACY_INSTALL_MANIFEST));

    const manifest = readInstallManifest(dest);
    expect(manifest).not.toBe("missing");
    expect(manifest).not.toBe("malformed");
    if (manifest === "missing" || manifest === "malformed") return;
    expect(manifest.bundle.name).toBe("hello");

    expect(listInstalled(["cursor"], { scope: "user", into }).map((entry) => entry.name)).toContain(
      "hello",
    );

    const removed = planUninstall("hello", "cursor", { scope: "user", into });
    commitUninstall(removed);
    expect(fs.existsSync(path.join(dest, LEGACY_INSTALL_MANIFEST))).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("refuses to guess when a destination holds both manifest names", () => {
    const into = workspace();
    const plan = planInstall(loadBundle(bundle()), "cursor", { scope: "user", into });
    commitInstall(plan);
    const dest = plan.destination;
    fs.copyFileSync(path.join(dest, INSTALL_MANIFEST), path.join(dest, LEGACY_INSTALL_MANIFEST));

    // Same rule as two matching scopes: picking one would silently orphan the
    // other install's recorded file list.
    expect(readInstallManifest(dest)).toBe("malformed");
  });

  it("materializes .install and symlinks the host path under --link", () => {
    const source = bundle();
    const into = workspace();
    const plan = planInstall(loadBundle(source), "cursor", { scope: "user", into, link: true });
    commitInstall(plan);
    expect(fs.lstatSync(plan.destination).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(plan.destination)).toBe(fs.realpathSync(plan.manifest.materialized!));
    expect(fs.existsSync(path.join(plan.destination, INSTALL_MANIFEST))).toBe(true);

    const removed = planUninstall("hello", "cursor", { scope: "user", into });
    commitUninstall(removed);
    expect(fs.existsSync(plan.destination)).toBe(false);
    expect(fs.existsSync(plan.manifest.materialized!)).toBe(false);
  });

  it("writes extraKnownMarketplaces under --register using the injected home", () => {
    const source = bundle();
    const home = workspace();
    const plan = planInstall(loadBundle(source), "claude-code", {
      scope: "user",
      home,
      register: true,
    });
    expect(plan.register).toBe(true);
    expect(codes(plan.diagnostics)).not.toContain("AB805");
    commitInstall(plan);
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"),
    ) as {
      extraKnownMarketplaces: Record<string, { source: { path: string } }>;
      enabledPlugins: Record<string, boolean>;
    };
    expect(settings.extraKnownMarketplaces.hello.source.path).toBe(plan.destination);
    expect(settings.enabledPlugins["hello@hello"]).toBe(true);

    const removed = planUninstall("hello", "claude-code", { scope: "user", home });
    commitUninstall(removed);
    const after = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
    expect(after.extraKnownMarketplaces.hello).toBeUndefined();
    expect(after.enabledPlugins["hello@hello"]).toBeUndefined();
  });

  it("lists installs found at a scanned root", () => {
    const source = bundle();
    const into = workspace();
    commitInstall(planInstall(loadBundle(source), "cursor", { scope: "user", into }));
    const listed = listInstalled(["cursor"], { scope: "user", into });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "hello", target: "cursor", scope: "user" });
  });

  it("skips ordinary files when scanning a plugin-dir root", () => {
    const into = workspace();
    fs.writeFileSync(path.join(into, "notes.md"), "not a plugin\n");
    expect(listInstalled(["cursor"], { scope: "user", into })).toEqual([]);
  });

  it("reports AB806 on a malformed manifest", () => {
    const into = workspace();
    const dest = path.join(into, "hello");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, INSTALL_MANIFEST), "{not json");
    const plan = planUninstall("hello", "cursor", { scope: "user", into });
    expect(codes(plan.diagnostics)).toContain("AB806");
    expect(plan.manifest).toBeNull();
  });
});

describe("installHasFindings", () => {
  it("ignores approximate and notice diagnostics unless --strict", () => {
    const approximate: AgentDiagnostic = {
      code: "AB330",
      severity: "warning",
      message: "approximate",
      quality: "approximate",
    };
    const notice: AgentDiagnostic = {
      code: "AB802",
      severity: "notice",
      message: "replacing",
      quality: "exact",
    };
    const warning: AgentDiagnostic = {
      code: "AB803",
      severity: "warning",
      message: "feature",
      quality: "unsupported",
    };
    const failure: AgentDiagnostic = {
      code: "AB801",
      severity: "error",
      message: "occupied",
      quality: "unsupported",
    };
    expect(installHasFindings([approximate, notice], false)).toBe(false);
    expect(installHasFindings([warning], false)).toBe(false);
    expect(installHasFindings([warning], true)).toBe(true);
    expect(installHasFindings([failure], false)).toBe(true);
  });
});

describe("missingInstallDiagnostic", () => {
  it("mints AB806", () => {
    expect(missingInstallDiagnostic("hello", "cursor", "/tmp/x").code).toBe("AB806");
  });
});
