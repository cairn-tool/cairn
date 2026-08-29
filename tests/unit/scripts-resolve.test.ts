import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listScripts, resolveScript, shadowingFailure } from "../../src/scripts/resolve.js";

let root: string;

beforeEach(() => {
  // Realpathed because /tmp is a symlink on macOS and the walk resolves both
  // sides of every containment check.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-scripts-")));
  execFileSync("git", ["init", "-q", root]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, body: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

function directory(relative: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

const SCRIPT = (name: string, body: string) =>
  `version: 1\nscripts:\n  ${name}:\n    run: ${body}\n`;

describe("script resolution", () => {
  it("resolves a name declared three levels up", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    const deep = directory("a/b/c");
    const resolution = resolveScript("build", { cwd: deep });
    expect(resolution.winner?.registry.directory).toBe(root);
    expect(resolution.winner?.workingDirectory).toBe(root);
    expect(resolution.boundary.kind).toBe("git-root");
  });

  it("does not let a nested file without the name shadow an ancestor", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    write("pkg/.cairn.yml", SCRIPT("other", "echo other"));
    const resolution = resolveScript("build", { cwd: directory("pkg") });
    expect(resolution.winner?.registry.file).toBe(path.join(root, ".cairn.yml"));
    // The nested file was still opened, and reports that it declares something.
    expect(resolution.consulted[0].status).toBe("declares");
    expect(resolution.consulted[0].names).toEqual(["other"]);
  });

  it("lets the nearest definition win and records what it shadows", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    write("pkg/.cairn.yml", SCRIPT("build", "echo nested"));
    const resolution = resolveScript("build", { cwd: directory("pkg") });
    expect(resolution.winner?.registry.file).toBe(path.join(root, "pkg", ".cairn.yml"));
    expect(resolution.shadowed.map((entry) => entry.file)).toEqual([path.join(root, ".cairn.yml")]);
  });

  it("stops at the git root", () => {
    // An inner repository bounds the walk at itself, so the outer repository's
    // registry — a real ancestor on disk — is never consulted.
    write(".cairn.yml", SCRIPT("build", "echo outer"));
    const inner = directory("inner");
    execFileSync("git", ["init", "-q", inner]);
    write("inner/.cairn.yml", SCRIPT("other", "echo other"));

    const resolution = resolveScript("build", { cwd: inner });
    expect(resolution.boundary.directory).toBe(inner);
    expect(resolution.winner).toBeUndefined();
    expect(resolution.consulted.map((file) => file.file)).toEqual([path.join(inner, ".cairn.yml")]);
  });

  it("takes the deeper of --root and the git root", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    write("pkg/.cairn.yml", SCRIPT("other", "echo other"));
    const resolution = resolveScript("build", {
      cwd: directory("pkg"),
      root: path.join(root, "pkg"),
    });
    expect(resolution.boundary.kind).toBe("explicit-root");
    // The repository-root definition is above the boundary, so it is invisible.
    expect(resolution.winner).toBeUndefined();
  });

  it("rejects a --root that is not an ancestor", () => {
    const sibling = directory("sibling");
    expect(() => resolveScript("build", { cwd: directory("pkg"), root: sibling })).toThrow(
      "--root is not an ancestor of the working directory",
    );
  });

  it("skips a registry under node_modules", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    write("node_modules/evil/.cairn.yml", SCRIPT("build", "echo pwned"));
    const resolution = resolveScript("build", { cwd: directory("node_modules/evil") });
    expect(resolution.winner?.registry.file).toBe(path.join(root, ".cairn.yml"));
  });

  it("reports an unreadable ancestor without throwing, and flags only a shadowing one", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    write("pkg/.cairn.yml", "scripts:\n  build:\n    run: [unclosed\n");
    const nearer = resolveScript("build", { cwd: directory("pkg") });
    expect(nearer.consulted[0].status).toBe("invalid");
    expect(shadowingFailure(nearer)).toBeDefined();

    // The same broken file farther away than the winner cannot change the answer.
    write("pkg/deep/.cairn.yml", SCRIPT("build", "echo deep"));
    const farther = resolveScript("build", { cwd: directory("pkg/deep") });
    expect(farther.winner?.registry.file).toBe(path.join(root, "pkg", "deep", ".cairn.yml"));
    expect(shadowingFailure(farther)).toBeUndefined();
  });

  it("skips a registry that symlinks outside the boundary", () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-evil.yml`);
    fs.writeFileSync(outside, SCRIPT("build", "echo pwned"));
    try {
      fs.symlinkSync(outside, path.join(root, ".cairn.yml"));
      const resolution = resolveScript("build", { cwd: root });
      expect(resolution.winner).toBeUndefined();
      expect(resolution.consulted[0].status).toBe("skipped");
      expect(resolution.consulted[0].reason).toBe("Resolves outside the boundary");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("rejects a cwd that escapes the boundary", () => {
    write(".cairn.yml", "version: 1\nscripts:\n  build:\n    run: pwd\n    cwd: ../..\n");
    expect(() => resolveScript("build", { cwd: root })).toThrow(
      "resolves a working directory outside the boundary",
    );
  });

  it("resolves cwd: invocation to the caller's directory", () => {
    write(".cairn.yml", "version: 1\nscripts:\n  here:\n    run: pwd\n    cwd: invocation\n");
    const deep = directory("a/b");
    expect(resolveScript("here", { cwd: deep }).winner?.workingDirectory).toBe(deep);
  });

  it("lists with nearest-wins applied and records shadowed files", () => {
    write(
      ".cairn.yml",
      "version: 1\nscripts:\n  build:\n    run: echo root\n  only-root:\n    run: echo x\n",
    );
    write("pkg/.cairn.yml", SCRIPT("build", "echo nested"));
    const listing = listScripts({ cwd: directory("pkg") });
    expect(listing.scripts.map((entry) => entry.name)).toEqual(["build", "only-root"]);
    const build = listing.scripts.find((entry) => entry.name === "build")!;
    expect(build.file).toBe(path.join(root, "pkg", ".cairn.yml"));
    expect(build.shadows).toEqual([path.join(root, ".cairn.yml")]);
  });

  it("consults nothing when discovery is disabled", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    const resolution = resolveScript("build", { cwd: root, selection: { disabled: true } });
    expect(resolution.consulted).toEqual([]);
    expect(resolution.winner).toBeUndefined();
  });

  it("reads only the explicit file when --config pins one", () => {
    write(".cairn.yml", SCRIPT("build", "echo root"));
    const pinned = write("other/pinned.yml", SCRIPT("build", "echo pinned"));
    const resolution = resolveScript("build", {
      cwd: root,
      selection: { disabled: false, explicitPath: pinned },
    });
    expect(resolution.consulted).toHaveLength(1);
    expect(resolution.winner?.registry.file).toBe(pinned);
  });
});
