import { describe, expect, it } from "vitest";
import { sanitizeName } from "../../src/pdf/attachments.js";

/**
 * The name sanitizer, on its own.
 *
 * An embedded file's stored name is attacker-controlled, and this is the
 * function standing between it and a write. pdf.js already strips the directory
 * before we see it, which is exactly why this is tested against raw input
 * rather than against what pdf.js happens to hand over today: the guarantee has
 * to be ours, not a behavior of a dependency that could change in a minor bump.
 */

describe("sanitizeName", () => {
  it("keeps an ordinary name", () => {
    expect(sanitizeName("data.csv")).toBe("data.csv");
    expect(sanitizeName("Quarterly Report 2026.xlsx")).toBe("Quarterly Report 2026.xlsx");
  });

  it("keeps a dotfile, which is a real name rather than a traversal", () => {
    expect(sanitizeName(".gitignore")).toBe(".gitignore");
  });

  it("reduces a traversing path to its basename", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeName("/etc/passwd")).toBe("passwd");
    expect(sanitizeName("a/b/c/d.txt")).toBe("d.txt");
  });

  it("treats a backslash as a separator too", () => {
    // A Windows-authored name keeps its backslashes on a POSIX host, where
    // path.basename would not treat them as separators at all.
    expect(sanitizeName("..\\..\\windows\\system32\\evil.dll")).toBe("evil.dll");
    expect(sanitizeName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
  });

  it("refuses a drive-relative name that survives the split", () => {
    expect(sanitizeName("C:evil.txt")).toBeNull();
  });

  it("refuses a name that is only traversal, whitespace, or nothing", () => {
    for (const candidate of ["", "   ", ".", "..", "../..", "/", "\\", "./"])
      expect(sanitizeName(candidate), candidate).toBeNull();
  });

  it("strips NUL rather than writing it into a path", () => {
    expect(sanitizeName("data\0.csv")).toBe("data.csv");
    expect(sanitizeName("\0")).toBeNull();
  });

  it("never returns a value carrying a separator", () => {
    // The property the extractor relies on: whatever comes back can be joined
    // onto the target directory without being able to leave it.
    for (const candidate of [
      "../../etc/passwd",
      "..\\..\\evil",
      "/absolute/path",
      "nested/dir/file.bin",
      "mixed\\slash/name.txt",
    ]) {
      const safe = sanitizeName(candidate);
      if (safe === null) continue;
      expect(safe, candidate).not.toContain("/");
      expect(safe, candidate).not.toContain("\\");
      expect(safe, candidate).not.toBe("..");
    }
  });
});

describe("sanitizeName, platform hazards", () => {
  it("refuses a Windows device name on every platform", () => {
    // Not writable as a file on Windows whatever extension follows. Refused
    // everywhere so an extraction behaves the same on every host rather than
    // only failing on the one that cares.
    for (const candidate of ["CON", "con.txt", "NUL", "aux.csv", "COM1", "LPT9.dat"])
      expect(sanitizeName(candidate), candidate).toBeNull();
  });

  it("keeps a name that merely starts with a device prefix", () => {
    expect(sanitizeName("console.log")).toBe("console.log");
    expect(sanitizeName("nullable.json")).toBe("nullable.json");
    expect(sanitizeName("com10.txt")).toBe("com10.txt");
  });
});
