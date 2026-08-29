/**
 * A minimal protobuf wire-format reader.
 *
 * Antigravity stores its per-request token usage as unencrypted protobuf blobs
 * inside SQLite columns, and ships no `.proto` — so the field *numbers* are all
 * there is to go on. A protobuf dependency would buy nothing here: there is no
 * schema to compile against, and the wire format itself is four cases.
 *
 * Reading is deliberately total rather than strict: an unknown wire type stops
 * the scan and returns what was read so far, because a partial decode that the
 * caller can validate is more useful than an exception from a format nobody
 * published. Every consumer must treat a missing field as absent, never assume.
 */

/** Decoded fields, keyed by field number. Protobuf allows repeats, hence arrays. */
export type ProtoFields = Record<number, ProtoValue[]>;

export type ProtoValue = number | Buffer;

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

/** Bounds the scan so a corrupt length prefix cannot spin. */
const MAX_FIELDS = 4096;

interface Cursor {
  offset: number;
}

function readVarint(buffer: Buffer, cursor: Cursor): number {
  let result = 0n;
  let shift = 0n;
  while (cursor.offset < buffer.length) {
    const byte = buffer[cursor.offset++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    // A varint longer than 10 bytes is malformed; stop rather than loop.
    if (shift > 63n) break;
  }
  return Number(result);
}

/** Decodes one message into its fields. Never throws. */
export function decode(buffer: Buffer): ProtoFields {
  const fields: ProtoFields = {};
  const cursor: Cursor = { offset: 0 };
  let seen = 0;

  while (cursor.offset < buffer.length && seen++ < MAX_FIELDS) {
    const tag = readVarint(buffer, cursor);
    const field = tag >> 3;
    const wire = tag & 0x07;
    if (field === 0) break;

    let value: ProtoValue;
    switch (wire) {
      case VARINT:
        value = readVarint(buffer, cursor);
        break;
      case LENGTH: {
        const length = readVarint(buffer, cursor);
        if (length < 0 || cursor.offset + length > buffer.length) return fields;
        value = buffer.subarray(cursor.offset, cursor.offset + length);
        cursor.offset += length;
        break;
      }
      case FIXED32:
        if (cursor.offset + 4 > buffer.length) return fields;
        value = buffer.readUInt32LE(cursor.offset);
        cursor.offset += 4;
        break;
      case FIXED64:
        if (cursor.offset + 8 > buffer.length) return fields;
        value = Number(buffer.readBigUInt64LE(cursor.offset));
        cursor.offset += 8;
        break;
      default:
        // Groups (3 and 4) are deprecated and absent here; anything else is a
        // desync. Return what was read rather than guessing at a resync point.
        return fields;
    }
    (fields[field] ??= []).push(value);
  }
  return fields;
}

/** The first value of a field as a number, or undefined when absent or not one. */
export function num(fields: ProtoFields, field: number): number | undefined {
  const value = fields[field]?.[0];
  return typeof value === "number" ? value : undefined;
}

/** A numeric field, defaulting to 0 — protobuf omits zero-valued scalars. */
export function int(fields: ProtoFields, field: number): number {
  return num(fields, field) ?? 0;
}

/** The first value of a field as a UTF-8 string, or undefined. */
export function str(fields: ProtoFields, field: number): string | undefined {
  const value = fields[field]?.[0];
  return Buffer.isBuffer(value) ? value.toString("utf-8") : undefined;
}

/** The first value of a field decoded as a nested message, or undefined. */
export function sub(fields: ProtoFields, field: number): ProtoFields | undefined {
  const value = fields[field]?.[0];
  return Buffer.isBuffer(value) ? decode(value) : undefined;
}

/** Follows a chain of nested message fields, e.g. `path(root, 5, 9)`. */
export function path(fields: ProtoFields, ...route: number[]): ProtoFields | undefined {
  let current: ProtoFields | undefined = fields;
  for (const field of route) {
    if (!current) return undefined;
    current = sub(current, field);
  }
  return current;
}

/**
 * A `google.protobuf.Timestamp` as an ISO instant.
 *
 * Field 1 is seconds since the epoch, field 2 nanoseconds. Returns null for a
 * zero or implausible value so a missing timestamp cannot become 1970.
 */
export function timestamp(fields: ProtoFields | undefined): string | null {
  if (!fields) return null;
  const seconds = int(fields, 1);
  if (seconds <= 0) return null;
  const millis = seconds * 1000 + Math.floor(int(fields, 2) / 1_000_000);
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
