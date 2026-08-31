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
  installKey,
  planInstall,
  planInstalls,
  planUninstall,
  readInstallDocument,
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
    expect(plan.record.materialized).toMatch(/[/\\]\.install[/\\]cursor[/\\]plugin$/);
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
    const document = readInstallDocument(dest);
    expect(document).not.toBe("missing");
    expect(document).not.toBe("malformed");
    if (document === "missing" || document === "malformed") return;
    expect(document.installs).toHaveLength(1);
    const manifest = document.installs[0];
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

    const document = readInstallDocument(dest);
    expect(document).not.toBe("missing");
    expect(document).not.toBe("malformed");
    if (document === "missing" || document === "malformed") return;
    expect(document.installs[0].bundle.name).toBe("hello");

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
    expect(readInstallDocument(dest)).toBe("malformed");
  });

  it("materializes .install and symlinks the host path under --link", () => {
    const source = bundle();
    const into = workspace();
    const plan = planInstall(loadBundle(source), "cursor", { scope: "user", into, link: true });
    commitInstall(plan);
    expect(fs.lstatSync(plan.destination).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(plan.destination)).toBe(fs.realpathSync(plan.record.materialized!));
    expect(fs.existsSync(path.join(plan.destination, INSTALL_MANIFEST))).toBe(true);

    const removed = planUninstall("hello", "cursor", { scope: "user", into });
    commitUninstall(removed);
    expect(fs.existsSync(plan.destination)).toBe(false);
    expect(fs.existsSync(plan.record.materialized!)).toBe(false);
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

describe("a destination holding several installs", () => {
  function named(name: string): string {
    const root = bundle();
    fs.writeFileSync(
      path.join(root, "agent-bundle.yaml"),
      `schemaVersion: '2'\nname: ${name}\nversion: 1.0.0\ndescription: ${name}\n`,
    );
    return root;
  }

  it("keeps a second target's install from deleting the first", () => {
    // The bug this whole change exists for: both targets resolve project scope
    // to the same merge root, and the second install pruned the first's files
    // as "stale" because the manifest was keyed on the bundle name alone.
    const source = bundle();
    const project = workspace();
    const first = planInstall(loadBundle(source), "claude-code", {
      scope: "project",
      into: project,
    });
    commitInstall(first);
    const firstFiles = first.record.files.map((file) => file.path);
    expect(firstFiles.length).toBeGreaterThan(0);

    const second = planInstall(loadBundle(source), "codex", { scope: "project", into: project });
    expect(codes(second.diagnostics)).not.toContain("AB801");
    expect(codes(second.diagnostics)).not.toContain("AB808");
    commitInstall(second);

    for (const file of firstFiles) expect(fs.existsSync(path.join(project, file)), file).toBe(true);
    for (const file of second.record.files)
      expect(fs.existsSync(path.join(project, file.path)), file.path).toBe(true);

    const document = readInstallDocument(project);
    expect(document).not.toBe("malformed");
    if (document === "missing" || document === "malformed") return;
    expect(document.installs).toHaveLength(2);
    expect(document.installs.map((record) => record.target).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(
      listInstalled(["claude-code", "codex"], { scope: "project", into: project }),
    ).toHaveLength(2);
  });

  it("accepts two different bundles in one merge root", () => {
    const project = workspace();
    const first = planInstall(loadBundle(named("alpha")), "claude-code", {
      scope: "project",
      into: project,
    });
    commitInstall(first);
    // Previously AB801, purely because a different bundle was already recorded.
    const second = planInstall(loadBundle(named("beta")), "claude-code", {
      scope: "project",
      into: project,
    });
    expect(codes(second.diagnostics)).not.toContain("AB801");
    commitInstall(second);
    for (const file of first.record.files)
      expect(fs.existsSync(path.join(project, file.path)), file.path).toBe(true);
    const document = readInstallDocument(project);
    if (document === "missing" || document === "malformed") throw new Error("no document");
    expect(document.installs.map((record) => record.bundle.name)).toEqual(["alpha", "beta"]);
  });

  it("prunes only its own stale files when reinstalled beside a sibling", () => {
    const project = workspace();
    const source = bundle();
    commitInstall(planInstall(loadBundle(source), "codex", { scope: "project", into: project }));
    const sibling = planInstall(loadBundle(source), "claude-code", {
      scope: "project",
      into: project,
    });
    commitInstall(sibling);

    // Drop a skill, reinstall claude-code: its own file goes, codex's stay.
    const stale = sibling.record.files.map((file) => file.path);
    fs.rmSync(path.join(source, "skills", "greet"), { recursive: true });
    fs.mkdirSync(path.join(source, "skills", "wave"), { recursive: true });
    fs.writeFileSync(
      path.join(source, "skills", "wave", "SKILL.md"),
      "---\nname: wave\ndescription: Wave\n---\n\nWave.\n",
    );
    const again = planInstall(loadBundle(source), "claude-code", {
      scope: "project",
      into: project,
    });
    commitInstall(again);

    const kept = new Set(again.record.files.map((file) => file.path));
    for (const file of stale)
      if (!kept.has(file)) expect(fs.existsSync(path.join(project, file)), file).toBe(false);
    const document = readInstallDocument(project);
    if (document === "missing" || document === "malformed") throw new Error("no document");
    const codex = document.installs.find((record) => record.target === "codex");
    expect(codex).toBeDefined();
    for (const file of codex?.files ?? [])
      expect(fs.existsSync(path.join(project, file.path)), file.path).toBe(true);
  });

  it("uninstalls one record and leaves the other in place", () => {
    const project = workspace();
    const source = bundle();
    const first = planInstall(loadBundle(source), "claude-code", {
      scope: "project",
      into: project,
    });
    commitInstall(first);
    commitInstall(planInstall(loadBundle(source), "codex", { scope: "project", into: project }));

    const removed = planUninstall("hello", "codex", { scope: "project", into: project });
    expect(removed.manifest?.target).toBe("codex");
    commitUninstall(removed);

    for (const file of first.record.files)
      expect(fs.existsSync(path.join(project, file.path)), file.path).toBe(true);
    const document = readInstallDocument(project);
    if (document === "missing" || document === "malformed") throw new Error("no document");
    expect(document.installs).toHaveLength(1);
    expect(document.installs[0].target).toBe("claude-code");
  });

  it("deletes the manifest when the last record is removed", () => {
    const project = workspace();
    const source = bundle();
    commitInstall(
      planInstall(loadBundle(source), "claude-code", { scope: "project", into: project }),
    );
    commitInstall(planInstall(loadBundle(source), "codex", { scope: "project", into: project }));
    for (const target of ["claude-code", "codex"] as const)
      commitUninstall(planUninstall("hello", target, { scope: "project", into: project }));
    expect(fs.existsSync(path.join(project, INSTALL_MANIFEST))).toBe(false);
  });

  it("migrates a legacy-named manifest when records remain", () => {
    const project = workspace();
    const source = bundle();
    commitInstall(
      planInstall(loadBundle(source), "claude-code", { scope: "project", into: project }),
    );
    commitInstall(planInstall(loadBundle(source), "codex", { scope: "project", into: project }));
    fs.renameSync(
      path.join(project, INSTALL_MANIFEST),
      path.join(project, LEGACY_INSTALL_MANIFEST),
    );
    commitUninstall(planUninstall("hello", "codex", { scope: "project", into: project }));
    // Leaving the legacy file beside the rewritten one would read as malformed.
    expect(fs.existsSync(path.join(project, LEGACY_INSTALL_MANIFEST))).toBe(false);
    expect(fs.existsSync(path.join(project, INSTALL_MANIFEST))).toBe(true);
  });

  it("writes the legacy shape at one record and the installs shape at two", () => {
    const project = workspace();
    const source = bundle();
    commitInstall(
      planInstall(loadBundle(source), "claude-code", { scope: "project", into: project }),
    );
    const single = JSON.parse(
      fs.readFileSync(path.join(project, INSTALL_MANIFEST), "utf8"),
    ) as Record<string, unknown>;
    // An older cairn keeps reading this, which is the whole reason for the rule.
    expect(single.bundle).toBeDefined();
    expect(single.installs).toBeUndefined();

    commitInstall(planInstall(loadBundle(source), "codex", { scope: "project", into: project }));
    const many = JSON.parse(
      fs.readFileSync(path.join(project, INSTALL_MANIFEST), "utf8"),
    ) as Record<string, unknown>;
    expect(many.bundle).toBeUndefined();
    expect(Array.isArray(many.installs)).toBe(true);
  });

  it("reads a document with both shapes as malformed", () => {
    const project = workspace();
    fs.writeFileSync(
      path.join(project, INSTALL_MANIFEST),
      JSON.stringify({
        generator: { name: "x", version: "1" },
        bundle: { name: "a", version: "1.0.0" },
        installs: [],
      }),
    );
    expect(readInstallDocument(project)).toBe("malformed");
  });

  it("reads a document with one unparseable entry as malformed", () => {
    const project = workspace();
    fs.writeFileSync(
      path.join(project, INSTALL_MANIFEST),
      JSON.stringify({
        generator: { name: "x", version: "1" },
        installs: [
          {
            bundle: { name: "a", version: "1.0.0" },
            target: "codex",
            profile: "project",
            scope: "project",
            layout: "merge",
            mode: "copy",
            destination: project,
            files: [],
          },
          { bundle: { name: "b" } },
        ],
      }),
    );
    // Partial trust would make the dropped entry's files look unowned, which is
    // exactly the destruction the multi-record shape exists to prevent.
    expect(readInstallDocument(project)).toBe("malformed");
  });

  it("reports drift when a record is missing from the manifest", () => {
    const project = workspace();
    const source = bundle();
    const plan = planInstall(loadBundle(source), "claude-code", {
      scope: "project",
      into: project,
    });
    commitInstall(plan);
    expect(installIsCurrent(plan)).toBe(true);
    fs.writeFileSync(
      path.join(project, INSTALL_MANIFEST),
      JSON.stringify({ generator: { name: "x", version: "1" }, installs: [] }),
    );
    // The files are still there; the record is not. Reporting "current" would
    // disagree with uninstall, which would report nothing to remove.
    expect(installIsCurrent(plan)).toBe(false);
  });

  it("orders records by byte comparison of the install key, not by input order", () => {
    const project = workspace();
    const source = bundle();
    commitInstall(planInstall(loadBundle(source), "codex", { scope: "project", into: project }));
    commitInstall(
      planInstall(loadBundle(source), "claude-code", { scope: "project", into: project }),
    );
    const document = readInstallDocument(project);
    if (document === "missing" || document === "malformed") throw new Error("no document");
    const keys = document.installs.map((record) => installKey(record));
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("planInstalls", () => {
  /**
   * Antigravity and Codex both declare `.agents/skills/<name>/`, and the
   * conditional block makes the two renders of that one path differ — which is
   * what turns a shared path into a conflict rather than co-ownership.
   */
  function divergent(): string {
    const root = bundle();
    fs.writeFileSync(
      path.join(root, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Say hello\n---\n\n<!-- target:codex -->\nCodex only.\n<!-- /target:codex -->\n",
    );
    return root;
  }

  it("reports AB808 when two installs in one run claim the same path", () => {
    const source = divergent();
    const project = workspace();
    const loaded = loadBundle(source);
    const batch = planInstalls(
      [
        { bundle: loaded, target: "antigravity" },
        { bundle: loaded, target: "codex" },
      ],
      { scope: "project", into: project },
    );
    expect(codes(batch.diagnostics)).toContain("AB808");
  });

  it("does not let --force suppress an in-run conflict", () => {
    // --force means "overwrite what is there"; it cannot make one run write two
    // byte streams to one path, and suppressing it would make the outcome
    // depend on commit order.
    const source = divergent();
    const project = workspace();
    const loaded = loadBundle(source);
    const batch = planInstalls(
      [
        { bundle: loaded, target: "antigravity" },
        { bundle: loaded, target: "codex" },
      ],
      { scope: "project", into: project, force: true },
    );
    expect(codes(batch.diagnostics)).toContain("AB808");
  });

  it("reports AB808 against an install already at the destination", () => {
    const source = divergent();
    const project = workspace();
    commitInstall(
      planInstall(loadBundle(source), "antigravity", { scope: "project", into: project }),
    );
    const clashing = planInstall(loadBundle(source), "codex", { scope: "project", into: project });
    expect(codes(clashing.diagnostics)).toContain("AB808");
    const forced = planInstall(loadBundle(source), "codex", {
      scope: "project",
      into: project,
      force: true,
    });
    expect(codes(forced.diagnostics)).not.toContain("AB808");
  });

  it("treats a byte-identical shared path as co-ownership, not a conflict", () => {
    // A bundle's assets land at the destination root for every target, so
    // without this rule the common case would be an error.
    const source = bundle();
    const project = workspace();
    const loaded = loadBundle(source);
    const batch = planInstalls(
      [
        { bundle: loaded, target: "antigravity" },
        { bundle: loaded, target: "codex" },
      ],
      { scope: "project", into: project },
    );
    expect(codes(batch.diagnostics)).not.toContain("AB808");
    for (const plan of batch.plans) commitInstall(plan);

    const shared = ".agents/skills/greet/SKILL.md";
    const document = readInstallDocument(project);
    if (document === "missing" || document === "malformed") throw new Error("no document");
    expect(
      document.installs.filter((record) => record.files.some((file) => file.path === shared)),
    ).toHaveLength(2);

    // Removing one owner leaves the file for the other.
    commitUninstall(planUninstall("hello", "codex", { scope: "project", into: project }));
    expect(fs.existsSync(path.join(project, shared))).toBe(true);
  });

  it("gives every plan in a destination group the same document", () => {
    const source = bundle();
    const project = workspace();
    const loaded = loadBundle(source);
    const batch = planInstalls(
      [
        { bundle: loaded, target: "claude-code" },
        { bundle: loaded, target: "cursor" },
      ],
      { scope: "project", into: project },
    );
    expect(batch.diagnostics).toHaveLength(0);
    expect(batch.plans).toHaveLength(2);
    const manifests = batch.plans.map((plan) =>
      plan.artifacts.find((artifact) => artifact.path === INSTALL_MANIFEST)?.content.toString(),
    );
    expect(manifests[0]).toBe(manifests[1]);
  });

  it("returns plans in request order", () => {
    const source = bundle();
    const project = workspace();
    const loaded = loadBundle(source);
    const batch = planInstalls(
      [
        { bundle: loaded, target: "cursor" },
        { bundle: loaded, target: "claude-code" },
      ],
      { scope: "project", into: project },
    );
    expect(batch.plans.map((plan) => plan.target)).toEqual(["cursor", "claude-code"]);
  });

  it("commits in either order to the same tree", () => {
    const source = bundle();
    const loaded = loadBundle(source);
    const forward = workspace();
    const reverse = workspace();
    for (const [root, order] of [
      [forward, ["claude-code", "cursor"]],
      [reverse, ["cursor", "claude-code"]],
    ] as const) {
      const batch = planInstalls(
        order.map((target) => ({ bundle: loaded, target })),
        { scope: "project", into: root },
      );
      for (const plan of batch.plans) commitInstall(plan);
    }
    const listing = (root: string): string[] =>
      fs.readdirSync(root, { recursive: true }).map(String).sort();
    expect(listing(forward)).toEqual(listing(reverse));
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
