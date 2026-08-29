import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  changesSince,
  readAtRevision,
  repositoryFor,
  repositoryRelative,
  resolveCommit,
  worktreePath,
} from "../../src/git.js";

let tmpDir: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", tmpDir, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function write(name: string, content: string): void {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  // Deliberately NOT realpath'd: on macOS os.tmpdir() is a symlink, and the
  // symlink-vs-real path mismatch is exactly what repositoryRelative must
  // survive. Resolving it here would hide the bug this guards.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-git-"));
  git("init", "-q", "-b", "main");
  write("a.md", "# A\nfirst\n");
  write("docs/b.md", "# B\n");
  write("notes.txt", "not markdown\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("repositoryFor", () => {
  it("resolves the toplevel and rejects a non-repository", () => {
    const repository = repositoryFor(tmpDir);
    expect(repository.root).toBe(fs.realpathSync(tmpDir));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-nogit-"));
    try {
      // A bare mkdtemp may still sit inside an enclosing repository on some
      // machines, so only assert the failure shape when it genuinely is not.
      let inRepository = true;
      try {
        execFileSync("git", ["-C", outside, "rev-parse", "--show-toplevel"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        inRepository = false;
      }
      if (!inRepository) {
        expect(() => repositoryFor(outside)).toThrow(/Not inside a Git repository/);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("repositoryRelative", () => {
  it("survives a symlinked workspace root", () => {
    const repository = repositoryFor(tmpDir);
    expect(repositoryRelative(repository, path.join(tmpDir, "docs", "b.md"))).toBe("docs/b.md");
    // Round-trips back to an absolute worktree path.
    expect(worktreePath(repository, "docs/b.md")).toBe(
      path.join(fs.realpathSync(tmpDir), "docs", "b.md"),
    );
  });

  it("resolves a path that no longer exists in the worktree", () => {
    const repository = repositoryFor(tmpDir);
    fs.rmSync(path.join(tmpDir, "a.md"));
    expect(repositoryRelative(repository, path.join(tmpDir, "a.md"))).toBe("a.md");
  });
});

describe("readAtRevision", () => {
  it("reads content as it was at a revision", () => {
    const repository = repositoryFor(tmpDir);
    write("a.md", "# A\nsecond\n");
    expect(readAtRevision(repository, "HEAD", "a.md")).toBe("# A\nfirst\n");
  });

  it("returns undefined for a path absent at that revision", () => {
    const repository = repositoryFor(tmpDir);
    expect(readAtRevision(repository, "HEAD", "new.md")).toBeUndefined();
  });

  it("throws on an unknown revision rather than reporting it as absent", () => {
    // Reporting a typo'd revision as "everything is new" is the worst failure
    // mode this function has, so the absent-path check must stay narrow.
    const repository = repositoryFor(tmpDir);
    expect(() => readAtRevision(repository, "no-such-ref", "a.md")).toThrow(
      /Unable to read revision no-such-ref/,
    );
  });
});

describe("resolveCommit", () => {
  it("resolves a revision to a commit sha", () => {
    const repository = repositoryFor(tmpDir);
    expect(resolveCommit(repository, "HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(() => resolveCommit(repository, "no-such-ref")).toThrow(/Unable to read revision/);
  });
});

describe("changesSince", () => {
  it("reports modifications, additions, deletions, and untracked files", () => {
    const repository = repositoryFor(tmpDir);
    write("a.md", "# A\nsecond\n");
    fs.rmSync(path.join(tmpDir, "docs", "b.md"));
    write("added.md", "# Added\n");
    git("add", "-A");
    write("untracked.md", "# Untracked\n");

    expect(changesSince(repository, "HEAD")).toEqual([
      { status: "M", oldPath: "a.md", newPath: "a.md" },
      { status: "A", newPath: "added.md" },
      { status: "D", oldPath: "docs/b.md" },
      { status: "A", newPath: "untracked.md" },
    ]);
  });

  it("detects a rename and carries the similarity index", () => {
    const repository = repositoryFor(tmpDir);
    git("mv", "a.md", "renamed.md");

    const changes = changesSince(repository, "HEAD");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: "R", oldPath: "a.md", newPath: "renamed.md" });
    expect(changes[0].similarity).toBe(100);
  });

  it("ignores files that are not Markdown", () => {
    const repository = repositoryFor(tmpDir);
    write("notes.txt", "changed\n");
    write("image.png", "x\n");
    expect(changesSince(repository, "HEAD")).toEqual([]);
  });

  it("accepts both .md and .markdown", () => {
    const repository = repositoryFor(tmpDir);
    write("long.markdown", "# Long\n");
    expect(changesSince(repository, "HEAD").map((change) => change.newPath)).toEqual([
      "long.markdown",
    ]);
  });
});
