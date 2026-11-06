import crypto from "node:crypto";
import { isDict, isName, isString } from "./syntax.js";
import type { Decryptor, PdfDict, PdfObject } from "./syntax.js";

/**
 * The standard security handler, for the empty user password only.
 *
 * This is the same reach pdf.js has here: the toolset takes no password, so a
 * document that needs one is refused before the object layer runs (AP010). What
 * remains is the common case of a document "encrypted" with an empty user
 * password to carry permission flags, which every viewer opens silently. Its
 * streams are still enciphered on disk, so reading an image's original bytes
 * means deciphering them.
 *
 * Revisions 2–4 (RC4 and AES-128) and 5–6 (AES-256) are covered. RC4 is written
 * out rather than taken from `node:crypto`, because OpenSSL 3 moved it to the
 * legacy provider and it is absent from a default Node build.
 */

const PADDING = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);

export class UnsupportedEncryption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEncryption";
  }
}

type Method = "none" | "rc4" | "aes128" | "aes256";

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) state[index] = index;
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 0xff;
    [state[index], state[j]] = [state[j], state[index]];
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    out[index] = data[index] ^ state[(state[i] + state[j]) & 0xff];
  }
  return out;
}

function aesDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32 || data.length % 16 !== 0) return new Uint8Array(0);
  const algorithm = key.length === 32 ? "aes-256-cbc" : "aes-128-cbc";
  const decipher = crypto.createDecipheriv(algorithm, key, data.subarray(0, 16));
  decipher.setAutoPadding(true);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]));
  } catch {
    // Bad padding: return what deciphered rather than nothing.
    const fallback = crypto.createDecipheriv(algorithm, key, data.subarray(0, 16));
    fallback.setAutoPadding(false);
    return new Uint8Array(Buffer.concat([fallback.update(data.subarray(16)), fallback.final()]));
  }
}

function bytesOf(value: PdfObject | undefined): Buffer {
  return isString(value) ? Buffer.from(value.bytes) : Buffer.alloc(0);
}

function numberOf(value: PdfObject | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** Algorithm 2.B: the iterated hash revision 6 uses. */
function hash6(password: Buffer, salt: Buffer, userKey: Buffer): Buffer {
  let k = crypto
    .createHash("sha256")
    .update(Buffer.concat([password, salt, userKey]))
    .digest();
  for (let round = 0; ; round += 1) {
    const unit = Buffer.concat([password, k, userKey]);
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => unit));
    const cipher = crypto.createCipheriv("aes-128-cbc", k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);
    let sum = 0;
    for (let index = 0; index < 16; index += 1) sum += e[index];
    const algorithm = ["sha256", "sha384", "sha512"][sum % 3];
    k = crypto.createHash(algorithm).update(e).digest();
    if (round >= 63 && e[e.length - 1] <= round - 32) break;
  }
  return k.subarray(0, 32);
}

/**
 * Builds a decryptor from the trailer's `/Encrypt` dictionary and `/ID`.
 *
 * Throws {@link UnsupportedEncryption} for a non-standard handler; returns a
 * decryptor that may produce garbage when the user password is not empty, which
 * surfaces downstream as an undecodable stream rather than a wrong image.
 */
export function standardDecryptor(
  encrypt: PdfDict,
  id: PdfObject | undefined,
  resolve: (value: PdfObject) => PdfObject,
): Decryptor & { stream(bytes: Uint8Array, num: number, gen: number): Uint8Array } {
  const get = (key: string): PdfObject | undefined => {
    const value = encrypt.map.get(key);
    return value === undefined ? undefined : resolve(value);
  };
  const handler = get("Filter");
  if (!isName(handler, "Standard"))
    throw new UnsupportedEncryption(
      `The ${isName(handler) ? handler.name : "unknown"} security handler is not supported`,
    );
  const v = numberOf(get("V"), 0);
  const r = numberOf(get("R"), 2);
  const owner = bytesOf(get("O"));
  const user = bytesOf(get("U"));
  const permissions = numberOf(get("P"), 0);
  const encryptMetadata = get("EncryptMetadata") !== false;

  let stringMethod: Method = "rc4";
  let streamMethod: Method = "rc4";
  let lengthBits = numberOf(get("Length"), 40);
  if (v >= 4) {
    const filters = get("CF");
    const methodOf = (filterName: PdfObject | undefined): Method => {
      if (!isName(filterName) || filterName.name === "Identity") return "none";
      const entry = isDict(filters) ? resolve(filters.map.get(filterName.name) ?? null) : null;
      const cfm = isDict(entry) ? resolve(entry.map.get("CFM") ?? null) : null;
      if (isDict(entry))
        lengthBits = numberOf(resolve(entry.map.get("Length") ?? null), lengthBits);
      if (isName(cfm, "AESV2")) return "aes128";
      if (isName(cfm, "AESV3")) return "aes256";
      if (isName(cfm, "V2")) return "rc4";
      return "none";
    };
    streamMethod = methodOf(get("StmF"));
    stringMethod = methodOf(get("StrF"));
  }
  // /Length in a crypt filter is sometimes given in bytes rather than bits.
  if (lengthBits <= 32) lengthBits *= 8;

  let fileKey: Buffer;
  if (r >= 5) {
    const password = Buffer.alloc(0);
    const userKeySalt = user.subarray(40, 48);
    const intermediate =
      r === 5
        ? crypto
            .createHash("sha256")
            .update(Buffer.concat([password, userKeySalt]))
            .digest()
        : hash6(password, userKeySalt, Buffer.alloc(0));
    const ue = bytesOf(get("UE"));
    const decipher = crypto.createDecipheriv("aes-256-cbc", intermediate, Buffer.alloc(16));
    decipher.setAutoPadding(false);
    fileKey = Buffer.concat([decipher.update(ue.subarray(0, 32)), decipher.final()]);
  } else {
    const keyBytes = r === 2 ? 5 : Math.max(5, Math.min(16, lengthBits >> 3));
    const firstId =
      Array.isArray(id) && isString(id[0]) ? Buffer.from(id[0].bytes) : Buffer.alloc(0);
    const p = Buffer.alloc(4);
    p.writeInt32LE(permissions | 0);
    const md5 = crypto.createHash("md5");
    md5.update(PADDING);
    md5.update(owner.subarray(0, 32));
    md5.update(p);
    md5.update(firstId);
    if (r >= 4 && !encryptMetadata) md5.update(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    let digest = md5.digest();
    if (r >= 3)
      for (let round = 0; round < 50; round += 1)
        digest = crypto.createHash("md5").update(digest.subarray(0, keyBytes)).digest();
    fileKey = digest.subarray(0, keyBytes);
  }

  const objectKey = (num: number, gen: number, aes: boolean): Uint8Array => {
    const extra = Buffer.from([
      num & 0xff,
      (num >> 8) & 0xff,
      (num >> 16) & 0xff,
      gen & 0xff,
      (gen >> 8) & 0xff,
    ]);
    const md5 = crypto.createHash("md5").update(fileKey).update(extra);
    if (aes) md5.update(Buffer.from("sAlT", "latin1"));
    return md5.digest().subarray(0, Math.min(fileKey.length + 5, 16));
  };

  const apply = (method: Method, bytes: Uint8Array, num: number, gen: number): Uint8Array => {
    switch (method) {
      case "none":
        return bytes;
      case "rc4":
        return rc4(objectKey(num, gen, false), bytes);
      case "aes128":
        return aesDecrypt(objectKey(num, gen, true), bytes);
      case "aes256":
        return aesDecrypt(fileKey, bytes);
    }
  };

  return {
    string: (bytes, num, gen) => apply(stringMethod, bytes, num, gen),
    stream: (bytes, num, gen) => apply(streamMethod, bytes, num, gen),
  };
}
