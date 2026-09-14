import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);

interface CatalogEntry {
  name: string;
  version?: string;
  description?: string;
  source: string;
  author?: { name: string };
  category?: string;
  policy?: { installation: string; authentication: string };
  license?: string;
}

interface Catalog {
  name: string;
  description?: string;
  owner?: { name: string; url?: string };
  plugins: CatalogEntry[];
}
const cli = path.resolve("dist/cli.js");
const helpers = path.resolve("tests/helpers");
const temporary: string[] = [];

async function run(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runIn(undefined, ...args);
}

/** Runs the CLI with `HOME` pointed at a throwaway directory, so an install never
 *  touches the developer's real `~/.claude`. */
async function runIn(
  home: string | undefined,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = home
    ? {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        PATH: `${helpers}${path.delimiter}${process.env.PATH ?? ""}`,
      }
    : process.env;
  try {
    // Run from inside the sandbox home, not the repository. `agent installed`
    // and `agent uninstall` read the *project* scope as well as the user scope,
    // so with the repository as cwd they pick up whatever
    // `agent install --config cairn-verify.yml` last wrote there and report it
    // alongside — or ahead of — what the case installed. Every argument here is
    // an absolute path, so the cwd carries nothing else.
    const result = await exec("node", [cli, ...args], { env, ...(home ? { cwd: home } : {}) });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

function sandboxHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-marketplace-home-"));
  temporary.push(home);
  return home;
}

function settings(home: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
}

/** A collection root holding `count` minimal bundles plus a spec. */
function collection(
  spec: string,
  names: string[] = ["alpha", "beta"],
): { root: string; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-marketplace-e2e-"));
  temporary.push(root);
  for (const name of names) {
    const bundle = path.join(root, "plugins", name);
    fs.mkdirSync(path.join(bundle, "skills", name), { recursive: true });
    fs.writeFileSync(
      path.join(bundle, "agent-bundle.yaml"),
      `schemaVersion: "2"\nname: ${name}\nversion: 1.0.0\ndescription: The ${name} bundle\n` +
        `marketplace:\n  displayName: The ${name} plugin\n  publisher:\n    name: Test Owner\n` +
        `  license: MIT\n  categories: [demo]\n`,
    );
    fs.writeFileSync(
      path.join(bundle, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Do ${name} things.\n---\nDo ${name} things.\n`,
    );
  }
  fs.writeFileSync(path.join(root, "agent-marketplace.yaml"), spec);
  // Outside the collection, so the writer never competes with the sources.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-marketplace-out-"));
  temporary.push(out);
  fs.rmSync(out, { recursive: true, force: true });
  return { root, out };
}

const SPEC = `schemaVersion: "1"
name: demo
version: 2.1.0
description: A demo collection.
owner:
  name: Test Owner
  url: https://example.com
targets: [claude-code]
bundles:
  - path: plugins/alpha
  - path: plugins/beta
`;

const CODEX_SPEC = SPEC.replace("targets: [claude-code]", "targets: [codex]");

function catalog(out: string, target = "claude-code", dir = ".claude-plugin"): Catalog {
  return JSON.parse(fs.readFileSync(path.join(out, target, dir, "marketplace.json"), "utf8"));
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent marketplace", () => {
  it("aggregates every bundle into one catalog", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
    );
    expect(result.exitCode).toBe(0);

    const document = catalog(out);
    expect(document.name).toBe("demo");
    expect(document.owner).toEqual({ name: "Test Owner", url: "https://example.com" });
    expect(document.plugins.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
  });

  // The identity of a collection belongs to the collection. Sourcing it from a
  // bundle would name the marketplace after whichever one sorted first.
  it("takes catalog identity from the spec, not from any bundle", async () => {
    const { root, out } = collection(SPEC);
    await run("agent", "marketplace", path.join(root, "agent-marketplace.yaml"), "--output", out);
    const document = catalog(out);
    expect(document.name).not.toBe("alpha");
    expect(document.description).toBe("A demo collection.");
  });

  // Each entry still resolves per bundle from the target profile, so the
  // author-is-an-object and category-is-first-of-list transforms keep working.
  it("resolves entry fields per bundle from the target profile", async () => {
    const { root, out } = collection(SPEC);
    await run("agent", "marketplace", path.join(root, "agent-marketplace.yaml"), "--output", out);
    const [alpha] = catalog(out).plugins;
    expect(alpha).toMatchObject({
      name: "alpha",
      version: "1.0.0",
      description: "The alpha bundle",
      author: { name: "Test Owner" },
      category: "demo",
      license: "MIT",
    });
  });

  // Relative sources are what make a published tree portable: nothing in it
  // names an owner, a repo, or a branch.
  it("writes relative entry sources pointing at sibling plugin directories", async () => {
    const { root, out } = collection(SPEC);
    await run("agent", "marketplace", path.join(root, "agent-marketplace.yaml"), "--output", out);
    for (const entry of catalog(out).plugins) {
      expect(entry.source).toBe(`./${entry.name}`);
      expect(
        fs.existsSync(path.join(out, "claude-code", entry.name, ".claude-plugin/plugin.json")),
      ).toBe(true);
    }
  });

  // agent package writes a one-entry catalog inside each payload. A collection
  // must not: only the collection root carries one, or a host sees N competing
  // marketplaces where it was offered one.
  it("leaves no per-plugin catalog inside the payloads", async () => {
    const { root, out } = collection(SPEC);
    await run("agent", "marketplace", path.join(root, "agent-marketplace.yaml"), "--output", out);
    for (const name of ["alpha", "beta"])
      expect(
        fs.existsSync(path.join(out, "claude-code", name, ".claude-plugin/marketplace.json")),
      ).toBe(false);
  });

  it("emits collection-wide integrity files and a report", async () => {
    const { root, out } = collection(SPEC);
    await run("agent", "marketplace", path.join(root, "agent-marketplace.yaml"), "--output", out);
    for (const file of ["checksums.sha256", "sbom.json", "marketplace-report.json"])
      expect(fs.existsSync(path.join(out, file))).toBe(true);
    const sbom = JSON.parse(fs.readFileSync(path.join(out, "sbom.json"), "utf8"));
    expect(sbom.subject).toEqual({ name: "demo", version: "2.1.0" });
  });

  it("reports the collection in --format json", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "-fj",
    );
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("marketplace");
    expect(payload.marketplace.name).toBe("demo");
    expect(payload.marketplace.version).toBe("2.1.0");
    expect(payload.marketplace.targets[0].plugins).toHaveLength(2);
  });

  it("accepts a directory in place of the spec file", async () => {
    const { root, out } = collection(SPEC);
    const result = await run("agent", "marketplace", root, "--output", out);
    expect(result.exitCode).toBe(0);
  });
});

describe("agent marketplace per-target selection", () => {
  const MULTI = `schemaVersion: "1"
name: demo
version: 1.0.0
owner:
  name: Test Owner
targets: [claude-code, cursor]
bundles:
  - path: plugins/alpha
  - path: plugins/beta
    exclude: [cursor]
`;

  it("omits an excluded bundle from that target only", async () => {
    const { root, out } = collection(MULTI);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
    );
    expect(result.exitCode).toBe(0);
    expect(catalog(out).plugins.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(catalog(out, "cursor", ".cursor-plugin").plugins.map((e) => e.name)).toEqual(["alpha"]);
    expect(fs.existsSync(path.join(out, "cursor", "beta"))).toBe(false);
  });

  // An exclusion is the author saying so. Reporting it as a warning would block
  // --strict for a collection that is working exactly as declared.
  it("reports an exclusion as a notice that --strict tolerates", async () => {
    const { root, out } = collection(MULTI);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--strict",
      "-fj",
    );
    expect(result.exitCode).toBe(0);
    const codes = JSON.parse(result.stdout).diagnostics;
    const skipped = codes.find((item: { code: string }) => item.code === "AB907");
    expect(skipped.severity).toBe("notice");
  });

  it("narrows to a subset with --target", async () => {
    const { root, out } = collection(MULTI);
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--target",
      "claude-code",
    );
    expect(fs.existsSync(path.join(out, "claude-code"))).toBe(true);
    expect(fs.existsSync(path.join(out, "cursor"))).toBe(false);
  });

  // The spec is the record of what a collection is for; a flag that could add
  // to it would let CI publish a target the spec never declared.
  it("refuses a --target the spec does not declare", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--target",
      "codex",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("not declared");
  });

  it("warns when a target has no bundles left", async () => {
    const { root, out } = collection(
      `schemaVersion: "1"
name: demo
version: 1.0.0
owner:
  name: Test Owner
targets: [claude-code, cursor]
bundles:
  - path: plugins/alpha
    exclude: [cursor]
`,
      ["alpha"],
    );
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "-fj",
    );
    const codes = JSON.parse(result.stdout).diagnostics.map((d: { code: string }) => d.code);
    expect(codes).toContain("AB906");
  });

  // A command whose product is a catalog must say when it produced none.
  it("reports a target that declares no marketplace", async () => {
    const { root, out } = collection(
      `schemaVersion: "1"
name: demo
version: 1.0.0
owner:
  name: Test Owner
targets: [claude-code, opencode]
bundles:
  - path: plugins/alpha
`,
      ["alpha"],
    );
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "-fj",
    );
    const codes = JSON.parse(result.stdout).diagnostics.map((d: { code: string }) => d.code);
    expect(codes).toContain("AB507");
  });
});

describe("agent marketplace findings and modes", () => {
  it("forwards a per-bundle catalog error naming the bundle at fault", async () => {
    const { root, out } = collection(`schemaVersion: "1"
name: demo
version: 1.0.0
owner:
  name: Test Owner
targets: [codex]
bundles:
  - path: plugins/alpha
  - path: plugins/beta
`);
    for (const name of ["alpha", "beta"]) {
      const manifest = path.join(root, "plugins", name, "agent-bundle.yaml");
      fs.writeFileSync(
        manifest,
        fs.readFileSync(manifest, "utf8").replace("  categories: [demo]\n", ""),
      );
    }
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "-fj",
    );
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout);
    const missing = payload.diagnostics.filter((d: { code: string }) => d.code === "AB500");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((d: { path?: string }) => d.path?.endsWith("plugins/alpha"))).toBe(true);
    expect(missing.some((d: { path?: string }) => d.path?.endsWith("plugins/beta"))).toBe(true);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("reports a spec error without rendering", async () => {
    const { root, out } = collection(
      `schemaVersion: "9"
name: demo
version: 1.0.0
owner:
  name: Test Owner
targets: [claude-code]
bundles:
  - path: plugins/alpha
`,
      ["alpha"],
    );
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "-fj",
    );
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.diagnostics.map((d: { code: string }) => d.code)).toContain("AB900");
    expect(payload.artifacts).toEqual([]);
  });

  it("plans without writing under --dry-run", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--dry-run",
    );
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("reports current then stale under --check", async () => {
    const { root, out } = collection(SPEC);
    const spec = path.join(root, "agent-marketplace.yaml");
    await run("agent", "marketplace", spec, "--output", out);

    const current = await run("agent", "marketplace", spec, "--output", out, "--check", "-fj");
    expect(current.exitCode).toBe(0);
    expect(JSON.parse(current.stdout).stale).toBe(false);

    fs.appendFileSync(
      path.join(out, "claude-code", "alpha", "skills", "alpha", "SKILL.md"),
      "drift\n",
    );
    const stale = await run("agent", "marketplace", spec, "--output", out, "--check", "-fj");
    expect(stale.exitCode).toBe(2);
    expect(JSON.parse(stale.stdout).stale).toBe(true);
  });

  it("rejects --check with --dry-run", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--check",
      "--dry-run",
    );
    expect(result.exitCode).toBe(1);
  });

  it("rejects an unknown --marketplace mode", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--marketplace",
      "none",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("Unknown --marketplace");
  });

  // A bundle tree is a source the renderer reads; writing output into it would
  // make the next render read its own product.
  it("refuses an output directory inside a bundle", async () => {
    const { root } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      path.join(root, "plugins", "alpha", "out"),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("must not be inside a bundle");
  });

  // The spec directory is normally the repository root, which is exactly where
  // a build output belongs.
  it("allows an output directory beside the spec", async () => {
    const { root } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      path.join(root, "dist-plugins"),
    );
    expect(result.exitCode).toBe(0);
  });

  it("emits one archive per plugin under --archive", async () => {
    const { root, out } = collection(SPEC);
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--archive",
    );
    const archives = fs.readdirSync(path.join(out, "archives")).sort();
    expect(archives).toEqual([
      "alpha-1.0.0-claude-code-plugin.tar.gz",
      "beta-1.0.0-claude-code-plugin.tar.gz",
    ]);
  });
});

describe("agent marketplace --install", () => {
  // This is the whole reason the flag exists. `agent install --register` keys
  // extraKnownMarketplaces on the *bundle* name, so installing five bundles
  // gives five marketplaces; a collection registers one offering all of them.
  it("registers one marketplace enabling every plugin", async () => {
    const { root } = collection(SPEC);
    const home = sandboxHome();
    const result = await runIn(
      home,
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--install",
      "--register",
    );
    expect(result.exitCode).toBe(0);

    const written = settings(home);
    expect(Object.keys(written.extraKnownMarketplaces)).toEqual(["demo"]);
    expect(written.enabledPlugins).toEqual({ "alpha@demo": true, "beta@demo": true });
  });

  it("places the catalog and every plugin under one marketplace directory", async () => {
    const { root } = collection(SPEC);
    const home = sandboxHome();
    await runIn(
      home,
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--install",
      "--register",
    );

    const installed = path.join(home, ".claude", "plugins", "marketplaces", "demo");
    expect(fs.existsSync(path.join(installed, ".claude-plugin", "marketplace.json"))).toBe(true);
    for (const name of ["alpha", "beta"])
      expect(fs.existsSync(path.join(installed, name, ".claude-plugin", "plugin.json"))).toBe(true);

    const document = JSON.parse(
      fs.readFileSync(path.join(installed, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    // Sources stay relative to the catalog, which sits above the plugin
    // directories. Rewriting them to "./" is only correct when a catalog shares
    // a directory with the single plugin it describes.
    expect(document.plugins.map((entry: CatalogEntry) => entry.source)).toEqual([
      "./alpha",
      "./beta",
    ]);
  });

  it("records a collection manifest that uninstall and installed both read", async () => {
    const { root } = collection(SPEC);
    const home = sandboxHome();
    const spec = path.join(root, "agent-marketplace.yaml");
    await runIn(home, "agent", "marketplace", spec, "--install", "--register");

    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(home, ".claude", "plugins", "marketplaces", "demo", ".cairn-install.json"),
        "utf8",
      ),
    );
    expect(manifest.kind).toBe("collection");
    expect(manifest.bundle).toEqual({ name: "demo", version: "2.1.0" });
    expect(manifest.collection.plugins).toEqual([
      { name: "alpha", version: "1.0.0" },
      { name: "beta", version: "1.0.0" },
    ]);
    expect(manifest.registration.pluginKeys).toEqual(["alpha@demo", "beta@demo"]);

    const listed = await runIn(home, "agent", "installed", "--target", "claude-code", "-fj");
    expect(JSON.parse(listed.stdout).install.installs[0].name).toBe("demo");
  });

  it("reverses the whole registration on uninstall", async () => {
    const { root } = collection(SPEC);
    const home = sandboxHome();
    await runIn(
      home,
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--install",
      "--register",
    );
    const removed = await runIn(home, "agent", "uninstall", "demo", "--target", "claude-code");
    expect(removed.exitCode).toBe(0);

    const written = settings(home);
    expect(written.extraKnownMarketplaces).toEqual({});
    expect(written.enabledPlugins).toEqual({});
    expect(fs.existsSync(path.join(home, ".claude", "plugins", "marketplaces", "demo"))).toBe(
      false,
    );
  });

  // --register stays the only flag that changes host activation, matching agent install.
  it("installs without --register and reports the edit as AB805", async () => {
    const { root } = collection(SPEC);
    const home = sandboxHome();
    const result = await runIn(
      home,
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--install",
      "-fj",
    );
    expect(result.exitCode).toBe(0);
    const codes = JSON.parse(result.stdout).diagnostics.map((d: { code: string }) => d.code);
    expect(codes).toContain("AB805");
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "plugins", "marketplaces", "demo"))).toBe(true);
  });

  it("reports current then stale under --install --check", async () => {
    const { root } = collection(SPEC);
    const home = sandboxHome();
    const spec = path.join(root, "agent-marketplace.yaml");
    await runIn(home, "agent", "marketplace", spec, "--install", "--register");

    const current = await runIn(
      home,
      "agent",
      "marketplace",
      spec,
      "--install",
      "--register",
      "--check",
      "-fj",
    );
    expect(JSON.parse(current.stdout).stale).toBe(false);

    fs.rmSync(path.join(home, ".claude", "plugins", "marketplaces", "demo", "beta"), {
      recursive: true,
      force: true,
    });
    const stale = await runIn(
      home,
      "agent",
      "marketplace",
      spec,
      "--install",
      "--register",
      "--check",
      "-fj",
    );
    expect(stale.exitCode).toBe(2);
    expect(JSON.parse(stale.stdout).stale).toBe(true);
  });

  it("builds a tree and installs in one invocation", async () => {
    const { root, out } = collection(SPEC);
    const home = sandboxHome();
    const result = await runIn(
      home,
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--install",
      "--register",
    );
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(out, "claude-code", ".claude-plugin", "marketplace.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(home, ".claude", "plugins", "marketplaces", "demo"))).toBe(true);
  });

  it("requires --output unless --install is given", async () => {
    const { root } = collection(SPEC);
    const result = await run("agent", "marketplace", path.join(root, "agent-marketplace.yaml"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("--output is required");
  });

  it.each(["--scope", "--into"])("rejects %s without --install", async (flag) => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      flag,
      "user",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("applies only with --install");
  });
});

describe("agent marketplace --install for Codex", () => {
  function codexState(home: string): {
    marketplaces: Record<string, string>;
    plugins: Record<string, { enabled: boolean; version: string }>;
  } {
    return JSON.parse(fs.readFileSync(path.join(home, ".codex", "fake-plugin-state.json"), "utf8"));
  }

  it("installs and enables a user-scoped collection through the Codex CLI", async () => {
    const { root } = collection(CODEX_SPEC);
    const home = sandboxHome();
    const spec = path.join(root, "agent-marketplace.yaml");
    const result = await runIn(home, "agent", "marketplace", spec, "--install", "--register");
    expect(result.exitCode).toBe(0);

    const installed = path.join(home, ".codex", "marketplaces", "demo");
    expect(fs.existsSync(path.join(installed, ".agents", "plugins", "marketplace.json"))).toBe(
      true,
    );
    const catalog = JSON.parse(
      fs.readFileSync(path.join(installed, ".agents", "plugins", "marketplace.json"), "utf8"),
    ) as Catalog;
    expect(catalog.name).toBe("demo");
    expect(catalog.plugins).toEqual([
      {
        name: "alpha",
        source: "./alpha",
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "demo",
      },
      {
        name: "beta",
        source: "./beta",
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "demo",
      },
    ]);

    const state = codexState(home);
    expect(state.marketplaces.demo).toBe(fs.realpathSync(installed));
    expect(Object.keys(state.plugins).sort()).toEqual(["alpha@demo", "beta@demo"]);
    expect(state.plugins["alpha@demo"]).toMatchObject({ enabled: true, version: "1.0.0" });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(installed, ".cairn-install.json"), "utf8"),
    );
    expect(manifest.registration).toEqual({
      form: "codex-plugin-cli",
      command: "codex",
      marketplaceKey: "demo",
      pluginKeys: ["alpha@demo", "beta@demo"],
    });
  });

  it("checks Codex marketplace, enabled state, and installed version", async () => {
    const { root } = collection(CODEX_SPEC);
    const home = sandboxHome();
    const spec = path.join(root, "agent-marketplace.yaml");
    await runIn(home, "agent", "marketplace", spec, "--install", "--register");

    const current = await runIn(
      home,
      "agent",
      "marketplace",
      spec,
      "--install",
      "--register",
      "--check",
      "-fj",
    );
    expect(current.exitCode).toBe(0);
    expect(JSON.parse(current.stdout).stale).toBe(false);

    const state = codexState(home);
    state.plugins["alpha@demo"].enabled = false;
    fs.writeFileSync(
      path.join(home, ".codex", "fake-plugin-state.json"),
      JSON.stringify(state, null, 2) + "\n",
    );
    const stale = await runIn(
      home,
      "agent",
      "marketplace",
      spec,
      "--install",
      "--register",
      "--check",
      "-fj",
    );
    expect(stale.exitCode).toBe(2);
    expect(JSON.parse(stale.stdout).stale).toBe(true);
  });

  it("removes plugins before the marketplace and then deletes the managed tree", async () => {
    const { root } = collection(CODEX_SPEC);
    const home = sandboxHome();
    const log = path.join(home, "codex.log");
    const previous = process.env.CAIRN_FAKE_CODEX_LOG;
    process.env.CAIRN_FAKE_CODEX_LOG = log;
    try {
      await runIn(
        home,
        "agent",
        "marketplace",
        path.join(root, "agent-marketplace.yaml"),
        "--install",
        "--register",
      );
      fs.writeFileSync(log, "");
      const removed = await runIn(home, "agent", "uninstall", "demo", "--target", "codex");
      expect(removed.exitCode).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CAIRN_FAKE_CODEX_LOG;
      else process.env.CAIRN_FAKE_CODEX_LOG = previous;
    }
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const removals = calls.filter(
      (call) => call[1] === "remove" || (call[1] === "marketplace" && call[2] === "remove"),
    );
    expect(removals.map((call) => call.slice(0, 4))).toEqual([
      ["plugin", "remove", "alpha@demo", "--json"],
      ["plugin", "remove", "beta@demo", "--json"],
      ["plugin", "marketplace", "remove", "demo"],
    ]);
    expect(fs.existsSync(path.join(home, ".codex", "marketplaces", "demo"))).toBe(false);
  });

  it("refuses a same-named marketplace at another root before writing", async () => {
    const { root } = collection(CODEX_SPEC);
    const home = sandboxHome();
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "fake-plugin-state.json"),
      JSON.stringify({ marketplaces: { demo: "/somewhere/else" }, plugins: {} }),
    );
    const result = await runIn(
      home,
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--install",
      "--register",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("refusing to replace it");
    expect(fs.existsSync(path.join(codexHome, "marketplaces", "demo"))).toBe(false);
  });

  it("leaves a same-named marketplace at another root untouched on uninstall", async () => {
    const { root } = collection(CODEX_SPEC);
    const home = sandboxHome();
    await runIn(
      home,
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--install",
      "--register",
    );
    const state = codexState(home);
    state.marketplaces.demo = "/somewhere/else";
    fs.writeFileSync(
      path.join(home, ".codex", "fake-plugin-state.json"),
      JSON.stringify(state, null, 2) + "\n",
    );

    const removed = await runIn(home, "agent", "uninstall", "demo", "--target", "codex");
    expect(removed.exitCode).toBe(0);
    const after = codexState(home);
    expect(after.marketplaces.demo).toBe("/somewhere/else");
    expect(Object.keys(after.plugins).sort()).toEqual(["alpha@demo", "beta@demo"]);
  });

  it("rolls back newly added Codex state when a plugin add fails", async () => {
    const { root } = collection(CODEX_SPEC);
    const home = sandboxHome();
    const previous = process.env.CAIRN_FAKE_CODEX_FAIL_ADD;
    process.env.CAIRN_FAKE_CODEX_FAIL_ADD = "beta@demo";
    let result: Awaited<ReturnType<typeof runIn>>;
    try {
      result = await runIn(
        home,
        "agent",
        "marketplace",
        path.join(root, "agent-marketplace.yaml"),
        "--install",
        "--register",
      );
    } finally {
      if (previous === undefined) delete process.env.CAIRN_FAKE_CODEX_FAIL_ADD;
      else process.env.CAIRN_FAKE_CODEX_FAIL_ADD = previous;
    }
    expect(result!.exitCode).toBe(1);
    const state = codexState(home);
    expect(state.marketplaces).toEqual({});
    expect(state.plugins).toEqual({});
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(home, ".codex", "marketplaces", "demo", ".cairn-install.json"),
        "utf8",
      ),
    );
    expect(manifest.registration).toBeUndefined();
  });

  it("does not invoke Codex during a registered dry run", async () => {
    const { root } = collection(CODEX_SPEC);
    const home = sandboxHome();
    const log = path.join(home, "codex.log");
    const previous = process.env.CAIRN_FAKE_CODEX_LOG;
    process.env.CAIRN_FAKE_CODEX_LOG = log;
    try {
      const result = await runIn(
        home,
        "agent",
        "marketplace",
        path.join(root, "agent-marketplace.yaml"),
        "--install",
        "--register",
        "--dry-run",
      );
      expect(result.exitCode).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CAIRN_FAKE_CODEX_LOG;
      else process.env.CAIRN_FAKE_CODEX_LOG = previous;
    }
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "marketplaces", "demo"))).toBe(false);
  });
});

/**
 * A collection whose bundles reach outside themselves, which is the case the
 * release layout exists to serve and the one cairn's own bundles never exercise:
 * none of the eight declares a `resourceRoots` at all.
 *
 * `shared/` deliberately holds one file nobody references, so a test can prove
 * the publisher ships what is reached for rather than the whole directory.
 */
function collectionWithResources(): { root: string; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-marketplace-res-"));
  temporary.push(root);

  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared", "used.md"), "# Used\n");
  fs.writeFileSync(path.join(root, "shared", "unused.md"), "# Unused\n");

  const bundle = path.join(root, "bundles", "alpha");
  fs.mkdirSync(path.join(bundle, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "agent-bundle.yaml"),
    `schemaVersion: "2"\nname: alpha\nversion: 0.0.0-development\ndescription: The alpha bundle\n` +
      `marketplace:\n  displayName: Alpha\n  publisher:\n    name: Test Owner\n` +
      `  license: MIT\n  categories: [demo]\nresourceRoots:\n  - ../../shared\n`,
  );
  fs.writeFileSync(
    path.join(bundle, "skills", "alpha", "SKILL.md"),
    `---\nname: alpha\ndescription: Do alpha things.\nresources:\n` +
      `  - path: ../../../../shared/used.md\n    as: reference/used.md\n---\nDo alpha things.\n`,
  );

  fs.writeFileSync(
    path.join(root, "agent-marketplace.yaml"),
    `schemaVersion: "1"\nname: demo\nversion: 2.1.0\ndescription: A demo collection.\n` +
      `owner:\n  name: Test Owner\ntargets: [claude-code]\nbundles:\n  - path: bundles/alpha\n`,
  );

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-marketplace-out-"));
  temporary.push(out);
  fs.rmSync(out, { recursive: true, force: true });
  return { root, out };
}

interface ReleaseManifest {
  schemaVersion: string;
  marketplace: string;
  version: string;
  sourceCommit: string | null;
  generator: { name: string; version: string };
  targets: Record<
    string,
    { catalog: string | null; root: string | null; activation: string | null }
  >;
  bundles: Array<{
    name: string;
    version: string;
    source: string;
    sourceSha256: string;
    targets: Record<string, { path: string; sha256: string }>;
  }>;
}

function manifest(out: string): ReleaseManifest {
  return JSON.parse(fs.readFileSync(path.join(out, "release-manifest.json"), "utf8"));
}

describe("agent marketplace --layout release", () => {
  // The whole point of the layout: every host looks for its catalog at the
  // repository root and nowhere else, so one branch can serve all of them only
  // if the catalogs are hoisted out of their target directories.
  it("hoists every catalog to the root and points entries into the target tree", async () => {
    const { root, out } = collection(
      SPEC.replace("targets: [claude-code]", "targets: [claude-code, cursor]"),
    );
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
    );
    expect(result.exitCode).toBe(0);

    const claude: Catalog = JSON.parse(
      fs.readFileSync(path.join(out, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    const cursor: Catalog = JSON.parse(
      fs.readFileSync(path.join(out, ".cursor-plugin", "marketplace.json"), "utf8"),
    );
    expect(claude.plugins.map((entry) => entry.source)).toEqual([
      "./claude-code/alpha",
      "./claude-code/beta",
    ]);
    expect(cursor.plugins.map((entry) => entry.source)).toEqual([
      "./cursor/alpha",
      "./cursor/beta",
    ]);
    expect(fs.existsSync(path.join(out, "claude-code", ".claude-plugin"))).toBe(false);
  });

  // Publishing the sources is what makes the branch installable for a host that
  // has no marketplace concept at all — `agent install` renders from a bundle.
  it("publishes the source bundles", async () => {
    const { root, out } = collection(SPEC);
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
    );
    expect(fs.existsSync(path.join(out, "bundles", "alpha", "agent-bundle.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(out, "bundles", "beta", "skills", "beta", "SKILL.md"))).toBe(
      true,
    );
  });

  it("does not publish the sources under the nested layout", async () => {
    const { root, out } = collection(SPEC);
    await run("agent", "marketplace", path.join(root, "agent-marketplace.yaml"), "--output", out);
    expect(fs.existsSync(path.join(out, "bundles"))).toBe(false);
  });

  // A catalog advertising one version while the published source carries another
  // installs one thing and describes another, so the stamp has to reach the
  // rendered manifests as well as the source.
  it("stamps the catalog, the rendered manifest and the published source alike", async () => {
    const { root, out } = collectionWithResources();
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--stamp-version",
      "9.1.0",
      "--output",
      out,
    );
    expect(result.exitCode).toBe(0);

    const document: Catalog = JSON.parse(
      fs.readFileSync(path.join(out, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    expect(document.plugins[0]?.version).toBe("9.1.0");

    const rendered = JSON.parse(
      fs.readFileSync(
        path.join(out, "claude-code", "alpha", ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(rendered.version).toBe("9.1.0");

    const source = fs.readFileSync(path.join(out, "bundles", "alpha", "agent-bundle.yaml"), "utf8");
    expect(source).toContain("version: 9.1.0");
    expect(source).not.toContain("0.0.0-development");
    expect(manifest(out).bundles[0]?.version).toBe("9.1.0");
  });

  // Without a stamp the sentinel would reach the branch, where it would install
  // and advertise a version that was never released.
  it("refuses to publish the version sentinel", async () => {
    const { root, out } = collectionWithResources();
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("AB908");
  });

  // Only what is reached for: publishing a whole shared directory would put
  // unrelated files on a branch people clone for plugins.
  it("publishes referenced resources at their own depth and nothing else", async () => {
    const { root, out } = collectionWithResources();
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--stamp-version",
      "9.1.0",
      "--output",
      out,
    );
    expect(fs.existsSync(path.join(out, "shared", "used.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, "shared", "unused.md"))).toBe(false);
  });

  // The proof that the depth arithmetic holds: the published bundle still
  // resolves `../../shared` and renders the resource it reaches for.
  it("publishes a source bundle that still renders", async () => {
    const { root, out } = collectionWithResources();
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--stamp-version",
      "9.1.0",
      "--output",
      out,
    );

    const rendered = fs.mkdtempSync(path.join(os.tmpdir(), "agent-marketplace-render-"));
    temporary.push(rendered);
    fs.rmSync(rendered, { recursive: true, force: true });
    const result = await run(
      "agent",
      "convert",
      path.join(out, "bundles", "alpha"),
      "--target",
      "claude-code",
      "--profile",
      "plugin",
      "--output",
      rendered,
    );
    expect(result.exitCode).toBe(0);
    expect(
      fs.existsSync(
        path.join(rendered, "claude-code", "plugin", "skills", "alpha", "reference", "used.md"),
      ),
    ).toBe(true);
  });

  it("records the targets, their catalogs and their activation in the manifest", async () => {
    const { root, out } = collection(
      SPEC.replace("targets: [claude-code]", "targets: [claude-code, cursor]"),
    );
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
      "--source-commit",
      "abc1234",
    );

    const document = manifest(out);
    expect(document.schemaVersion).toBe("1");
    expect(document.marketplace).toBe("demo");
    expect(document.sourceCommit).toBe("abc1234");
    expect(document.targets["claude-code"]).toEqual({
      catalog: ".claude-plugin/marketplace.json",
      root: "claude-code",
      activation: "settings",
    });
    // Cursor auto-scans its plugin directory, so it has a catalog and no
    // activation — which is why a consumer cannot infer one from the other.
    expect(document.targets["cursor"]?.activation).toBeNull();
    expect(document.bundles.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(Object.keys(document.bundles[0]?.targets ?? {})).toEqual(["claude-code", "cursor"]);
    expect(document.bundles[0]?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // A bundle excluded for a target must be absent from that target everywhere,
  // or a consumer driving installs off the manifest would install it anyway.
  it("omits an excluded target from the bundle's manifest entry", async () => {
    const { root, out } = collection(
      `${SPEC.replace("targets: [claude-code]", "targets: [claude-code, cursor]").replace(
        "  - path: plugins/beta\n",
        "  - path: plugins/beta\n    include: [claude-code]\n",
      )}`,
    );
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
    );

    const beta = manifest(out).bundles.find((entry) => entry.name === "beta");
    expect(Object.keys(beta?.targets ?? {})).toEqual(["claude-code"]);
    const cursor: Catalog = JSON.parse(
      fs.readFileSync(path.join(out, ".cursor-plugin", "marketplace.json"), "utf8"),
    );
    expect(cursor.plugins.map((entry) => entry.name)).toEqual(["alpha"]);
  });

  // `--install` strips a `<target>/` prefix to find the host marketplace
  // directory, which the hoisted layout does not have.
  it("refuses --install", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
      "--install",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--layout release cannot be combined with --install");
  });

  // The landing page of the branch. Generated here so that every repository
  // publishing one does not write the same generator.
  it("generates a README naming both the marketplace and the from-source route", async () => {
    const { root, out } = collection(
      SPEC.replace("targets: [claude-code]", "targets: [claude-code, antigravity]"),
    );
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
      "--readme",
      "acme/widgets",
    );

    const readme = fs.readFileSync(path.join(out, "README.md"), "utf8");
    expect(readme).toContain("# demo — release 2.1.0");
    expect(readme).toContain("/plugin marketplace add git@github.com:acme/widgets.git#release");
    expect(readme).toContain("/plugin install alpha@demo");
    // Antigravity declares no catalog, so its section is the from-source route.
    expect(readme).toContain("--target antigravity");
    expect(readme).toContain("#release-v2.1.0");
  });

  it("writes no README unless asked", async () => {
    const { root, out } = collection(SPEC);
    await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--layout",
      "release",
      "--output",
      out,
    );
    expect(fs.existsSync(path.join(out, "README.md"))).toBe(false);
  });

  it("refuses --stamp-version outside the release layout", async () => {
    const { root, out } = collection(SPEC);
    const result = await run(
      "agent",
      "marketplace",
      path.join(root, "agent-marketplace.yaml"),
      "--output",
      out,
      "--stamp-version",
      "9.1.0",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--stamp-version applies only with --layout release");
  });
});
