import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { tarball } from "../../src/agent/package/tar.js";
import { listMembers, readMember, TarFormatError } from "../../src/archive/tar-read.js";
import {
  extractBlob,
  hashBuffer,
  memberPath,
  readSegment,
  sealSegment,
  SegmentWriter,
} from "../../src/archive/segments.js";

/**
 * The archive's storage layer.
 *
 * Every case here pins something the archive's usefulness rests on: that a
 * segment is a real `.tar.gz` anything can open, that the offsets the index
 * stores actually locate their members, and that a corrupted segment is caught
 * rather than returned.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-segments-"));
  temporary.push(root);
  return root;
}

function blob(content: string | Buffer, mode = 0o644) {
  const buffer = typeof content === "string" ? Buffer.from(content) : content;
  return { sha256: hashBuffer(buffer), content: buffer, mode };
}

describe("the ustar reader", () => {
  it("round-trips everything the writer emits", () => {
    const entries = [
      { path: "blobs/aa/one", content: Buffer.from("hello"), mode: 0o644 },
      // Spans several blocks, and is not a multiple of 512.
      { path: "blobs/bb/two", content: Buffer.alloc(1500, 7), mode: 0o644 },
      // Empty, which has a header and no data blocks at all.
      { path: "blobs/cc/three", content: Buffer.alloc(0), mode: 0o755 },
    ];
    const tar = tarball(entries);
    const members = listMembers(tar).filter((member) => !member.directory);
    expect(members.map((member) => member.path)).toEqual([
      "blobs/aa/one",
      "blobs/bb/two",
      "blobs/cc/three",
    ]);
    for (const entry of entries) {
      const member = members.find((candidate) => candidate.path === entry.path)!;
      expect(member.size).toBe(entry.content.length);
      expect(readMember(tar, member).equals(entry.content)).toBe(true);
    }
  });

  it("lists the directory entries the writer emits, so `tar tf` shows a whole tree", () => {
    const tar = tarball([{ path: "blobs/aa/one", content: Buffer.from("x"), mode: 0o644 }]);
    const directories = listMembers(tar).filter((member) => member.directory);
    expect(directories.map((member) => member.path)).toEqual(["blobs", "blobs/aa"]);
  });

  it("refuses a header it does not understand rather than guessing", () => {
    const tar = tarball([{ path: "blobs/aa/one", content: Buffer.from("x"), mode: 0o644 }]);
    // Break the ustar magic on the first header.
    tar.write("xxxxx\0", 257, 6, "utf8");
    expect(() => listMembers(tar)).toThrow(TarFormatError);
  });
});

describe("segments", () => {
  it("stores each blob under its own hash and records where it landed", () => {
    const directory = scratch();
    const blobs = [blob("first"), blob("second"), blob(Buffer.alloc(3000, 1))];
    const segment = sealSegment(directory, 1, blobs);

    expect(segment.name).toBe("seg-000001.tar.gz");
    expect(segment.blobs).toHaveLength(3);
    expect(fs.existsSync(path.join(directory, segment.name))).toBe(true);
    // The segment's own hash is what `archive verify` checks.
    expect(hashBuffer(fs.readFileSync(path.join(directory, segment.name)))).toBe(segment.sha256);

    const uncompressed = readSegment(directory, segment.name);
    for (const stored of segment.blobs) {
      const source = blobs.find((candidate) => candidate.sha256 === stored.sha256)!;
      expect(extractBlob(uncompressed, stored).equals(source.content)).toBe(true);
    }
  });

  it("is a plain gzip anything can open, with member names that are their own hash", () => {
    const directory = scratch();
    const one = blob("recoverable without cairn");
    const segment = sealSegment(directory, 1, [one]);

    // No cairn code in this path: gunzip, then find the member by name.
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(directory, segment.name)));
    const member = listMembers(raw).find((candidate) => candidate.path === memberPath(one.sha256));
    expect(member).toBeDefined();
    expect(hashBuffer(readMember(raw, member!))).toBe(one.sha256);
  });

  it("is byte-identical across runs, so a segment does not depend on the machine", () => {
    const a = scratch();
    const b = scratch();
    const blobs = [blob("one"), blob("two")];
    const first = sealSegment(a, 1, blobs);
    const second = sealSegment(b, 1, blobs);
    expect(first.sha256).toBe(second.sha256);
    expect(
      fs.readFileSync(path.join(a, first.name)).equals(fs.readFileSync(path.join(b, second.name))),
    ).toBe(true);
  });

  it("reports corruption instead of returning the wrong bytes", () => {
    const directory = scratch();
    const one = blob("original content");
    const segment = sealSegment(directory, 1, [one]);
    const uncompressed = readSegment(directory, segment.name);

    // Overwrite the member's data in place, leaving the index's offset intact.
    uncompressed.write("tampered content", segment.blobs[0].offset, "utf8");
    expect(() => extractBlob(uncompressed, segment.blobs[0])).toThrow(/corruption/i);
  });

  it("seals only when the threshold is reached, and the caller decides when", () => {
    const directory = scratch();
    // Sealing is not a side effect of `add`: index rows can only be written once
    // the segment has an id, so the caller has to know exactly when it happened.
    const writer = new SegmentWriter(directory, 1, 100);
    writer.add(blob(Buffer.alloc(40)));
    expect(writer.shouldSeal).toBe(false);
    writer.add(blob(Buffer.alloc(80)));
    expect(writer.shouldSeal).toBe(true);
    expect(writer.sealed).toHaveLength(0);

    writer.flush();
    expect(writer.sealed).toHaveLength(1);
    expect(writer.shouldSeal).toBe(false);

    // Sequence numbers keep climbing, so a later run never overwrites a segment.
    writer.add(blob("later"));
    writer.flush();
    expect(writer.sealed.map((segment) => segment.name)).toEqual([
      "seg-000001.tar.gz",
      "seg-000002.tar.gz",
    ]);
  });

  it("gives a blob larger than the threshold a segment of its own", () => {
    const directory = scratch();
    const writer = new SegmentWriter(directory, 1, 100);
    writer.add(blob(Buffer.alloc(500, 3)));
    // Never split: a member spanning two archives could not be read by `tar`.
    expect(writer.shouldSeal).toBe(true);
    const segment = writer.flush()!;
    expect(segment.blobs).toHaveLength(1);
    expect(segment.blobs[0].size).toBe(500);
  });

  it("flushes to nothing when there is nothing buffered", () => {
    expect(new SegmentWriter(scratch(), 1).flush()).toBeNull();
  });
});
