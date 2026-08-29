import { describe, expect, it } from "vitest";
import { decode, int, num, path, str, sub, timestamp } from "../../src/usage/providers/protobuf.js";
import { pbBytes, pbInt, pbMessage, pbTimestamp } from "../helpers/antigravity-fixture.js";

/**
 * The reader exists because Antigravity ships protobuf with no schema, so these
 * cases pin the wire format itself rather than any particular message.
 */
describe("protobuf wire reader", () => {
  it("reads varint and length-delimited fields", () => {
    const fields = decode(pbMessage(pbInt(1, 300), pbBytes(2, "hello")));
    expect(int(fields, 1)).toBe(300);
    expect(str(fields, 2)).toBe("hello");
  });

  it("reads a nested message and follows a path into it", () => {
    const buffer = pbMessage(pbBytes(5, pbMessage(pbBytes(9, pbMessage(pbInt(3, 42))))));
    const fields = decode(buffer);
    expect(int(sub(sub(fields, 5)!, 9)!, 3)).toBe(42);
    expect(int(path(fields, 5, 9)!, 3)).toBe(42);
  });

  it("keeps repeated fields in order", () => {
    const fields = decode(pbMessage(pbBytes(20, "a"), pbBytes(20, "b")));
    expect(fields[20]).toHaveLength(2);
    expect(str(fields, 20)).toBe("a");
  });

  it("treats an absent field as zero, because protobuf omits zero scalars", () => {
    const fields = decode(pbMessage(pbInt(1, 7)));
    expect(num(fields, 2)).toBeUndefined();
    expect(int(fields, 2)).toBe(0);
    expect(str(fields, 2)).toBeUndefined();
    expect(sub(fields, 2)).toBeUndefined();
  });

  it("returns what it read rather than throwing on a truncated message", () => {
    // A length prefix that overruns the buffer: the tail is lost, the head is not.
    const good = pbMessage(pbInt(1, 5));
    const truncated = Buffer.concat([good, pbBytes(2, "abcdef").subarray(0, 3)]);
    const fields = decode(truncated);
    expect(int(fields, 1)).toBe(5);
    expect(fields[2]).toBeUndefined();
  });

  it("survives bytes that are not protobuf at all", () => {
    expect(() => decode(Buffer.from("not a protobuf message at all", "utf-8"))).not.toThrow();
    expect(decode(Buffer.alloc(0))).toEqual({});
  });

  it("reads a Timestamp, and refuses a zero one rather than reporting 1970", () => {
    const fields = decode(pbTimestamp(1, "2026-08-01T10:00:00.250Z"));
    expect(timestamp(sub(fields, 1))).toBe("2026-08-01T10:00:00.250Z");
    expect(timestamp(decode(pbMessage(pbInt(2, 0))))).toBeNull();
    expect(timestamp(undefined)).toBeNull();
  });
});
