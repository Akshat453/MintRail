/**
 * Crypto helpers, wire-compatible with M1:
 * * SecretBox — AES-256-GCM, blob = 0x01 ‖ nonce(12) ‖ ciphertext ‖ tag(16), aad = row id.
 * * Passwords — scrypt (N=2^14, r=8, p=1, 16-byte salt) as ``scrypt$N$r$p$salt_b64$hash_b64``.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BOX_VERSION = 0x01;
export const SCRYPT_N = 2 ** 14;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;

export class DecryptionError extends Error {}

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyB64: string) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(keyB64) || keyB64.length % 4 !== 0) {
      throw new Error("secrets key must be base64");
    }
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) throw new Error("secrets key must decode to exactly 32 bytes");
    this.key = key;
  }

  encrypt(plaintext: Buffer, aad: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([BOX_VERSION]), nonce, ct, cipher.getAuthTag()]);
  }

  decrypt(blob: Buffer, aad: Buffer): Buffer {
    if (blob.length < 1 + 12 + 16 || blob[0] !== BOX_VERSION) {
      throw new DecryptionError("unrecognised ciphertext format");
    }
    const nonce = blob.subarray(1, 13);
    const tag = blob.subarray(blob.length - 16);
    const ct = blob.subarray(13, blob.length - 16);
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, nonce);
      d.setAAD(aad);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } catch {
      throw new DecryptionError("ciphertext failed authentication");
    }
  }
}

export function randomToken(prefix: string, length = 40): string {
  let out = prefix;
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)];
  return out;
}

export const isBase62 = (v: string): boolean => /^[A-Za-z0-9]*$/.test(v);

export const hmacSha256 = (key: Buffer | string, message: Buffer | string): Buffer => createHmac("sha256", key).update(message).digest();

export const hmacSha256Hex = (key: Buffer | string, message: Buffer | string): string =>
  createHmac("sha256", key).update(message).digest("hex");

export const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await scrypt(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), digest.toString("base64")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, digestB64] = parts as [string, string, string, string, string, string];
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every((x) => Number.isInteger(x) && x > 0)) return false;
  const b64 = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!b64.test(saltB64) || !b64.test(digestB64)) return false;
  const expected = Buffer.from(digestB64, "base64");
  if (expected.length === 0) return false;
  try {
    const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N, r: R, p: P, maxmem: MAXMEM });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
